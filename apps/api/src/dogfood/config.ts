import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const APP_LOGIN = 'kf_api_dev';
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
  const override = env['KF_DEV_DATABASE_URL_FILE'];
  if (override !== undefined && override.trim() !== '') return resolve(override);
  const state = env['XDG_STATE_HOME'];
  const base = state !== undefined && state !== '' ? state : join(homedir(), '.local', 'state');
  return join(base, 'knowledge-fabric', 'dev-database-url');
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
