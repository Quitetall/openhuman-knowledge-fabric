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

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDispatcher } from '@kf/actions';
import { withTransaction } from '@kf/database';
import { generateSigningKey } from '../../apps/checkpoint/src/sign.js';
import { runCheckpoint } from '../../apps/checkpoint/src/run.js';
import {
  createObject,
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
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** An empty database in its own cluster — what a real restore target looks like. */
async function emptyDatabase(): Promise<string> {
  const container = await new PostgreSqlContainer('postgres:18-alpine')
    .withDatabase('kf_restore')
    .withUsername('kf_owner')
    .withPassword('test-only-not-a-secret')
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
  // A signed checkpoint, so the restore has an audit ledger to be judged against.
  await runCheckpoint(h.adminPool, generateSigningKey('drill-key'));

  work = mkdtempSync(join(tmpdir(), 'kf-drill-'));
  backupDir = join(work, 'backup');
}, 300_000);

afterAll(async () => {
  await h?.stop();
  for (const c of spare) await c.stop();
  if (work !== undefined) rmSync(work, { recursive: true, force: true });
});

describe('backup', () => {
  it('produces every artefact, and its own digests', () => {
    const r = run(BACKUP, [backupDir], { DATABASE_URL: h.connectionString });
    expect(r.code, r.output).toBe(0);

    for (const file of ['dump.pgcustom', 'schema.sql', 'roles.sql', 'SHA256SUMS', 'README.md']) {
      expect(existsSync(join(backupDir, file)), `missing ${file}`).toBe(true);
    }
    expect(existsSync(join(backupDir, 'export', 'manifest.json'))).toBe(true);

    // The digests cover the canonical export too, not only the dump.
    const sums = readFileSync(join(backupDir, 'SHA256SUMS'), 'utf8');
    expect(sums).toContain('./export/manifest.json');
    expect(sums).toContain('./dump.pgcustom');
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
    // The recorded digest is the one `sha256sum -c SHA256SUMS` checks, so it covers every
    // file in the backup rather than only the dump.
    const actual = execFileSync('sha256sum', [join(backupDir, 'SHA256SUMS')], {
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
});

describe('restore drill', () => {
  it('restores into an empty database and re-exports identically', async () => {
    const target = await emptyDatabase();
    const r = run(RESTORE, [backupDir, target]);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain('restore verified');
    // Said out loud when it happens, rather than passing quietly.
    expect(r.output).toContain('checkpoint signatures were NOT verified');
  }, 300_000);

  it('records the drill against the ledger it was told to record against', async () => {
    // The third argument is the PRODUCTION database, not the restore target. A drill recorded
    // in the scratch database is discarded with it, and readiness would go on reporting that
    // no backup has ever been restored — true of the record and false of the world, which is
    // the worst of the four combinations.
    const target = await emptyDatabase();
    const r = run(RESTORE, [backupDir, target, h.connectionString]);
    expect(r.code, r.output).toBe(0);

    const drills = await withTransaction(h.adminPool, async (tx) =>
      tx.query<{ outcome: string; target_label: string }>(
        'select outcome, target_label from ops.restore_drill',
      ),
    );
    expect(drills).toHaveLength(1);
    expect(drills[0]?.outcome).toBe('verified');
    // The label, not the URL: a connection string carries a password and this table is
    // readable by every read role in the system.
    expect(drills[0]?.target_label).not.toContain('@');
  }, 300_000);

  it('says so, loudly, when nothing recorded the drill', async () => {
    // Omitting the ledger is allowed — restoring somebody else's archive is a legitimate
    // thing to do. What it must not do is look like evidence about this system's backups.
    const target = await emptyDatabase();
    const r = run(RESTORE, [backupDir, target]);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain('NOT RECORDED');
    // The consequence, not just the fact: the reader has to know what stays wrong.
    expect(r.output).toMatch(/no backup has ever been restored/);
  }, 300_000);

  it('refuses to restore over a database that already holds records', async () => {
    // The failure mode this whole system exists to prevent: an operator one typo away from
    // overwriting live records during a drill.
    const r = run(RESTORE, [backupDir, h.connectionString]);
    expect(r.code).not.toBe(0);
    expect(r.output).toContain("already has a 'core' schema");
  }, 120_000);

  it('refuses a backup whose bytes were altered', async () => {
    const damaged = join(work, 'damaged');
    execFileSync('cp', ['-r', backupDir, damaged]);
    const path = join(damaged, 'export', 'objects.json');
    writeFileSync(path, `${readFileSync(path, 'utf8')} `, 'utf8');

    const target = await emptyDatabase();
    const r = run(RESTORE, [damaged, target]);
    expect(r.code).not.toBe(0);
    // Caught by the digest check, before a single row is written.
    expect(r.output).toMatch(/FAILED|WARNING/);
  }, 300_000);

  it('verifies the audit ledger when a public key is available', async () => {
    // Without this, a restore proves the ROWS came back but nothing about whether the audit
    // log was rewritten before the backup was taken.
    const target = await emptyDatabase();
    const keyPath = join(work, 'checkpoint.pem');
    const key = generateSigningKey('drill-key');
    writeFileSync(
      keyPath,
      key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      // 0600, because the checkpoint process refuses a signing key readable beyond its owner
      // — and a test fixture written at the default 0644 would be testing a configuration no
      // deployment is allowed to have.
      { encoding: 'utf8', mode: 0o600 },
    );

    const r = run(RESTORE, [backupDir, target], {
      CHECKPOINT_PUBLIC_KEY_PATH: '',
      CHECKPOINT_SIGNING_KEY_PATH: keyPath,
      CHECKPOINT_SIGNING_KEY_ID: 'drill-key',
    });

    // The checkpoint was signed by a DIFFERENT key with the same id, so verification must
    // fail — and the script must report that failure rather than swallow it.
    expect(r.code).not.toBe(0);
    expect(r.output).toContain('bad_signature');
  }, 300_000);
});
