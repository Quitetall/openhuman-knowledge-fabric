import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from 'graphile-worker';
import { createPool, withTransaction, type Pool } from '@kf/database';
import { startHarness, type Harness } from '../../../tests/database/harness.js';
import { prepareWorkerQueue } from './queue-backup.js';

describe('backup access belongs to the private queue owner', () => {
  let h: Harness;
  let worker: Pool;
  let backup: Pool;
  const migration =
    readFileSync(
      new URL(
        '../../../database/migrations/20260925130000_the_backup_login_reaches_every_schema.sql',
        import.meta.url,
      ),
      'utf8',
    )
      .split('-- migrate:up')[1]
      ?.split('-- migrate:down')[0] ?? '';

  beforeAll(async () => {
    h = await startHarness();
    await withTransaction(h.adminPool, async (tx) => {
      await tx.query(
        "create role queue_backup_owner login password 'test-only-not-a-secret' nosuperuser nobypassrls",
      );
      await tx.query('grant create on database kf_test to queue_backup_owner');
      await tx.query(
        "create role queue_backup_reader login password 'test-only-not-a-secret' nosuperuser nobypassrls in role kf_backup",
      );
    });
    const url = new URL(h.connectionString);
    url.username = 'queue_backup_owner';
    worker = createPool({ connectionString: url.toString(), maxConnections: 2 });
    url.username = 'queue_backup_reader';
    backup = createPool({ connectionString: url.toString(), maxConnections: 1 });
    // The running host already has the real library's independently owned queue.
    await runMigrations({ pgPool: worker });
    await withTransaction(worker, (tx) =>
      tx.query(
        'select graphile_worker.add_job(\'backup-probe\',\'{"reference":"test-only"}\'::json)',
      ),
    );
  }, 240_000);

  afterAll(async () => {
    await worker?.end();
    await backup?.end();
    await h?.stop();
  });

  it('refuses migration with an explicit owner-provisioning requirement, not an attempted foreign grant', async () => {
    await expect(
      withTransaction(h.adminPool, async (tx) => {
        await tx.query('set local role kf_harness_owner');
        await tx.query(migration);
      }),
    ).rejects.toThrow('worker queue backup access must be provisioned by its owner');
  });

  it('refuses a superuser or a different schema owner', async () => {
    await expect(prepareWorkerQueue(h.adminPool)).rejects.toThrow('worker_queue_backup_refused');
    const url = new URL(h.connectionString);
    url.username = 'queue_backup_reader';
    const nonOwner = createPool({ connectionString: url.toString(), maxConnections: 1 });
    try {
      await expect(prepareWorkerQueue(nonOwner)).rejects.toThrow('worker_queue_backup_refused');
    } finally {
      await nonOwner.end();
    }
  });

  it('provisions as the actual ordinary queue owner, then lets the ordinary KF owner migrate', async () => {
    await prepareWorkerQueue(worker);
    await prepareWorkerQueue(worker);
    await withTransaction(h.adminPool, async (tx) => {
      await tx.query('set local role kf_harness_owner');
      await tx.query(migration);
    });
    const rows = await withTransaction(backup, (tx) =>
      tx.one<{ jobs: number }>('select count(*)::int as jobs from graphile_worker._private_jobs'),
    );
    expect(rows).toEqual({ jobs: 1 });
    const posture = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ owner: string; bypass: boolean; superuser: boolean; forced: number }>(`
      select pg_get_userbyid(n.nspowner) as owner, r.rolbypassrls as bypass, r.rolsuper as superuser,
        (select count(*)::int from pg_class c where c.relnamespace=n.oid and c.relforcerowsecurity) as forced
      from pg_namespace n join pg_roles r on r.oid=n.nspowner where n.nspname='graphile_worker'`),
    );
    expect(posture).toEqual({
      owner: 'queue_backup_owner',
      bypass: false,
      superuser: false,
      forced: 0,
    });
    await withTransaction(worker, (tx) =>
      tx.query("select graphile_worker.add_job('worker-still-writes','{}'::json)"),
    );
  });

  it('does not let the backup reader enqueue, alter sequence state, or inherit the queue owner', async () => {
    await expect(
      withTransaction(backup, (tx) =>
        tx.query("select graphile_worker.add_job('backup-must-not-write','{}'::json)"),
      ),
    ).rejects.toThrow(/permission denied/);
    const sequence = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ name: string }>(
        "select c.oid::regclass::text as name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='graphile_worker' and c.relkind='S' order by c.relname limit 1",
      ),
    );
    await expect(
      withTransaction(backup, (tx) => tx.query('select nextval($1::regclass)', [sequence.name])),
    ).rejects.toThrow(/permission denied/);
    const membership = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ held: boolean }>(
        "select pg_has_role('kf_backup','queue_backup_owner','member') as held",
      ),
    );
    expect(membership.held).toBe(false);
  });

  it('refuses a new definer function rather than exposing a write seam to the backup role', async () => {
    await withTransaction(worker, (tx) =>
      tx.query(
        "create function graphile_worker.backup_definer_probe() returns int language sql security definer as 'select 1'",
      ),
    );
    try {
      await expect(prepareWorkerQueue(worker)).rejects.toThrow('worker_queue_backup_refused');
    } finally {
      await withTransaction(worker, (tx) =>
        tx.query('drop function graphile_worker.backup_definer_probe()'),
      );
    }
  });

  it('refuses restrictive backup policies without deleting them', async () => {
    await withTransaction(worker, (tx) =>
      tx.query(
        'create policy backup_restrict_probe on graphile_worker._private_jobs as restrictive for select to kf_backup using (false)',
      ),
    );
    try {
      await expect(prepareWorkerQueue(worker)).rejects.toThrow('worker_queue_backup_refused');
      const policy = await withTransaction(h.adminPool, (tx) =>
        tx.one<{ present: boolean }>(
          "select exists(select from pg_policy where polname='backup_restrict_probe') as present",
        ),
      );
      expect(policy.present).toBe(true);
    } finally {
      await withTransaction(worker, (tx) =>
        tx.query('drop policy backup_restrict_probe on graphile_worker._private_jobs'),
      );
    }
  });

  it('refuses forced queue RLS instead of changing the library owner exemption', async () => {
    await withTransaction(worker, (tx) =>
      tx.query('alter table graphile_worker._private_jobs force row level security'),
    );
    try {
      await expect(prepareWorkerQueue(worker)).rejects.toThrow('worker_queue_backup_refused');
      const posture = await withTransaction(h.adminPool, (tx) =>
        tx.one<{ forced: boolean }>(
          "select relforcerowsecurity as forced from pg_class where oid='graphile_worker._private_jobs'::regclass",
        ),
      );
      expect(posture.forced).toBe(true);
    } finally {
      await withTransaction(worker, (tx) =>
        tx.query('alter table graphile_worker._private_jobs no force row level security'),
      );
    }
  });

  it('refuses a conflicting named policy without replacing it', async () => {
    await withTransaction(worker, (tx) =>
      tx.query('alter policy kf_backup_read on graphile_worker._private_jobs using (false)'),
    );
    try {
      await expect(prepareWorkerQueue(worker)).rejects.toThrow('worker_queue_backup_refused');
      const policy = await withTransaction(h.adminPool, (tx) =>
        tx.one<{ predicate: string }>(
          "select pg_get_expr(polqual,polrelid) as predicate from pg_policy where polrelid='graphile_worker._private_jobs'::regclass and polname='kf_backup_read'",
        ),
      );
      expect(policy.predicate).toBe('false');
    } finally {
      await withTransaction(worker, (tx) =>
        tx.query('alter policy kf_backup_read on graphile_worker._private_jobs using (true)'),
      );
    }
  });

  it('refuses an existing backup write grant without silently revoking it', async () => {
    await withTransaction(worker, (tx) =>
      tx.query('grant insert on graphile_worker._private_jobs to kf_backup'),
    );
    try {
      await expect(prepareWorkerQueue(worker)).rejects.toThrow('worker_queue_backup_refused');
      const grant = await withTransaction(h.adminPool, (tx) =>
        tx.one<{ held: boolean }>(
          "select has_table_privilege('kf_backup','graphile_worker._private_jobs','insert') as held",
        ),
      );
      expect(grant.held).toBe(true);
    } finally {
      await withTransaction(worker, (tx) =>
        tx.query('revoke insert on graphile_worker._private_jobs from kf_backup'),
      );
    }
  });

  it.each([
    ['update (payload)', 'update'],
    ['maintain', 'maintain'],
  ])('refuses an existing %s grant, including column-level writes', async (privilege, revoke) => {
    await withTransaction(worker, (tx) =>
      tx.query(`grant ${privilege} on graphile_worker._private_jobs to kf_backup`),
    );
    try {
      await expect(prepareWorkerQueue(worker)).rejects.toThrow('worker_queue_backup_refused');
    } finally {
      await withTransaction(worker, (tx) =>
        tx.query(`revoke ${revoke} on graphile_worker._private_jobs from kf_backup`),
      );
      if (privilege.startsWith('update')) {
        await withTransaction(worker, (tx) =>
          tx.query('revoke update (payload) on graphile_worker._private_jobs from kf_backup'),
        );
      }
    }
  });
});
