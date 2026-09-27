/**
 * Where a workstation keeps what the local development commands generate: per-run database
 * credentials and the local attestor's socket. Outside the repository, so none of it can be
 * committed; files written owner-only by the command that creates them. A host uses /etc/kf and
 * /run instead and never reads these.
 *
 * One definition, because three processes must agree on it: the loader that writes the files, the
 * attestor's `dev` entry and `pnpm dev:dogfood` that read them.
 */

import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

/** The credential files, by who reads them. */
export const DEV_STATE_FILES = {
  /** `kf_api_dev`: kf_app + kf_attestor. The DEVELOPMENT API, which attests in-process. */
  developmentApi: 'dev-database-url',
  /** `kf_api_dogfood`: kf_app and nothing else. The DOGFOOD API, which kf-attestor vouches for. */
  dogfoodApi: 'dogfood-api-database-url',
  /** `kf_attestor_dev`: kf_attestor and nothing else. kf-attestor. */
  attestor: 'attestor-database-url',
  /**
   * `kf_worker_dogfood`: kf_worker, plus CREATE and TEMP on the database for the job queue's own
   * schema. The worker beside a dogfood API: without it no outbox row is delivered and the
   * search index stays empty.
   */
  worker: 'worker-database-url',
} as const;

export type DevStateFile = keyof typeof DEV_STATE_FILES;

/** An environment variable that moves one file, for a workstation that wants it elsewhere. */
export const DEV_STATE_OVERRIDES: Readonly<Record<DevStateFile, string>> = {
  developmentApi: 'KF_DEV_DATABASE_URL_FILE',
  dogfoodApi: 'KF_DOGFOOD_API_DATABASE_URL_FILE',
  attestor: 'KF_ATTESTOR_DATABASE_URL_FILE',
  worker: 'KF_WORKER_DATABASE_URL_FILE',
};

/** `$XDG_STATE_HOME/knowledge-fabric`, defaulting to `~/.local/state/knowledge-fabric`. */
export function devStateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const state = env['XDG_STATE_HOME'];
  const base = state !== undefined && state !== '' ? state : join(homedir(), '.local', 'state');
  return join(base, 'knowledge-fabric');
}

export function devStateFile(which: DevStateFile, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[DEV_STATE_OVERRIDES[which]];
  if (override !== undefined && override.trim() !== '') return resolve(override);
  return join(devStateDirectory(env), DEV_STATE_FILES[which]);
}

/**
 * The local attestor's socket: KF_ATTESTOR_SOCKET when set, else `$XDG_RUNTIME_DIR/kf-attestor.sock`
 * (a per-user 0700 directory on systemd workstations), else beside the credential files.
 */
export function devAttestorSocket(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['KF_ATTESTOR_SOCKET'];
  if (explicit !== undefined && explicit.trim() !== '') return resolve(explicit);
  const runtime = env['XDG_RUNTIME_DIR'];
  if (runtime !== undefined && runtime !== '') return join(runtime, 'kf-attestor.sock');
  return join(devStateDirectory(env), 'attestor.sock');
}
