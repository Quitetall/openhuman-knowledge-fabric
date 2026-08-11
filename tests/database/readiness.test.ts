/**
 * Operational readiness.
 *
 * The failure mode this suite exists for is a dashboard that turns green when monitoring
 * breaks. So the tests are mostly about the checks NOTICING things: a dropped guard, a broken
 * chain, an unsigned log, a partial index. A readiness check nobody has seen fail is a
 * readiness check nobody knows works.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDispatcher } from '@kf/actions';
import { withTransaction } from '@kf/database';
import { assessReadiness, formatReadiness } from '@kf/operations';
import { generateSigningKey } from '../../apps/checkpoint/src/sign.js';
import { runCheckpoint } from '../../apps/checkpoint/src/run.js';
import { drainOutbox } from '../../apps/worker/src/outbox.js';
import {
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

let h: Harness;
let f: Fixtures;

const check = (report: Awaited<ReturnType<typeof assessReadiness>>, id: string) =>
  report.checks.find((c) => c.id === id);

async function doWork(title: string, key: string): Promise<string> {
  const id = await createObject(h.adminPool, f, {
    type: 'decision_record',
    domain: 'engineering',
    state: 'proposed',
    title,
    createdBy: f.performerId,
  });
  const execute = createDispatcher(h.pool);
  await execute({
    actionType: 'accept_decision',
    actorId: f.reviewerId,
    actingRoleId: f.reviewerRoleId,
    targetIds: [id],
    idempotencyKey: key,
    organizationId: f.organizationId,
    maxClassification: 'restricted',
  });
  return id;
}

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

describe('a system that is genuinely in order', () => {
  it('reports ready once everything has actually been done', async () => {
    await doWork('A decision to be found and signed', 'readiness-0001');

    // Deliberately checked BEFORE the work is delivered and signed, so the test proves the
    // checks are looking rather than defaulting to ok.
    const before = await assessReadiness(h.adminPool);
    expect(before.ready).toBe(false);
    expect(check(before, 'checkpoint_coverage')?.status).toBe('failed');
    expect(check(before, 'search_index')?.status).toBe('degraded');

    await drainOutbox(h.adminPool);
    await runCheckpoint(h.adminPool, generateSigningKey('readiness-key'));

    // Draining alone is not enough, and the check was right to say so: the bootstrap records
    // — the first organization, the first people, their role assignments — are created
    // BEFORE any action can exist to create them, so no outbox row ever indexed them. A
    // rebuild is what covers them, which is why deployment runs one.
    const drainedOnly = await assessReadiness(h.adminPool);
    expect(check(drainedOnly, 'search_index')?.status).toBe('degraded');
    await withTransaction(h.adminPool, async (tx) => tx.query('select search.rebuild()'));

    const after = await assessReadiness(h.adminPool);
    expect(after.ready, formatReadiness(after)).toBe(true);
    expect(after.checks.every((c) => c.status === 'ok')).toBe(true);
  });

  it('explains what each check means, not just its colour', async () => {
    const report = await assessReadiness(h.adminPool);
    for (const c of report.checks) {
      // A red light with no consequence attached gets acknowledged and then ignored.
      expect(c.detail.length).toBeGreaterThanOrEqual(20);
    }
    expect(formatReadiness(report)).toContain('READY');
  });
});

describe('noticing things', () => {
  it('notices a dropped write guard', async () => {
    // Dropping a trigger is DDL and shows in the server log — but only if somebody reads it.
    await withTransaction(h.adminPool, async (tx) =>
      tx.query('drop trigger object_guard_3_row_version on core.object'),
    );
    try {
      const report = await assessReadiness(h.adminPool);
      expect(report.ready).toBe(false);
      const guards = check(report, 'write_guards');
      expect(guards?.status).toBe('failed');
      expect(guards?.detail).toMatch(/without an action/);
    } finally {
      await withTransaction(h.adminPool, async (tx) =>
        tx.query(`create trigger object_guard_3_row_version
                    before update on core.object
                    for each row execute function core.enforce_row_version()`),
      );
    }
    expect(check(await assessReadiness(h.adminPool), 'write_guards')?.status).toBe('ok');
  });

  it('notices a broken audit chain', async () => {
    const snapshot = await withTransaction(h.adminPool, async (tx) =>
      tx.query('select * from core.audit_event order by seq'),
    );
    await withTransaction(h.adminPool, async (tx) => {
      await tx.query("set local session_replication_role = 'replica'");
      await tx.query(
        `update core.audit_event set prev_digest = $1 where seq = (select min(seq) from core.audit_event)`,
        ['f'.repeat(64)],
      );
    });
    try {
      const report = await assessReadiness(h.adminPool);
      const chain = check(report, 'audit_chain');
      expect(chain?.status).toBe('failed');
      // The only check here whose failure means the RECORD is untrustworthy, rather than
      // some derived thing being stale. The wording says so.
      expect(chain?.detail).toMatch(/altered|bypassed/);
    } finally {
      await withTransaction(h.adminPool, async (tx) => {
        await tx.query("set local session_replication_role = 'replica'");
        await tx.query('delete from core.audit_event');
        for (const row of snapshot) {
          const cols = Object.keys(row);
          await tx.query(
            `insert into core.audit_event (${cols.join(', ')})
             values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
            cols.map((c) => {
              const v = (row as Record<string, unknown>)[c];
              return v !== null && typeof v === 'object' && !(v instanceof Date)
                ? JSON.stringify(v)
                : v;
            }),
          );
        }
      });
    }
    expect(check(await assessReadiness(h.adminPool), 'audit_chain')?.status).toBe('ok');
  });

  it('notices records that cannot be found', async () => {
    await withTransaction(h.adminPool, async (tx) =>
      tx.query(
        'delete from search.document where object_id in (select id from core.object limit 2)',
      ),
    );
    const report = await assessReadiness(h.adminPool);
    const index = check(report, 'search_index');
    expect(index?.status).toBe('degraded');
    expect(index?.detail).toMatch(/cannot be found/);
    // Degraded, not failed: no record is wrong, they are merely unfindable — and the remedy
    // is named in the detail.
    expect(index?.detail).toMatch(/search\.rebuild/);

    await withTransaction(h.adminPool, async (tx) => tx.query('select search.rebuild()'));
    expect(check(await assessReadiness(h.adminPool), 'search_index')?.status).toBe('ok');
  });

  it('treats a lagging outbox as degraded, not as an outage', async () => {
    await doWork('A decision whose delivery lags', 'readiness-0002');
    const report = await assessReadiness(h.adminPool, { outboxPending: 0, outboxAgeSeconds: 0 });
    const outbox = check(report, 'outbox_delivery');
    expect(outbox?.status).toBe('degraded');
    // Nothing the outbox delivers is authoritative, so being behind costs freshness rather
    // than correctness. Saying so is what stops it being treated as an incident.
    expect(outbox?.detail).toMatch(/no record is wrong/);

    await drainOutbox(h.adminPool);
    await runCheckpoint(h.adminPool, generateSigningKey('readiness-key-2'));
  });
});

describe('failing closed', () => {
  it('reports unknown — and NOT ready — when a check cannot run', async () => {
    // The failure mode that matters: monitoring breaks and the dashboard turns green because
    // nothing came back to contradict it.
    await withTransaction(h.adminPool, async (tx) =>
      tx.query('alter table search.document rename to document_moved'),
    );
    try {
      const report = await assessReadiness(h.adminPool);
      expect(report.ready).toBe(false);
      expect(report.checks.some((c) => c.status === 'unknown')).toBe(true);
    } finally {
      await withTransaction(h.adminPool, async (tx) =>
        tx.query('alter table search.document_moved rename to document'),
      );
    }
  });

  it('is not ready on degraded either', async () => {
    // "Ready" is a claim about being in the intended state. A working system with a known
    // shortfall is worth distinguishing in the detail, not in the verdict.
    const report = await assessReadiness(h.adminPool, { outboxAgeSeconds: -1 });
    if (report.checks.some((c) => c.status === 'degraded')) {
      expect(report.ready).toBe(false);
    }
  });
});
