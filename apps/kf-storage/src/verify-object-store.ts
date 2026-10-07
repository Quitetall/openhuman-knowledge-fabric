/**
 * The in-release object-store verifier for restore drills.
 *
 *   node verify-object-store.js <request.jsonl> <proof.jsonl>
 *
 * `restore-verify.sh` writes the request — one `{"storage_uri","storage_version"}` per stored
 * artifact version, and nothing else — and checks the proof this writes against the
 * authenticated export (`scripts/lib/object-store-proof.mjs check`). This program is told which
 * objects to read and never what they should contain, so it can only pass by reading them.
 *
 * Until 2026-09-23 every host had to supply this program itself, root-owned and digest-pinned,
 * and a host that had not written one recorded every drill `partial`. The program an operator
 * supplies is still honoured (KF_OBJECT_STORE_VERIFY_PROGRAM, pinned by digest) for a
 * federation whose store this cannot speak to; this is the default for the S3-compatible store
 * the deployment already uses, and it is covered by the release manifest like any other file.
 *
 * Credentials come from `S3_SECRET_ACCESS_KEY_FILE` (owner-only), never inline and never argv.
 * Routing: S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_BUCKET_ARTIFACTS, S3_FORCE_PATH_STYLE.
 * A read-only key is enough and is what the drill should be given.
 *
 * Exit 0 when every requested object was measured; 1 when any could not be (named on stderr —
 * the proof then lacks it and the check refuses); 64 on misuse.
 */

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { S3ObjectStore, type ObjectStore } from '@kf/artifacts';
import { loadSecret } from '@kf/operations';

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

export interface RequestedObject {
  readonly storage_uri: string;
  readonly storage_version: string | null;
}

export interface Measurement extends RequestedObject {
  readonly sha256: string;
  readonly size_bytes: number;
}

export function parseRequest(text: string): readonly RequestedObject[] {
  if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) throw new Error('request exceeds 16 MiB');
  const requested: RequestedObject[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (line === '') continue;
    const entry: unknown = JSON.parse(line);
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`request line ${index + 1} is not an object`);
    }
    const { storage_uri: uri, storage_version: version } = entry as Record<string, unknown>;
    if (typeof uri !== 'string' || uri === '') {
      throw new Error(`request line ${index + 1} has no storage_uri`);
    }
    if (version !== null && typeof version !== 'string') {
      throw new Error(`request line ${index + 1} has a malformed storage_version`);
    }
    requested.push({ storage_uri: uri, storage_version: version });
  }
  return requested;
}

/**
 * Re-read each requested object from `store` and report what was measured. An object that
 * cannot be read is reported in `failures`, never guessed at: the proof simply lacks it.
 */
export async function measureRequested(
  requested: readonly RequestedObject[],
  store: Pick<ObjectStore, 'head' | 'read'>,
): Promise<{ measured: Measurement[]; failures: string[] }> {
  const measured: Measurement[] = [];
  const failures: string[] = [];
  for (const object of requested) {
    const version = object.storage_version ?? undefined;
    try {
      const head = await store.head(object.storage_uri, version);
      if (head === undefined) {
        failures.push(`${object.storage_uri}: not found`);
        continue;
      }
      // The size the store states bounds the read; the size REPORTED is what was read.
      const bytes = await store.read(object.storage_uri, version, head.sizeBytes);
      measured.push({
        storage_uri: object.storage_uri,
        storage_version: object.storage_version,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size_bytes: bytes.length,
      });
    } catch (error: unknown) {
      failures.push(
        `${object.storage_uri}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { measured, failures };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

export function storeFromEnvironment(env: NodeJS.ProcessEnv): S3ObjectStore {
  return new S3ObjectStore({
    endpoint: required(env, 'S3_ENDPOINT'),
    region: required(env, 'S3_REGION'),
    accessKeyId: required(env, 'S3_ACCESS_KEY_ID'),
    // Never inline: this runs on a host, holding a credential for the evidence vault.
    secretAccessKey: loadSecret('S3_SECRET_ACCESS_KEY', env, { allowInline: false }),
    bucket: required(env, 'S3_BUCKET_ARTIFACTS'),
    forcePathStyle: env['S3_FORCE_PATH_STYLE'] !== 'false',
  });
}

async function main(argv: readonly string[]): Promise<number> {
  const [requestPath, proofPath] = argv;
  if (requestPath === undefined || proofPath === undefined || argv.length !== 2) {
    process.stderr.write('usage: verify-object-store.js <request.jsonl> <proof.jsonl>\n');
    return 64;
  }
  const requested = parseRequest(readFileSync(requestPath, 'utf8'));
  const { measured, failures } = await measureRequested(
    requested,
    storeFromEnvironment(process.env),
  );
  const lines = measured.map((entry) => JSON.stringify(entry));
  writeFileSync(proofPath, lines.length === 0 ? '' : `${lines.join('\n')}\n`, { mode: 0o600 });
  for (const failure of failures) process.stderr.write(`object not measured: ${failure}\n`);
  process.stdout.write(`measured ${measured.length} of ${requested.length} object(s)\n`);
  return failures.length === 0 ? 0 : 1;
}

// Compared by real path. The drill runs this as /opt/kf/apps/…, and /opt/kf is a symbolic link
// to the release; Node resolves the module to the release's real path, so comparing against
// argv as given never matched on a host, and the verifier exited 0 having measured nothing.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
