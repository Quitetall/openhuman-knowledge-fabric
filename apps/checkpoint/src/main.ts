/**
 * Checkpoint process entrypoint.
 *
 * A separate process precisely so the Ed25519 signing key is not reachable from the API: a
 * compromised API can then forge records, but cannot forge a checkpoint attesting that those
 * records were always there. Nothing here should ever be merged into the API deployment.
 *
 *   checkpoint --run      sign everything since the last checkpoint
 *   checkpoint --verify   recompute the whole ledger from genesis and report findings
 */

import { createPool } from '@kf/database';
import { loadSecret, readSecretFile } from '@kf/operations';
import { S3ObjectStore, type ObjectStore } from '@kf/artifacts';
import type { KeyObject } from 'node:crypto';
import { loadSigningKey, type SigningKey } from './sign.js';
import { runCheckpoint, verifyLedger } from './run.js';
import { loadSingleVerificationKey, loadVerificationKeyDirectory } from './keys.js';

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`${name} is not set`);
  return v;
}

function signingKey(): SigningKey {
  return loadSigningKey(
    process.env['CHECKPOINT_SIGNING_KEY_ID'] ?? 'checkpoint-1',
    // Permission-checked, not merely read. A signing key readable by another account on this
    // host is one that account can sign with, and a forged checkpoint is worse than none.
    readSecretFile(required('CHECKPOINT_SIGNING_KEY_PATH'), 'CHECKPOINT_SIGNING_KEY_PATH'),
  );
}

/** The object store, if one is configured. Absent means the signature lives only in the database. */
function objectStore(): ObjectStore | undefined {
  const endpoint = process.env['CHECKPOINT_S3_ENDPOINT'];
  if (endpoint === undefined || endpoint === '') return undefined;
  return new S3ObjectStore({
    endpoint,
    region: process.env['CHECKPOINT_S3_REGION'] ?? 'us-east-1',
    accessKeyId: required('CHECKPOINT_S3_ACCESS_KEY_ID'),
    secretAccessKey: required('CHECKPOINT_S3_SECRET_ACCESS_KEY'),
    bucket: process.env['CHECKPOINT_S3_BUCKET'] ?? 'kf-audit',
  });
}

/**
 * Verification keys.
 *
 * Prefers a PUBLIC key file: verifying should not need the private key, and an auditor should
 * be able to run this without being handed the ability to sign.
 */
function verificationKeys(): Map<string, KeyObject> {
  const id = process.env['CHECKPOINT_SIGNING_KEY_ID'] ?? 'checkpoint-1';
  const directoryPath = process.env['CHECKPOINT_PUBLIC_KEY_DIR'];
  const publicPath = process.env['CHECKPOINT_PUBLIC_KEY_PATH'];
  if (
    directoryPath !== undefined &&
    directoryPath !== '' &&
    publicPath !== undefined &&
    publicPath !== ''
  ) {
    throw new Error(
      'CHECKPOINT_PUBLIC_KEY_DIR and CHECKPOINT_PUBLIC_KEY_PATH are mutually exclusive',
    );
  }
  if (directoryPath !== undefined && directoryPath !== '') {
    return loadVerificationKeyDirectory(directoryPath);
  }
  if (publicPath !== undefined && publicPath !== '') {
    // Read plainly, not as a secret: a public key is meant to be readable, and refusing a
    // world-readable one would stop an auditor verifying with the key they were given.
    return loadSingleVerificationKey(id, publicPath);
  }
  return new Map([[id, signingKey().publicKey]]);
}

async function main(): Promise<number> {
  const wantsRun = process.argv.includes('--run');
  const wantsVerify = process.argv.includes('--verify');

  if (!wantsRun && !wantsVerify) {
    console.warn(
      JSON.stringify({
        service: 'openhuman-knowledge-fabric-checkpoint',
        signing_key: process.env['CHECKPOINT_SIGNING_KEY_PATH'] ? 'configured' : 'absent',
        database: process.env['DATABASE_URL'] ? 'configured' : 'absent',
        object_store: process.env['CHECKPOINT_S3_ENDPOINT'] ? 'configured' : 'absent',
        usage: 'checkpoint --run | checkpoint --verify',
      }),
    );
    return 0;
  }

  const pool = createPool({
    connectionString: loadSecret('DATABASE_URL', process.env, {
      allowInline: process.env['NODE_ENV'] !== 'production',
    }),
    maxConnections: 2,
  });
  try {
    if (wantsVerify) {
      const findings = await verifyLedger(pool, verificationKeys());
      console.warn(JSON.stringify({ action: 'verify', findings }, null, 2));
      // Non-zero on any finding. A verification that reports problems and exits 0 would be
      // recorded by a scheduler as a clean audit.
      return findings.length === 0 ? 0 : 1;
    }

    const store = objectStore();
    const result = await runCheckpoint(pool, signingKey(), store ? { store } : {});
    console.warn(
      JSON.stringify({
        action: 'checkpoint',
        status: result.status,
        events: result.eventCount,
        from_seq: result.checkpoint?.fromSeq ?? null,
        to_seq: result.checkpoint?.toSeq ?? null,
        merkle_root: result.checkpoint?.merkleRoot ?? null,
        storage_uri: result.checkpoint?.storageUri ?? null,
      }),
    );
    return 0;
  } finally {
    await pool.end();
  }
}

// Set exitCode rather than calling process.exit(). process.exit() terminates immediately and
// can truncate stderr when it is a pipe, losing the very message that explains the failure.
// Letting the event loop drain flushes the output first, then exits with the same code.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`checkpoint: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
