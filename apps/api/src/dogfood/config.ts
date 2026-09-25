import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { devStateFile } from '@kf/operations';

export const APP_LOGIN = 'kf_api_dev';
/** The dogfood API's workstation login: kf_app and nothing else (`pnpm dogfood:logins`). */
export const DOGFOOD_API_LOGIN = 'kf_api_dogfood';
/** kf-attestor's workstation login: kf_attestor and nothing else (`pnpm dogfood:logins`). */
export const ATTESTOR_LOGIN = 'kf_attestor_dev';
/**
 * The worker's workstation login: kf_worker, and CREATE/TEMP on the database because the job
 * queue creates and migrates its own `graphile_worker` schema on every start (dogfood-vm.md
 * records the same two grants on the host). Nothing else (`pnpm dogfood:logins`).
 */
export const WORKER_LOGIN = 'kf_worker_dogfood';
/** MinIO's development secret from docker-compose.yml: public on purpose, loopback only. */
export const DEV_S3_SECRET = 'dev-only-not-a-secret';

/**
 * The directory whose presence marks a provisioned private host (deploy/systemd, private-host.md).
 *
 * The loader creates a password-bearing login granted kf_app. On a workstation that is a
 * convenience; on a host that serves people it is an unreviewed credential into the real
 * database, created by whoever ran a development command there. So its presence refuses the run,
 * whatever NODE_ENV and DATABASE_OWNER_URL say.
 */
export const PRIVATE_HOST_MARKER = '/etc/kf';

export function assertNotPrivateHost(marker: string = PRIVATE_HOST_MARKER): void {
  if (existsSync(marker)) {
    throw new Error(
      `${marker} exists, so this is a provisioned host. The dogfood loader creates a ` +
        'development database login and refuses to run anywhere but a workstation.',
    );
  }
}

/**
 * A fresh password for the development login, generated on every run.
 *
 * It used to be the fixed string `dev-only-not-a-secret`, published in this repository, for a
 * login that inherits kf_app: anybody who could reach the database could read every record the
 * application can. A per-run secret costs nothing, because nobody types it — it goes to a file.
 */
export function generateAppPassword(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Where the loader writes the development API's connection string: owner-only, outside the
 * repository, so it can never be committed. KF_DEV_DATABASE_URL_FILE overrides it.
 */
export function devDatabaseUrlFile(env: NodeJS.ProcessEnv = process.env): string {
  return devStateFile('developmentApi', env);
}

/**
 * The SCRAM-SHA-256 verifier PostgreSQL stores for `password`, computed here so the plaintext
 * never appears in SQL. `CREATE/ALTER ROLE … PASSWORD '<plaintext>'` is a DDL statement, and the
 * Compose server runs `log_statement = ddl`: the password would be written to the server log on
 * every run. PostgreSQL accepts a pre-hashed verifier in the same place and stores it as is.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16)): string {
  const iterations = 4096;
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return (
    `SCRAM-SHA-256$${String(iterations)}:${salt.toString('base64')}` +
    `$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
  );
}

/** Write a secret owner-only, replacing any previous file whole rather than editing it. */
export async function writeOwnerOnly(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const staged = `${path}.${process.pid}.tmp`;
  await writeFile(staged, `${value}\n`, { mode: 0o600 });
  // `mode` applies only at creation; chmod covers a staged file left behind by a crashed run.
  await chmod(staged, 0o600);
  await rename(staged, path);
}

export function sourceDirectory(): string {
  const flag = process.argv.indexOf('--source-dir');
  const argument = flag === -1 ? undefined : process.argv[flag + 1];
  const source = argument ?? process.env['KF_CONSTITUTION_DIR'];
  if (source === undefined || source.trim() === '') {
    throw new Error('Pass --source-dir or set KF_CONSTITUTION_DIR.');
  }
  return resolve(source);
}

export function requiredOwnerUrl(): string {
  if (process.env['NODE_ENV'] !== 'development') {
    throw new Error('Dogfood loader runs only with NODE_ENV=development.');
  }
  const value = process.env['DATABASE_OWNER_URL'];
  if (value === undefined || value.trim() === '') {
    throw new Error('DATABASE_OWNER_URL is required for local bootstrap.');
  }
  const url = new URL(value);
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('DATABASE_OWNER_URL must target local PostgreSQL.');
  }
  return value;
}

/**
 * The deploying organization's legal name, from `KF_ORGANIZATION_LEGAL_NAME`.
 *
 * KF-SAS-RQ-192: the deploying organization's identity is configuration and is not compiled into
 * the product's source. It was three string literals in `bootstrap.ts` (SAS §100.16). Required,
 * with no default: a default would be exactly the compiled-in name this replaces. Control
 * characters are refused because the value becomes a record title shown to people.
 */
export function requiredOrganizationLegalName(env: NodeJS.ProcessEnv = process.env): string {
  const value = env['KF_ORGANIZATION_LEGAL_NAME']?.trim();
  if (value === undefined || value === '') {
    throw new Error(
      'KF_ORGANIZATION_LEGAL_NAME is required: the legal name of the organization this ' +
        'deployment seeds. It is configuration, not source (KF-SAS-RQ-192); see .env.example.',
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('KF_ORGANIZATION_LEGAL_NAME contains a control character');
  }
  if (value.length > 200) {
    throw new Error('KF_ORGANIZATION_LEGAL_NAME is longer than 200 characters');
  }
  return value;
}
