/**
 * Outbox delivery.
 *
 * The claim is narrow: delivery may be LATE, and may not be LOSSY. So the tests are about
 * what happens when things go wrong — a handler that throws, a topic nobody handles, a
 * redelivery — rather than about the happy path, which is one line.
 *
 * The last test is the one that makes the rest safe: everything this worker writes is
 * derived, so losing the entire outbox costs nothing that `search.rebuild()` cannot restore.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDispatcher } from '@kf/actions';
import { withTransaction } from '@kf/database';
import { search } from '@kf/search';
import { drainOutbox, outboxBacklog, type OutboxHandler } from '../../apps/worker/src/outbox.js';
import {
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from '../database/harness.js';

let h: Harness;
let f: Fixtures;
let execute: ReturnType<typeof createDispatcher>;

const scope = () => ({ organizationId: f.organizationId, maxClassification: 'restricted' });

async function acceptSomething(title: string, key: string): Promise<string> {
  const id = await createObject(h.adminPool, f, {
    type: 'decision_record',
    domain: 'engineering',
    state: 'proposed',
    title,
    createdBy: f.performerId,
  });
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
  execute = createDispatcher(h.pool);
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

describe('delivery', () => {
  it('indexes what an action touched, so the record becomes findable', async () => {
    const id = await acceptSomething('Titanium enclosure fastener choice', 'outbox-first-0001');

    // Not yet: the action committed, the notification has not been delivered.
    expect(await search(h.pool, scope(), { text: 'titanium fastener' })).toEqual([]);

    const result = await drainOutbox(h.adminPool);
    expect(result.delivered).toBeGreaterThan(0);
    expect(result.failed).toBe(0);

    const hits = await search(h.pool, scope(), { text: 'titanium fastener' });
    expect(hits.map((x) => x.objectId)).toContain(id);
  });

  it('is safe to redeliver — the same drain twice changes nothing', async () => {
    await acceptSomething('Anodised finish specification', 'outbox-redeliver-01');
    await drainOutbox(h.adminPool);

    // Undo the delivery mark, exactly as a crash between effect and mark would leave it.
    await withTransaction(h.adminPool, async (tx) =>
      tx.query(
        `update core.outbox set delivered_at = null
          where id = (select id from core.outbox order by created_at desc limit 1)`,
      ),
    );

    const before = await withTransaction(h.adminPool, async (tx) =>
      tx.query<{ object_id: string; body: string }>(
        'select object_id, body from search.document order by object_id',
      ),
    );
    await drainOutbox(h.adminPool);
    const after = await withTransaction(h.adminPool, async (tx) =>
      tx.query<{ object_id: string; body: string }>(
        'select object_id, body from search.document order by object_id',
      ),
    );
    // At-least-once delivery is only safe if the handlers are idempotent. This is that.
    expect(after).toEqual(before);
  });

  it('leaves a row undelivered when its handler throws, and keeps the batch moving', async () => {
    await acceptSomething('A decision whose delivery fails', 'outbox-failing-001');
    await acceptSomething('A decision whose delivery works', 'outbox-working-001');

    let calls = 0;
    const flaky: OutboxHandler = async (tx, payload) => {
      calls += 1;
      // The first row of the batch fails; the rest must still be delivered.
      if (calls === 1) throw new Error('delivery failed');
      const targets = payload['targets'];
      if (Array.isArray(targets)) {
        for (const id of targets) await tx.query('select search.index_object($1)', [id]);
      }
    };

    const result = await drainOutbox(h.adminPool, { handlers: { '*': flaky } });
    expect(result.failed).toBe(1);
    // One bad row must not strand everything behind it.
    expect(result.delivered).toBeGreaterThan(0);

    // And the failed one is still pending, so the next drain retries it rather than losing it.
    const backlog = await outboxBacklog(h.adminPool);
    expect(backlog.pending).toBeGreaterThan(0);

    const retried = await drainOutbox(h.adminPool);
    expect(retried.failed).toBe(0);
    expect((await outboxBacklog(h.adminPool)).pending).toBe(0);
  });

  it('reports an unhandled topic instead of marking it delivered', async () => {
    await acceptSomething('A decision on an unhandled topic', 'outbox-unhandled-01');

    // A handler map with no wildcard: nothing here can deliver these.
    const result = await drainOutbox(h.adminPool, {
      handlers: { 'kf.something_else': async () => {} },
    });
    expect(result.delivered).toBe(0);
    expect(result.unhandled.length).toBeGreaterThan(0);
    expect(result.unhandled[0]).toMatch(/^kf\./);

    // Left pending. Marking it delivered would silently and permanently discard a
    // notification for a topic somebody simply has not written a handler for yet.
    expect((await outboxBacklog(h.adminPool)).pending).toBeGreaterThan(0);
    await drainOutbox(h.adminPool);
  });

  it('reports how far behind delivery is, with an age not just a count', async () => {
    await acceptSomething('Backlog probe', 'outbox-backlog-0001');
    const behind = await outboxBacklog(h.adminPool);
    expect(behind.pending).toBeGreaterThan(0);
    // A count alone cannot distinguish a busy minute from a worker that died an hour ago.
    expect(behind.oldestSeconds).not.toBeNull();

    await drainOutbox(h.adminPool);
    expect(await outboxBacklog(h.adminPool)).toEqual({ pending: 0, oldestSeconds: null });
  });
});

describe('nothing the worker writes is authoritative', () => {
  it('losing the entire outbox costs nothing a rebuild cannot restore', async () => {
    // This is what lets delivery be late without being dangerous. If the index were a source
    // of truth, a lost outbox row would be a permanently unfindable record.
    const before = await withTransaction(h.adminPool, async (tx) =>
      tx.query<{ object_id: string; body: string }>(
        'select object_id, body from search.document order by object_id',
      ),
    );

    await withTransaction(h.adminPool, async (tx) => {
      await tx.query('delete from core.outbox');
      await tx.query('delete from search.document');
    });

    const rebuilt = await withTransaction(h.adminPool, async (tx) =>
      tx.one<{ rebuild: string }>('select search.rebuild() as rebuild'),
    );
    expect(Number(rebuilt.rebuild)).toBeGreaterThan(0);

    const after = await withTransaction(h.adminPool, async (tx) =>
      tx.query<{ object_id: string; body: string }>(
        'select object_id, body from search.document order by object_id',
      ),
    );
    const restored = new Map(after.map((r) => [r.object_id, r.body]));
    for (const row of before) expect(restored.get(row.object_id)).toBe(row.body);
  });
});
