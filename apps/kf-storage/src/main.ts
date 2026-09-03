/**
 * Storage sweep entrypoint (ADR 0017, ADR 0020).
 *
 *   kf-storage --replicate         copy every version lacking a durable copy into S3_DURABLE_*
 *   kf-storage --verify [--older-than-days N]   re-verify locations not verified within N days
 *
 * A separate one-shot behind a timer, in the shape of the checkpoint signer: its own unit,
 * its own uid, secrets from files. It acts as the declared SERVICE ACTOR named by
 * KF_STORAGE_ACTOR / KF_STORAGE_ROLE, so every copy and every verification is a typed action
 * with an actor, a role, an audit event and a receipt. A service actor cannot log in and
 * cannot perform an institutional act; this program can therefore do exactly the two things
 * above and nothing else, whatever it is given.
 */

import { createFabricDispatcher } from '@kf/orchestrator';
import {
  S3ObjectStore,
  StoreRegistry,
  createStorageActionAtoms,
  type S3Config,
} from '@kf/artifacts';
import { createPool } from '@kf/database';
import { loadSecret } from '@kf/operations';
import { runStorageSweep } from './sweep.js';

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`${name} is not set`);
  return v;
}

function s3(prefix: 'S3' | 'S3_DURABLE', bucketVar: string): S3Config | undefined {
  const endpoint = process.env[`${prefix}_ENDPOINT`];
  if (endpoint === undefined || endpoint === '') return undefined;
  return {
    endpoint,
    region: required(`${prefix}_REGION`),
    accessKeyId: required(`${prefix}_ACCESS_KEY_ID`),
    secretAccessKey: loadSecret(`${prefix}_SECRET_ACCESS_KEY`, process.env, {
      allowInline: process.env['NODE_ENV'] !== 'production',
    }),
    bucket: required(bucketVar),
    forcePathStyle: process.env[`${prefix}_FORCE_PATH_STYLE`] !== 'false',
  };
}

function integerFlag(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} needs a non-negative integer`);
  return value;
}

async function main(): Promise<number> {
  const wantsReplicate = process.argv.includes('--replicate');
  const wantsVerify = process.argv.includes('--verify');
  if (!wantsReplicate && !wantsVerify) {
    console.warn(
      JSON.stringify({
        service: 'openhuman-knowledge-fabric-storage',
        actor: process.env['KF_STORAGE_ACTOR'] ? 'configured' : 'absent',
        working_store: process.env['S3_ENDPOINT'] ? 'configured' : 'absent',
        durable_store: process.env['S3_DURABLE_ENDPOINT'] ? 'configured' : 'absent',
        usage: 'kf-storage --replicate | kf-storage --verify [--older-than-days N]',
      }),
    );
    return 0;
  }
  const working = s3('S3', 'S3_BUCKET_ARTIFACTS');
  if (working === undefined) throw new Error('S3_ENDPOINT (the working store) is required');
  const durable = s3('S3_DURABLE', 'S3_DURABLE_BUCKET');
  if (wantsReplicate && durable === undefined) {
    throw new Error('--replicate needs S3_DURABLE_* (the store to copy into)');
  }
  const registry = new StoreRegistry({
    working: new S3ObjectStore(working),
    ...(durable === undefined ? {} : { durable: new S3ObjectStore(durable) }),
  });
  const actor = {
    personId: required('KF_STORAGE_ACTOR'),
    roleAssignmentId: required('KF_STORAGE_ROLE'),
    organizationId: required('KF_STORAGE_ORGANIZATION'),
    maxClassification: process.env['KF_STORAGE_CLASSIFICATION'] ?? 'internal',
  };
  const pool = createPool({
    connectionString: loadSecret('DATABASE_URL', process.env, {
      allowInline: process.env['NODE_ENV'] !== 'production',
    }),
    maxConnections: 2,
  });
  try {
    const execute = createFabricDispatcher(
      pool,
      undefined,
      undefined,
      undefined,
      createStorageActionAtoms(registry),
    );
    const report = await runStorageSweep(pool, execute, actor, {
      ...(wantsReplicate ? { replicateTo: 'durable' } : {}),
      ...(wantsVerify ? { verifyOlderThanDays: integerFlag('--older-than-days', 30) } : {}),
      limit: integerFlag('--limit', 500),
    });
    console.warn(
      JSON.stringify({
        action: 'storage-sweep',
        replicated: report.replicated.length,
        verified: report.verified.length,
        verification_failures: report.verified.filter((v) => !v.ok).length,
        refused: report.refused,
      }),
    );
    // A verification that found a bad copy, or a refusal, is a finding: non-zero, so the
    // timer's failure hook fires rather than recording a clean run.
    return report.refused.length === 0 && report.verified.every((v) => v.ok) ? 0 : 1;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
