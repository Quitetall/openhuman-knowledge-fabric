/**
 * The two workstation logins a dogfood-profile API needs, created without owner SQL by hand.
 *
 * Since 20260924001000 a dogfood API binds a person only on an attestation from kf-attestor, and
 * each refuses the other's privilege: the API refuses a login holding kf_attestor (it could then
 * vouch for anybody it names), kf-attestor refuses one holding kf_app or kf_worker (it could then
 * act as well as vouch). `kf_api_dev`, which `pnpm dogfood:load` creates, holds both — that is
 * what lets the DEVELOPMENT API attest in-process for header identity — so it can serve neither
 * process here. `local-development.md` used to have the owner type the two logins in psql; this
 * does it, the same way `createAppLogin` makes kf_api_dev:
 *
 *   kf_api_dogfood     kf_app, nothing else     -> DEV_STATE_FILES.dogfoodApi
 *   kf_attestor_dev    kf_attestor, nothing else -> DEV_STATE_FILES.attestor
 *   kf_worker_dogfood  kf_worker (+ CREATE, TEMP) -> DEV_STATE_FILES.worker
 *
 * The worker login is the third (2026-09-24). Without a worker no outbox row is delivered, so
 * nothing a dogfood API records is ever indexed for search; the first fixture company loaded on
 * a workstation found exactly that. Its two database grants are the ones `dogfood-vm.md` records
 * for the host: the job queue creates and migrates its own `graphile_worker` schema on every
 * start (`CREATE SCHEMA IF NOT EXISTS` checks the privilege before the existence), and uses
 * temporary tables.
 *
 * Each gets a fresh random password on every run, never printed; its connection string is written
 * owner-only (0600) to the workstation state directory, which only the user running both
 * processes can read. Any other membership a login has picked up is revoked, and it is re-stated
 * NOSUPERUSER NOBYPASSRLS, so a re-run always leaves exactly the login each process accepts.
 */

import { withTransaction, type Pool } from '@kf/database';
import { devStateFile } from '@kf/operations';
import {
  ATTESTOR_LOGIN,
  DOGFOOD_API_LOGIN,
  generateAppPassword,
  scramVerifier,
  WORKER_LOGIN,
  writeOwnerOnly,
} from './config.js';

export interface DogfoodLogins {
  readonly apiLogin: string;
  readonly attestorLogin: string;
  readonly workerLogin: string;
  /** Where the dogfood API's connection string was written (0600). */
  readonly apiUrlFile: string;
  /** Where kf-attestor's connection string was written (0600). */
  readonly attestorUrlFile: string;
  /** Where the worker's connection string was written (0600). */
  readonly workerUrlFile: string;
}

/** Create or re-key `login` so that it holds exactly `role`, and return the database name. */
async function provisionLogin(
  owner: Pool,
  login: string,
  role: 'kf_app' | 'kf_attestor' | 'kf_worker',
  password: string,
): Promise<string> {
  return withTransaction(owner, async (tx) => {
    const create = await tx.one<{ sql: string }>(
      `select case when exists (select from pg_roles where rolname = $1)
              then format('alter role %I login password %L inherit nosuperuser nobypassrls ' ||
                          'nocreaterole nocreatedb', $1::text, $2::text)
              else format('create role %I login password %L inherit nosuperuser nobypassrls ' ||
                          'nocreaterole nocreatedb', $1::text, $2::text)
              end as sql`,
      [login, scramVerifier(password)],
    );
    await tx.query(create.sql);
    // Whatever else it holds goes: a stray kf_attestor on the API's login, or kf_app on the
    // attestor's, is exactly the collapse each process refuses to start through.
    const strays = await tx.query<{ sql: string }>(
      `select format('revoke %I from %I granted by %I', g.rolname, $1::text, gr.rolname) as sql
         from pg_auth_members m
         join pg_roles g on g.oid = m.roleid
         join pg_roles u on u.oid = m.member
         join pg_roles gr on gr.oid = m.grantor
        where u.rolname = $1 and g.rolname <> $2`,
      [login, role],
    );
    for (const stray of strays) await tx.query(stray.sql);
    const grant = await tx.one<{ sql: string }>(
      `select format('grant %I to %I', $2::text, $1::text) as sql`,
      [login, role],
    );
    await tx.query(grant.sql);
    const connect = await tx.one<{ sql: string }>(
      `select format('grant connect on database %I to %I', current_database(), $1::text) as sql`,
      [login],
    );
    await tx.query(connect.sql);
    // The job queue's schema, created by the worker itself; every other login is refused it.
    const queue = await tx.one<{ sql: string }>(
      `select format(case when $2::text = 'kf_worker'
                          then 'grant create, temporary on database %I to %I'
                          else 'revoke create, temporary on database %I from %I' end,
                     current_database(), $1::text) as sql`,
      [login, role],
    );
    await tx.query(queue.sql);
    return (await tx.one<{ name: string }>('select current_database() as name')).name;
  });
}

function urlFor(ownerUrl: string, login: string, password: string, database: string): string {
  const url = new URL(ownerUrl);
  url.username = login;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Create the three logins and write their connection strings. Each file is written before the next
 * login is touched, so a run that fails part-way leaves every login it re-keyed with a file that
 * works for it.
 */
export async function createDogfoodLogins(
  owner: Pool,
  ownerUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DogfoodLogins> {
  const apiUrlFile = devStateFile('dogfoodApi', env);
  const attestorUrlFile = devStateFile('attestor', env);

  const apiPassword = generateAppPassword();
  const apiDatabase = await provisionLogin(owner, DOGFOOD_API_LOGIN, 'kf_app', apiPassword);
  await writeOwnerOnly(apiUrlFile, urlFor(ownerUrl, DOGFOOD_API_LOGIN, apiPassword, apiDatabase));

  const attestorPassword = generateAppPassword();
  const attestorDatabase = await provisionLogin(
    owner,
    ATTESTOR_LOGIN,
    'kf_attestor',
    attestorPassword,
  );
  await writeOwnerOnly(
    attestorUrlFile,
    urlFor(ownerUrl, ATTESTOR_LOGIN, attestorPassword, attestorDatabase),
  );

  const workerUrlFile = devStateFile('worker', env);
  const workerPassword = generateAppPassword();
  const workerDatabase = await provisionLogin(owner, WORKER_LOGIN, 'kf_worker', workerPassword);
  await writeOwnerOnly(
    workerUrlFile,
    urlFor(ownerUrl, WORKER_LOGIN, workerPassword, workerDatabase),
  );

  return {
    apiLogin: DOGFOOD_API_LOGIN,
    attestorLogin: ATTESTOR_LOGIN,
    workerLogin: WORKER_LOGIN,
    apiUrlFile,
    attestorUrlFile,
    workerUrlFile,
  };
}
