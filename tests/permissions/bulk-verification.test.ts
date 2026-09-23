/**
 * Bulk verification is stamped by the server, and individual review has a human pace
 * (KF-SAS-RQ-227, RQ-231; 20260924000300).
 *
 * Against a real database, through the real app and its dispatcher, as the application login.
 * Two halves: the gesture that promotes many records records them as `promoted_in_bulk` whatever
 * the caller would have said, one act per record; and `reviewed_individually` twice inside a
 * second by one verifier is refused — by the dispatcher with a message pointing at the gesture,
 * and by the database for a writer that skipped the dispatcher.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { InMemoryObjectStore } from '@kf/artifacts';
import { withTransaction, type Tx } from '@kf/database';
import { buildApp } from '../../apps/api/src/app.js';
import { DEFAULT_BULK_CEILING, MAX_BULK_CEILING } from '../../apps/api/src/sync/plan.js';
import {
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from '../database/harness.js';

let h: Harness;
let f: Fixtures;
let app: FastifyInstance;

function asReviewer() {
  return {
    'x-kf-actor': f.reviewerId,
    'x-kf-acting-role': f.reviewerRoleId,
    'x-kf-organization': f.organizationId,
    'x-kf-classification': 'restricted',
  };
}

async function records(n: number, createdBy = f.performerId): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    ids.push(
      await createObject(h.adminPool, f, {
        type: 'decision_record',
        domain: 'engineering',
        state: 'draft',
        title: `Swept record ${String(i)}`,
        createdBy,
      }),
    );
  }
  return ids;
}

async function verifications(ids: readonly string[]) {
  return withTransaction(h.adminPool, (tx) =>
    tx.query<{ object_id: string; basis: string; verified_by: string; action_type: string }>(
      `select v.object_id, v.basis, v.verified_by, a.action_type
         from core.object_verification v join core.action a on a.id = v.recorded_by_action
        where v.object_id = any($1::uuid[])`,
      [ids],
    ),
  );
}

/** Wait out the pace, so one test's individual review does not refuse the next test's. */
const pastThePace = () => new Promise((resolve) => setTimeout(resolve, 1_100));

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  const appUri = new URL(h.connectionString);
  appUri.username = 'kf_app_login';
  appUri.password = 'test-only-not-a-secret';
  app = await buildApp(
    {
      host: '127.0.0.1',
      port: 0,
      logLevel: process.env['LOG_LEVEL'] ?? 'silent',
      databaseUrl: appUri.toString(),
      environment: 'test',
      deploymentProfile: 'development',
      tlsTerminatedUpstream: false,
      identity: undefined,
    },
    { objectStore: new InMemoryObjectStore() },
  );
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await h?.stop();
});

describe('POST /verifications/bulk', () => {
  it('records every record as promoted_in_bulk, one act each', async () => {
    const ids = await records(3);
    const res = await app.inject({
      method: 'POST',
      url: '/verifications/bulk',
      headers: asReviewer(),
      payload: {
        recordIds: ids,
        reason: 'promoting the imported register after sampling ten',
        idempotencyKey: `bulk-${randomUUID()}`,
        // The server does not read a basis from the body; this one is ignored.
        basis: 'reviewed_individually',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { applied: { actionId: string }[]; refused: unknown[] };
    expect(body.refused).toEqual([]);
    expect(new Set(body.applied.map((a) => a.actionId)).size, 'one act per record').toBe(3);
    const rows = await verifications(ids);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({
        basis: 'promoted_in_bulk',
        verified_by: f.reviewerId,
        action_type: 'verify_record',
      });
    }
  });

  it('is not refused by the pace: a gesture is many records in one second by design', async () => {
    // Five acts in well under a second by one verifier. At reviewed_individually the database
    // would refuse the second; at promoted_in_bulk that is exactly what the basis says.
    const ids = await records(5);
    const res = await app.inject({
      method: 'POST',
      url: '/verifications/bulk',
      headers: asReviewer(),
      payload: {
        recordIds: ids,
        reason: 'promoting the rest of the register',
        idempotencyKey: `bulk-${randomUUID()}`,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(await verifications(ids)).toHaveLength(5);
  });

  it('reports a refusal per record and keeps the rest', async () => {
    const [mine] = await records(1, f.reviewerId);
    const [theirs] = await records(1);
    const res = await app.inject({
      method: 'POST',
      url: '/verifications/bulk',
      headers: asReviewer(),
      payload: {
        recordIds: [mine, theirs],
        reason: 'promoting both after the audit sample',
        idempotencyKey: `bulk-${randomUUID()}`,
      },
    });
    expect(res.statusCode, 'a partial gesture must not read as a whole one').toBe(207);
    const body = res.json() as {
      applied: { recordId: string }[];
      refused: { recordId: string; error: string }[];
    };
    // The reviewer created `mine`, so separation of duty refuses it, and only it.
    expect(body.refused).toEqual([
      expect.objectContaining({ recordId: mine, error: 'separation_of_duty' }),
    ]);
    expect(body.applied.map((a) => a.recordId)).toEqual([theirs]);
  });

  it('replays on a retried gesture instead of verifying twice', async () => {
    const ids = await records(2);
    const payload = {
      recordIds: ids,
      reason: 'promoting after the sample, retried',
      idempotencyKey: `bulk-${randomUUID()}`,
    };
    const first = await app.inject({
      method: 'POST',
      url: '/verifications/bulk',
      headers: asReviewer(),
      payload,
    });
    expect(first.statusCode).toBe(201);
    const again = await app.inject({
      method: 'POST',
      url: '/verifications/bulk',
      headers: asReviewer(),
      payload,
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(
      (again.json() as { applied: { replayed: boolean }[] }).applied.every((a) => a.replayed),
    ).toBe(true);
  });

  it('refuses a gesture above the ceiling unless confirmed, and above the hard limit always', async () => {
    const fake = (n: number) => Array.from({ length: n }, () => randomUUID());
    const over = await app.inject({
      method: 'POST',
      url: '/verifications/bulk',
      headers: asReviewer(),
      payload: {
        recordIds: fake(DEFAULT_BULK_CEILING + 1),
        reason: 'a selection that is too large',
        idempotencyKey: `bulk-${randomUUID()}`,
      },
    });
    expect(over.statusCode).toBe(400);
    expect(over.json()).toMatchObject({ error: 'bulk_confirmation_required' });
    const beyond = await app.inject({
      method: 'POST',
      url: '/verifications/bulk',
      headers: asReviewer(),
      payload: {
        recordIds: fake(MAX_BULK_CEILING + 1),
        reason: 'a selection that is far too large',
        idempotencyKey: `bulk-${randomUUID()}`,
        acceptBulk: true,
      },
    });
    expect(beyond.statusCode).toBe(400);
    expect(beyond.json()).toMatchObject({ error: 'bulk_ceiling_exceeded' });
  });

  it('judges the reason once, before any act', async () => {
    const ids = await records(2);
    const res = await app.inject({
      method: 'POST',
      url: '/verifications/bulk',
      headers: asReviewer(),
      payload: { recordIds: ids, reason: 'ok', idempotencyKey: `bulk-${randomUUID()}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'reason_required' });
    expect(await verifications(ids)).toEqual([]);
  });
});

describe('individual review has a human pace', () => {
  const verifyOne = (recordId: string) =>
    app.inject({
      method: 'POST',
      url: '/actions/verify_record',
      headers: asReviewer(),
      payload: {
        targetIds: [recordId],
        reason: 'read it against the source',
        idempotencyKey: `verify-${randomUUID()}`,
        payload: { basis: 'reviewed_individually' },
      },
    });

  it('refuses a second individual review inside the interval, and says where to go', async () => {
    await pastThePace();
    const [first, second, later] = await records(3);
    expect((await verifyOne(first!)).statusCode).toBe(201);
    const refused = await verifyOne(second!);
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json()).toMatchObject({ error: 'precondition_failed' });
    expect((refused.json() as { message: string }).message).toContain('POST /verifications/bulk');
    expect(await verifications([second!]), 'a refused act writes nothing').toEqual([]);

    // The pace is a floor, not a quota: after it, the next individual review is accepted.
    await pastThePace();
    expect((await verifyOne(later!)).statusCode).toBe(201);
  });

  it('is enforced by the database for a writer that skips the dispatcher', async () => {
    await pastThePace();
    const [a, b] = await records(2);
    const forge = (tx: Tx, recordId: string) =>
      (async () => {
        const actionId = randomUUID();
        await tx.query('select core.bind_principal($1, $2, $3, $4)', [
          f.reviewerId,
          f.reviewerRoleId,
          f.organizationId,
          'restricted',
        ]);
        await tx.query('select core.set_transaction_context($1, $2, $3, $4)', [
          f.reviewerId,
          f.reviewerRoleId,
          actionId,
          'pace-test',
        ]);
        await tx.query(
          `insert into core.action
             (id, organization_id, request_digest, action_type, actor_id, acting_role_id,
              target_ids, idempotency_key, effective_at, result_status)
           values ($1, $2, repeat('d', 64), 'verify_record', $3, $4, array[$5]::uuid[], $6,
                   date_trunc('milliseconds', now()), 'applied')`,
          [
            actionId,
            f.organizationId,
            f.reviewerId,
            f.reviewerRoleId,
            recordId,
            `pace-${actionId}`,
          ],
        );
        // An explicit verified_at a year ago: the database's clock wins.
        await tx.query(
          `insert into core.object_verification
             (object_id, verified_by, basis, recorded_by_action, verified_at)
           values ($1, $2, 'reviewed_individually', $3, now() - interval '1 year')`,
          [recordId, f.reviewerId, actionId],
        );
      })();
    await withTransaction(h.pool, (tx) => forge(tx, a!));
    await expect(withTransaction(h.pool, (tx) => forge(tx, b!))).rejects.toThrow(
      /POST \/verifications\/bulk/,
    );
    const [row] = await verifications([a!]);
    expect(row).toBeDefined();
    const recorded = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ recent: boolean }>(
        `select verified_at > now() - interval '1 hour' as recent
           from core.object_verification where object_id = $1`,
        [a],
      ),
    );
    expect(recorded.recent, 'a caller-supplied verified_at was kept').toBe(true);
  });

  it('keeps the interval as one named constant', async () => {
    const constant = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ seconds: number }>(
        'select extract(epoch from core.individual_review_interval())::float8 as seconds',
      ),
    );
    expect(constant.seconds).toBe(1);
  });
});
