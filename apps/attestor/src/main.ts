/**
 * kf-attestor process entrypoint.
 *
 * A separate process for the same reason the checkpoint signer is one: the ability it holds —
 * telling the database that a person is present — must not be reachable from the API. The API
 * sends it bearer tokens over a Unix socket that only the two of them can open; the attestor
 * verifies each token as the API used to, and asks the database for an attestation under a login
 * the API does not have (`kf_attestor`). A compromised API can then act only for people who are
 * currently sending it requests, not for anybody it names. Nothing here should ever be merged
 * into the API deployment.
 */

import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { LocalAttestor, TokenVerifier } from '@kf/authorization';
import {
  createPool,
  loginPrivilegeProblems,
  readLoginPrivilege,
  withTransaction,
} from '@kf/database';
import { loadAttestorConfig } from './config.js';
import { createAttestorServer } from './server.js';

function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`);
}

async function main(): Promise<void> {
  const config = loadAttestorConfig();
  const pool = createPool({ connectionString: config.databaseUrl, maxConnections: 4 });

  // Refuse a login that is anything but the attestor's. Over-privileged, and row-level security
  // stops binding it; able to bind a principal, and it could both vouch and act, which is the
  // separation this process exists to keep.
  const { privilege, binds } = await withTransaction(pool, async (tx) => ({
    privilege: await readLoginPrivilege(tx),
    binds: (
      await tx.one<{ binds: boolean }>(
        `select exists (select from pg_roles r
                         where r.rolname in ('kf_app', 'kf_worker')
                           and pg_has_role(current_user, r.oid, 'MEMBER')) as binds`,
      )
    ).binds,
  }));
  const problems = loginPrivilegeProblems(privilege, { mayAttest: true });
  if (!privilege.attests) problems.push('is not a member of kf_attestor, so it cannot attest');
  if (binds) problems.push('is a member of kf_app or kf_worker, so it could act as well as attest');
  if (problems.length > 0) {
    await pool.end();
    throw new Error(
      `refusing to attest: database login ${JSON.stringify(privilege.login)} ${problems.join(', ')}. ` +
        'DATABASE_URL must name a login that inherits kf_attestor and nothing more.',
    );
  }

  const attestor = new LocalAttestor(
    pool,
    new TokenVerifier(config.identity, undefined, (reason) => log('token_rejected', { reason })),
  );
  const server = createAttestorServer(attestor, log);

  // A socket left by a previous run refuses the bind with EADDRINUSE. Remove it only if it IS
  // a socket: anything else at that path is somebody else's file.
  try {
    if (lstatSync(config.socketPath).isSocket()) unlinkSync(config.socketPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.socketPath, () => resolve());
  });
  // Owner and group only. The unit's Group= is the group kf-api shares; nobody else may connect.
  chmodSync(config.socketPath, 0o660);
  log('listening', { socket: config.socketPath });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      log('shutting_down', { signal });
      server.close(() => {
        void pool.end().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      });
    });
  }
}

main().catch((err: unknown) => {
  console.error('fatal: attestor failed to start');
  console.error(err);
  process.exit(1);
});
