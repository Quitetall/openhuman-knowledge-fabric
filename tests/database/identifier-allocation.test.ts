import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { withTransaction } from '@kf/database';
import { createFabricDispatcher } from '@kf/orchestrator';
import { registerIdentifierRoutes } from '../../apps/api/src/routes/identifiers.js';
import {
  bindContext,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

/**
 * R6 allocation is atomic, permanent, and never proposed by the caller (ADR 0018). Against a
 * real database:
 *
 *   1. One dispatched `allocate_enterprise_identifier` attaches a valid identifier under the
 *      object type's namespace, returns it in the receipt, and a replay returns the same
 *      receipt without allocating again.
 *   2. The caller cannot propose one: a payload naming an enterprise_id is refused BEFORE any
 *      allocation, by name.
 *   3. Permanent: a second allocation on the same object is refused (R8).
 *   4. Seeds keep their numbers: a reviewed identifier occupying the next sequence value is
 *      skipped, never reissued.
 *   5. Concurrency: two transactions allocating at once get two distinct identifiers.
 *   6. A type whose namespace this instance has not allocated is refused by name.
 *   7. `GET /identifiers/:id` serves the receipt and answers _not found_ for an identifier
 *      of the right shape that was never allocated.
 */

let harness: Harness;
let fixtures: Fixtures;

beforeAll(async () => {
  harness = await startHarness();
  fixtures = await seedFixtures(harness.adminPool);
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

const dispatcher = () => createFabricDispatcher(harness.pool);

async function newDocument(title: string): Promise<string> {
  return createObject(harness.adminPool, fixtures, {
    type: 'controlled_document',
    domain: 'quality',
    state: 'draft',
    title,
    createdBy: fixtures.reviewerId,
  });
}

function allocate(objectId: string, extra: Record<string, unknown> = {}) {
  return dispatcher()({
    actionType: 'allocate_enterprise_identifier',
    actorId: fixtures.reviewerId,
    actingRoleId: fixtures.reviewerRoleId,
    targetIds: [objectId],
    organizationId: fixtures.organizationId,
    maxClassification: 'restricted',
    idempotencyKey: `allocate-${randomUUID()}`,
    reason: 'the record is being registered',
    ...extra,
  });
}

async function enterpriseIdOf(objectId: string): Promise<string | null> {
  const row = await withTransaction(harness.adminPool, (tx) =>
    tx.one<{ enterprise_id: string | null }>(
      'select enterprise_id from core.object where id = $1',
      [objectId],
    ),
  );
  return row.enterprise_id;
}

describe('R6 allocation', () => {
  it('allocates under the type namespace, returns the receipt, and replays it', async () => {
    const document = await newDocument('Allocated document');
    const key = `allocate-${randomUUID()}`;
    const first = await allocate(document, { idempotencyKey: key });
    expect(first.status).toBe('applied');
    const receipt = first.receipt as Record<string, unknown>;
    expect(receipt['enterprise_id']).toMatch(/^OH-DOC-[0-9]{6}-[0-9]$/);
    expect(receipt['namespace']).toBe('OH-DOC');
    expect(typeof receipt['sequence']).toBe('number');
    expect(typeof receipt['allocated_at']).toBe('string');
    expect(await enterpriseIdOf(document)).toBe(receipt['enterprise_id']);

    const valid = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{ ok: boolean }>('select core.valid_enterprise_id($1) as ok', [
        receipt['enterprise_id'],
      ]),
    );
    expect(valid.ok).toBe(true);

    const replay = await allocate(document, { idempotencyKey: key });
    expect(replay.replayed).toBe(true);
    expect(replay.actionId).toBe(first.actionId);
    expect(replay.receipt).toEqual(first.receipt);
    const count = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{ count: string }>(
        'select count(*)::text as count from registry.identifier_allocation where object_id = $1',
        [document],
      ),
    );
    expect(count.count).toBe('1');
  });

  it('refuses a caller-proposed identifier before allocating anything', async () => {
    const document = await newDocument('Fabrication attempt');
    await expect(
      allocate(document, { payload: { enterprise_id: 'OH-DOC-000042-7' } }),
    ).rejects.toMatchObject({ name: 'ActionRejected', failure: 'precondition_failed' });
    expect(await enterpriseIdOf(document)).toBeNull();
  });

  it('is permanent: a second allocation on the same object is refused', async () => {
    const document = await newDocument('Once only');
    const first = await allocate(document);
    await expect(allocate(document)).rejects.toMatchObject({
      name: 'ActionRejected',
      failure: 'precondition_failed',
    });
    expect(await enterpriseIdOf(document)).toBe(
      (first.receipt as Record<string, unknown>)['enterprise_id'],
    );
  });

  it('skips a sequence value a reviewed seed already occupies', async () => {
    const next = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{ next_sequence: string }>(
        `select next_sequence::text from registry.identifier_sequence where qualified_code = 'OH-DOC'`,
      ),
    );
    const seq = Number(next.next_sequence);
    const payload = String(seq).padStart(6, '0');
    const digit = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{ d: number }>('select core.damm_check($1) as d', [payload]),
    );
    const occupied = `OH-DOC-${payload}-${String(digit.d)}`;
    const seed = await newDocument('Reviewed seed');
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, fixtures, fixtures.reviewerId);
      await tx.query(
        'update core.object set enterprise_id = $2, row_version = row_version + 1 where id = $1',
        [seed, occupied],
      );
    });

    const document = await newDocument('After the seed');
    const result = await allocate(document);
    const allocated = (result.receipt as Record<string, unknown>)['enterprise_id'] as string;
    expect(allocated).not.toBe(occupied);
    expect((result.receipt as Record<string, unknown>)['sequence']).toBe(seq + 1);
  });

  it('serialises concurrent allocations: two at once, two distinct identifiers', async () => {
    const [a, b] = await Promise.all([newDocument('Racer A'), newDocument('Racer B')]);
    const [ra, rb] = await Promise.all([allocate(a), allocate(b)]);
    const ida = (ra.receipt as Record<string, unknown>)['enterprise_id'];
    const idb = (rb.receipt as Record<string, unknown>)['enterprise_id'];
    expect(ida).not.toBe(idb);
    expect(new Set([await enterpriseIdOf(a), await enterpriseIdOf(b)]).size).toBe(2);
  });

  it('refuses, by name, a type with no namespace and a namespace that is not active', async () => {
    // A person declares no enterprise namespace: nothing can be allocated to it.
    await expect(allocate(fixtures.performerId)).rejects.toMatchObject({
      name: 'ActionRejected',
      failure: 'precondition_failed',
      message: expect.stringContaining('no enterprise namespace'),
    });

    // R01 §13.3: a retired namespace accepts no NEW allocation; what it issued stays valid.
    // `capa` numbers under QEV (registry 1.0.0-draft.2); retire OH-QEV for the duration.
    const capa = await createObject(harness.adminPool, fixtures, {
      type: 'capa',
      domain: 'qms',
      state: 'open',
      title: 'Retired namespace',
      createdBy: fixtures.reviewerId,
    });
    await withTransaction(harness.adminPool, (tx) =>
      tx.query(
        `update registry.identifier_namespace set state = 'retired' where qualified_code = 'OH-QEV'`,
      ),
    );
    try {
      await expect(allocate(capa)).rejects.toMatchObject({
        name: 'ActionRejected',
        failure: 'precondition_failed',
        message: expect.stringContaining('retired'),
      });
      expect(await enterpriseIdOf(capa)).toBeNull();
    } finally {
      await withTransaction(harness.adminPool, (tx) =>
        tx.query(
          `update registry.identifier_namespace set state = 'active' where qualified_code = 'OH-QEV'`,
        ),
      );
    }
    const numbered = await allocate(capa);
    expect((numbered.receipt as Record<string, unknown>)['enterprise_id']).toMatch(
      /^OH-QEV-[0-9]{6}-[0-9]$/,
    );
  });

  it('serves the receipt and hides what was never allocated', async () => {
    const document = await newDocument('Served receipt');
    const result = await allocate(document);
    const id = (result.receipt as Record<string, unknown>)['enterprise_id'] as string;
    const app = Fastify({ logger: false });
    await registerIdentifierRoutes(app, {
      pool: harness.pool,
      identify: async () => ({
        actorId: fixtures.reviewerId,
        actingRoleId: fixtures.reviewerRoleId,
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
        authentication: { authenticatedAt: undefined, assuranceLevel: undefined, methods: [] },
      }),
    });
    await app.ready();
    try {
      const served = await app.inject({ method: 'GET', url: `/identifiers/${id}` });
      expect(served.statusCode, served.body).toBe(200);
      const body = served.json() as Record<string, unknown>;
      expect(body['object_id']).toBe(document);
      expect(body['allocated_by_action']).toBe(result.actionId);
      expect(body['allocated_at']).toBe(
        (result.receipt as Record<string, unknown>)['allocated_at'],
      );

      const never = await app.inject({ method: 'GET', url: '/identifiers/OH-DOC-999998-6' });
      expect(never.statusCode).toBe(404);
      const malformed = await app.inject({ method: 'GET', url: '/identifiers/not-an-id' });
      expect(malformed.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
