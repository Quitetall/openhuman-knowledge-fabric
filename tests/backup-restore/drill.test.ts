/**
 * The restore drill.
 *
 * A backup is not valid until it has been restored, so this runs the SHIPPED SCRIPTS against
 * real PostgreSQL — not a reimplementation of them in TypeScript. A test that re-derives what
 * `backup.sh` does would pass while `backup.sh` was broken, which is the only outcome that
 * actually matters at 3am.
 *
 * Slow by nature: two containers, a real `pg_dump`, a real `pg_restore`.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDispatcher } from '@kf/actions';
import { createPool, withTransaction } from '@kf/database';
import { generateSigningKey } from '../../apps/checkpoint/src/sign.js';
import { runCheckpoint } from '../../apps/checkpoint/src/run.js';
import {
  createObject,
  POSTGRES_INITDB_ARGS,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from '../database/harness.js';

const ROOT = join(import.meta.dirname, '..', '..');
const BACKUP = join(ROOT, 'scripts', 'backup.sh');
const RESTORE = join(ROOT, 'scripts', 'restore-verify.sh');

let h: Harness;
let f: Fixtures;
let work: string;
let backupDir: string;
let preservationPrivateKeyPath: string;
let preservationTrustStore: string;
let checkpointPublicKeyDir: string;
let objectStoreVerifierPath: string;
let snapshotSentinelId: string;
let urlFileSequence = 0;
const spare: StartedPostgreSqlContainer[] = [];

interface RunResult {
  code: number;
  output: string;
}

/**
 * spawnSync rather than execFileSync: both streams matter here. These scripts report skipped
 * checks and refusals on stderr, and a helper that kept only stdout would let a run that
 * silently skipped the audit verification read as a clean pass.
 */
function run(script: string, args: string[], env: Record<string, string> = {}): RunResult {
  const r = spawnSync('bash', [script, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      PRESERVATION_SIGNING_KEY_PATH: preservationPrivateKeyPath,
      PRESERVATION_SIGNING_KEY_ID: 'backup-preservation-key',
      PRESERVATION_TRUST_STORE_DIR: preservationTrustStore,
      CHECKPOINT_PUBLIC_KEY_DIR: checkpointPublicKeyDir,
      KF_OBJECT_STORE_VERIFY_PROGRAM: objectStoreVerifierPath,
      KF_OBJECT_STORE_PROOF_REF: 'test://object-store/restore-proof',
      ...env,
    },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function scriptEnvironment(env: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PRESERVATION_SIGNING_KEY_PATH: preservationPrivateKeyPath,
    PRESERVATION_SIGNING_KEY_ID: 'backup-preservation-key',
    PRESERVATION_TRUST_STORE_DIR: preservationTrustStore,
    CHECKPOINT_PUBLIC_KEY_DIR: checkpointPublicKeyDir,
    KF_OBJECT_STORE_VERIFY_PROGRAM: objectStoreVerifierPath,
    KF_OBJECT_STORE_PROOF_REF: 'test://object-store/restore-proof',
    ...env,
  };
}

function databaseUrlFile(label: string, connectionString: string): string {
  const path = join(work, `${label}-${urlFileSequence++}.url`);
  writeFileSync(path, `${connectionString}\n`, { encoding: 'utf8', mode: 0o600 });
  return path;
}

function runRestore(
  backup: string,
  targetConnectionString: string,
  ledgerConnectionString?: string,
  env: Record<string, string> = {},
): RunResult {
  const args = [backup, databaseUrlFile('target', targetConnectionString)];
  if (ledgerConnectionString !== undefined) {
    args.push(databaseUrlFile('ledger', ledgerConnectionString));
  }
  return run(RESTORE, args, env);
}

/** Insert a committed row only after backup coordinator has frozen shared snapshot. */
async function backupWithSnapshotSentinel(): Promise<RunResult> {
  const barrier = join(work, 'snapshot-barrier.fifo');
  execFileSync('mkfifo', [barrier]);
  const ready = readFile(barrier, 'utf8');
  const result = new Promise<RunResult>((resolve, reject) => {
    const child = spawn('bash', [BACKUP, backupDir], {
      cwd: ROOT,
      env: scriptEnvironment({
        DATABASE_URL: h.connectionString,
        NODE_ENV: 'test',
        KF_BACKUP_TEST_SNAPSHOT_BARRIER: barrier,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';

    const capture = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code: code ?? 1, output });
    });
  });

  const barrierMessage = await Promise.race([
    ready,
    result.then((early) => {
      throw new Error(`backup exited before snapshot barrier (${early.code}):\n${early.output}`);
    }),
  ]);
  if (barrierMessage !== 'snapshot-ready\n') {
    throw new Error(`backup emitted invalid snapshot barrier message: ${barrierMessage}`);
  }
  try {
    snapshotSentinelId = await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'proposed',
      title: 'Post-snapshot sentinel',
      createdBy: f.performerId,
    });
    await writeFile(barrier, 'continue\n');
  } catch (error: unknown) {
    await writeFile(barrier, 'abort\n').catch(() => undefined);
    throw error;
  }
  return result;
}

function recomputeCompatibilityDigest(directory: string, path: string): void {
  const absolute = join(directory, path);
  const digest = execFileSync('sha256sum', [absolute], { encoding: 'utf8' }).split(' ')[0]!;
  const sumsPath = join(directory, 'SHA256SUMS');
  const suffix = `./${path}`;
  const rewritten = readFileSync(sumsPath, 'utf8')
    .split('\n')
    .map((line) => (line.endsWith(suffix) ? `${digest}  ${suffix}` : line))
    .join('\n');
  writeFileSync(sumsPath, rewritten);
}

/** An empty database in its own cluster — what a real restore target looks like. */
async function emptyDatabase(): Promise<string> {
  const container = await new PostgreSqlContainer('postgres:18-alpine')
    .withDatabase('kf_restore')
    .withUsername('kf_owner')
    .withPassword('test-only-not-a-secret')
    .withEnvironment({ POSTGRES_INITDB_ARGS })
    .start();
  spare.push(container);
  return container.getConnectionUri();
}

beforeAll(async () => {
  // The scripts run the built CLIs, so the build has to exist. Incremental, so this is cheap
  // when it is already current.
  execFileSync('pnpm', ['--filter', '@kf/export', '--filter', '@kf/checkpoint', 'build'], {
    cwd: ROOT,
    stdio: 'pipe',
  });

  h = await startHarness();
  f = await seedFixtures(h.adminPool);

  const execute = createDispatcher(h.pool);
  for (let i = 0; i < 3; i++) {
    const id = await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'proposed',
      title: `Backup drill decision ${i}`,
      createdBy: f.performerId,
    });
    await execute({
      actionType: 'accept_decision',
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      targetIds: [id],
      idempotencyKey: `drill-${i}-aaaaaaaaaa`,
      organizationId: f.organizationId,
      maxClassification: 'restricted',
    });
  }
  work = mkdtempSync(join(tmpdir(), 'kf-drill-'));
  backupDir = join(work, 'backup');
  preservationPrivateKeyPath = join(work, 'preservation-private.pem');
  preservationTrustStore = join(work, 'preservation-trust.d');
  checkpointPublicKeyDir = join(work, 'checkpoint-public-keys');
  objectStoreVerifierPath = join(work, 'verify-object-store');
  mkdirSync(preservationTrustStore);
  mkdirSync(checkpointPublicKeyDir);
  writeFileSync(
    objectStoreVerifierPath,
    '#!/bin/sh\nset -eu\ntest -f "$1/artifact-versions.json"\nsha256sum "$1/artifact-versions.json" > "$2"\n',
    { encoding: 'utf8', mode: 0o700 },
  );

  const preservationKey = generateSigningKey('backup-preservation-key');
  writeFileSync(
    preservationPrivateKeyPath,
    preservationKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    { encoding: 'utf8', mode: 0o600 },
  );
  writeFileSync(
    join(preservationTrustStore, 'backup-preservation-key.pub'),
    preservationKey.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  );

  // A signed checkpoint and its public historical key, so the backup carries everything a
  // fresh host needs to authenticate the ledger without copying a checkpoint private key.
  const checkpointKey = generateSigningKey('drill-key');
  await runCheckpoint(h.adminPool, checkpointKey);
  writeFileSync(
    join(checkpointPublicKeyDir, 'drill-key.pub'),
    checkpointKey.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  );
}, 300_000);

afterAll(async () => {
  await h?.stop();
  for (const c of spare) await c.stop();
  if (work !== undefined) rmSync(work, { recursive: true, force: true });
});

describe('backup', () => {
  it('produces one authenticated bundle from one shared snapshot', async () => {
    const r = await backupWithSnapshotSentinel();
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain('shared snapshot ready');

    for (const file of [
      'dump.pgcustom',
      'schema.sql',
      'roles.sql',
      'SHA256SUMS',
      'README.md',
      'backup.manifest.json',
      'backup.manifest.signature.json',
    ]) {
      expect(existsSync(join(backupDir, file)), `missing ${file}`).toBe(true);
    }
    expect(existsSync(join(backupDir, 'export', 'manifest.json'))).toBe(true);
    expect(existsSync(join(backupDir, 'export', 'manifest.signature.json'))).toBe(true);
    expect(existsSync(join(backupDir, 'export', 'trust', 'checkpoint', 'drill-key.pub'))).toBe(
      true,
    );

    // The digests cover the canonical export too, not only the dump.
    const sums = readFileSync(join(backupDir, 'SHA256SUMS'), 'utf8');
    expect(sums).toContain('./export/manifest.json');
    expect(sums).toContain('./export/manifest.signature.json');
    expect(sums).toContain('./export/trust/checkpoint/drill-key.pub');
    expect(sums).toContain('./dump.pgcustom');

    const rootManifest = JSON.parse(
      readFileSync(join(backupDir, 'backup.manifest.json'), 'utf8'),
    ) as { database_snapshot_sha256: string; files: readonly { path: string }[] };
    const innerManifest = JSON.parse(
      readFileSync(join(backupDir, 'export', 'manifest.json'), 'utf8'),
    ) as { database_snapshot_sha256: string };
    expect(rootManifest.database_snapshot_sha256).toBe(innerManifest.database_snapshot_sha256);
    expect(rootManifest.files.map((entry) => entry.path)).toContain('SHA256SUMS');
    expect(rootManifest.files.map((entry) => entry.path)).toContain('roles.sql');
    expect(rootManifest.files.map((entry) => entry.path)).toContain('export/manifest.json');

    const objects = JSON.parse(readFileSync(join(backupDir, 'export', 'objects.json'), 'utf8')) as
      readonly { id: string }[] | undefined;
    expect(snapshotSentinelId).toBeTruthy();
    expect(objects?.some((object) => object.id === snapshotSentinelId)).toBe(false);
  }, 180_000);

  it('records itself in the ledger readiness reads', async () => {
    // The scripts and the readiness check have to agree, and the only way to know they do is
    // to run the real script and then read what the real check reads. A test that inserted
    // the row itself would pass while backup.sh recorded nothing — and the visible symptom of
    // that bug is a readiness check reporting no backup has ever been taken, forever.
    const rows = await withTransaction(h.adminPool, async (tx) =>
      tx.query<{ location: string; kind: string; byte_size: string; manifest_digest: string }>(
        'select location, kind, byte_size::text, manifest_digest from ops.backup_run',
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.location).toBe(backupDir);
    expect(rows[0]?.kind).toBe('logical');
    expect(Number(rows[0]?.byte_size)).toBeGreaterThan(0);
    // Ledger names signed root manifest, which authenticates SHA256SUMS and every restore input.
    const actual = execFileSync('sha256sum', [join(backupDir, 'backup.manifest.json')], {
      encoding: 'utf8',
    }).split(' ')[0];
    expect(rows[0]?.manifest_digest).toBe(actual);
  }, 30_000);

  it('the digest file actually verifies', () => {
    const check = execFileSync('sha256sum', ['-c', 'SHA256SUMS', '--quiet'], {
      cwd: backupDir,
      encoding: 'utf8',
    });
    expect(check).toBe('');
  });

  it('refuses to sign a backup with a key absent from the external trust store', () => {
    const candidate = join(work, 'untrusted-outer-signer');
    execFileSync('cp', ['-r', backupDir, candidate]);
    rmSync(join(candidate, 'backup.manifest.json'));
    rmSync(join(candidate, 'backup.manifest.signature.json'));

    const rogueKey = generateSigningKey('rogue-preservation-key');
    const roguePrivateKeyPath = join(work, 'rogue-preservation-private.pem');
    writeFileSync(
      roguePrivateKeyPath,
      rogueKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      { encoding: 'utf8', mode: 0o600 },
    );
    const result = spawnSync(
      process.execPath,
      [
        join(ROOT, 'packages', 'export', 'dist', 'cli.js'),
        'sign-backup',
        candidate,
        '--signing-key',
        roguePrivateKeyPath,
        '--key-id',
        'rogue-preservation-key',
        '--trust-store',
        preservationTrustStore,
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/absent or mismatched in trust store/i);
    expect(existsSync(join(candidate, 'backup.manifest.json'))).toBe(false);
  });
});

describe('restore drill', () => {
  it('restores into an empty database and re-exports identically', async () => {
    const target = await emptyDatabase();
    const r = runRestore(backupDir, target);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain('restore fully verified');
    expect(r.output).not.toContain('checkpoint signatures were NOT verified');

    const targetPool = createPool({ connectionString: target });
    try {
      const sentinel = await withTransaction(targetPool, (tx) =>
        tx.query('select id from core.object where id = $1', [snapshotSentinelId]),
      );
      expect(sentinel).toEqual([]);
    } finally {
      await targetPool.end();
    }
  }, 300_000);

  it('records the drill against the ledger it was told to record against', async () => {
    // The third argument is the PRODUCTION database, not the restore target. A drill recorded
    // in the scratch database is discarded with it, and readiness would go on reporting that
    // no backup has ever been restored — true of the record and false of the world, which is
    // the worst of the four combinations.
    const target = await emptyDatabase();
    const r = runRestore(backupDir, target, h.connectionString);
    expect(r.code, r.output).toBe(0);

    const drills = await withTransaction(h.adminPool, async (tx) =>
      tx.query<{
        outcome: string;
        target_label: string;
        database_verified: boolean;
        checkpoint_verified: boolean;
        object_store_verified: boolean;
      }>(
        `select outcome, target_label, database_verified, checkpoint_verified,
                object_store_verified
           from ops.restore_drill`,
      ),
    );
    expect(drills).toHaveLength(1);
    expect(drills[0]?.outcome).toBe('verified');
    expect(drills[0]).toMatchObject({
      database_verified: true,
      checkpoint_verified: true,
      object_store_verified: true,
    });
    // The label, not the URL: a connection string carries a password and this table is
    // readable by every read role in the system.
    expect(drills[0]?.target_label).not.toContain('@');
  }, 300_000);

  it('records and exits nonzero for a database-only partial restore', async () => {
    const target = await emptyDatabase();
    const r = runRestore(backupDir, target, h.connectionString, {
      KF_OBJECT_STORE_VERIFY_PROGRAM: '',
      KF_OBJECT_STORE_PROOF_REF: '',
    });
    expect(r.code).not.toBe(0);
    expect(r.output).toContain('RESTORE PARTIAL');
    expect(r.output).toContain('object_store=false');

    const latest = await withTransaction(h.adminPool, (tx) =>
      tx.one<{
        outcome: string;
        database_verified: boolean;
        checkpoint_verified: boolean;
        object_store_verified: boolean;
      }>(
        `select outcome, database_verified, checkpoint_verified, object_store_verified
           from ops.restore_drill order by verified_at desc, id desc limit 1`,
      ),
    );
    expect(latest).toEqual({
      outcome: 'partial',
      database_verified: true,
      checkpoint_verified: true,
      object_store_verified: false,
    });
  }, 300_000);

  it('says so, loudly, when nothing recorded the drill', async () => {
    // Omitting the ledger is allowed — restoring somebody else's archive is a legitimate
    // thing to do. What it must not do is look like evidence about this system's backups.
    const target = await emptyDatabase();
    const r = runRestore(backupDir, target);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain('NOT RECORDED');
    // The consequence, not just the fact: the reader has to know what stays wrong.
    expect(r.output).toMatch(/no backup has ever been restored/);
  }, 300_000);

  it('refuses to restore over a database that already holds records', async () => {
    // The failure mode this whole system exists to prevent: an operator one typo away from
    // overwriting live records during a drill.
    const r = runRestore(backupDir, h.connectionString);
    expect(r.code).not.toBe(0);
    expect(r.output).toContain("already has a 'core' schema");
  }, 120_000);

  it('refuses a backup whose bytes were altered', async () => {
    const damaged = join(work, 'damaged');
    execFileSync('cp', ['-r', backupDir, damaged]);
    const path = join(damaged, 'export', 'objects.json');
    writeFileSync(path, `${readFileSync(path, 'utf8')} `, 'utf8');

    const target = await emptyDatabase();
    const r = runRestore(damaged, target);
    expect(r.code).not.toBe(0);
    // Caught by the digest check, before a single row is written.
    expect(r.output).toMatch(/digest mismatch|size mismatch/i);
  }, 300_000);

  it('rejects recomputed dump sums before pg_restore writes anything', async () => {
    const damaged = join(work, 'repacked-dump');
    execFileSync('cp', ['-r', backupDir, damaged]);
    writeFileSync(join(damaged, 'dump.pgcustom'), Buffer.from('attacker replacement dump'));
    recomputeCompatibilityDigest(damaged, 'dump.pgcustom');

    const target = await emptyDatabase();
    const r = runRestore(damaged, target);
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/digest mismatch|size mismatch/i);
    const targetPool = createPool({ connectionString: target });
    try {
      const schemas = await withTransaction(targetPool, (tx) =>
        tx.query("select schema_name from information_schema.schemata where schema_name = 'core'"),
      );
      expect(schemas).toEqual([]);
    } finally {
      await targetPool.end();
    }
  }, 300_000);

  it('rejects recomputed roles sums before executing roles.sql', async () => {
    const damaged = join(work, 'repacked-roles');
    execFileSync('cp', ['-r', backupDir, damaged]);
    writeFileSync(join(damaged, 'roles.sql'), 'create role kf_outer_manifest_attack;\n');
    recomputeCompatibilityDigest(damaged, 'roles.sql');

    const target = await emptyDatabase();
    const r = runRestore(damaged, target);
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/digest mismatch|size mismatch/i);
    const targetPool = createPool({ connectionString: target });
    try {
      const roles = await withTransaction(targetPool, (tx) =>
        tx.query("select rolname from pg_roles where rolname = 'kf_outer_manifest_attack'"),
      );
      expect(roles).toEqual([]);
    } finally {
      await targetPool.end();
    }
  }, 300_000);

  it('rejects a repacked historical checkpoint key even after outer digests are recomputed', async () => {
    const target = await emptyDatabase();
    const damaged = join(work, 'repacked-checkpoint-key');
    execFileSync('cp', ['-r', backupDir, damaged]);
    const replacement = generateSigningKey('drill-key');
    const archivedKey = join(damaged, 'export', 'trust', 'checkpoint', 'drill-key.pub');
    writeFileSync(
      archivedKey,
      replacement.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    );
    const replacementDigest = execFileSync('sha256sum', [archivedKey], { encoding: 'utf8' }).split(
      ' ',
    )[0]!;
    const sumsPath = join(damaged, 'SHA256SUMS');
    const sums = readFileSync(sumsPath, 'utf8')
      .split('\n')
      .map((line) =>
        line.endsWith('./export/trust/checkpoint/drill-key.pub')
          ? `${replacementDigest}  ./export/trust/checkpoint/drill-key.pub`
          : line,
      )
      .join('\n');
    writeFileSync(sumsPath, sums);

    const r = runRestore(damaged, target);
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/digest mismatch|size mismatch/i);
  }, 300_000);
});
