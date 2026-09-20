import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@kf/database';
import {
  bindContext,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

/**
 * Verification is recorded beside the record, never inside it (KF-SAS-RQ-228 to RQ-232).
 *
 * `0.1.0-draft.5` said "draft" where it meant "unverified", and the two are not the same: `draft`
 * is the initial state of 8 of 24 state machines, so a work order beginning at `planned` was never
 * a draft and the rules never reached it. `draft.6` made verification orthogonal to lifecycle, and
 * this table is that orthogonality made structural — a fact about a record, outside the lifecycle
 * guards that every write to `core.object` passes through.
 */
describe('verification is orthogonal to lifecycle', () => {
  let harness: Harness;
  let f: Fixtures;
  let objectId: string;

  beforeAll(async () => {
    harness = await startHarness();
    f = await seedFixtures(harness.adminPool);
    objectId = await createObject(harness.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'ATLAS 3.2 r5 power tree',
      createdBy: f.performerId,
    });
  }, 240_000);

  afterAll(async () => {
    await harness?.stop();
  });

  /**
   * A real act to hang the verification on.
   *
   * The FK is the point: a verification names an act, and an act is a row rather than a context
   * value. The first version of this test passed the harness's bootstrap action id, which is
   * bound as transaction context and has no row behind it — and the foreign key said so.
   */
  let counter = 0;

  async function recordAction(): Promise<string> {
    counter += 1;
    const tag = `verify-${counter}`;
    return withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, f);
      const rows = await tx.query<{ id: string }>(
        `insert into core.action
           (action_type, actor_id, acting_role_id, target_ids, idempotency_key,
            effective_at, result_status, request_digest, organization_id)
         values ('create_initiative', $1, $2, array[$3]::uuid[], $4, date_trunc('milliseconds', now()), 'applied', $5, $6)
         returning id`,
        [
          f.performerId,
          f.performerRoleId,
          objectId,
          tag,
          createHash('sha256').update(tag).digest('hex'),
          f.organizationId,
        ],
      );
      return rows[0]!.id;
    });
  }

  async function verificationOf(id: string): Promise<{ basis: string } | undefined> {
    return withTransaction(harness.pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
      const rows = await tx.query<{ basis: string }>(
        'select basis from core.object_verification where object_id = $1',
        [id],
      );
      return rows[0];
    });
  }

  it('reads a record with no verification row as unverified, rather than as anything else', async () => {
    expect(
      await verificationOf(objectId),
      'absence is the unverified state; there is no boolean to default, because a default of ' +
        'false on a table nobody writes is indistinguishable from a system that has never ' +
        'verified anything',
    ).toBeUndefined();
  });

  it('refuses a verification written without a transaction context', async () => {
    // A REAL action, so the only thing that can refuse this insert is the missing transaction
    // context. The first version passed the harness's bootstrap action id — which has no row —
    // and threw on the foreign key instead. It passed with the guard trigger removed, which is
    // how a test proves nothing while looking green.
    const action = await recordAction();
    await expect(
      withTransaction(harness.pool, async (tx) => {
        // Access context bound so row security admits the write, transaction context NOT bound.
        // Everything else about this insert is valid, so the guard trigger is the only thing left
        // that can refuse it — which is what makes this a test of the guard.
        await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
        await tx.query(
          `insert into core.object_verification (object_id, verified_by, basis, recorded_by_action)
             values ($1, $2, 'reviewed_individually', $3)`,
          [objectId, f.performerId, action],
        );
      }),
    ).rejects.toThrow();
  });

  it('refuses a basis that is neither individual review nor bulk promotion', async () => {
    const action = await recordAction();
    await expect(
      withTransaction(harness.adminPool, async (tx) => {
        await bindContext(tx, f);
        await tx.query(
          `insert into core.object_verification (object_id, verified_by, basis, recorded_by_action)
             values ($1, $2, 'looked_alright', $3)`,
          [objectId, f.performerId, action],
        );
      }),
      'the basis vocabulary is closed: an unrecognised one would let "verified" mean anything',
    ).rejects.toThrow();
  });

  it('records who verified it, when, and on what basis', async () => {
    const action = await recordAction();
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, f);
      await tx.query(
        `insert into core.object_verification (object_id, verified_by, basis, recorded_by_action)
           values ($1, $2, 'promoted_in_bulk', $3)`,
        [objectId, f.performerId, action],
      );
    });
    expect((await verificationOf(objectId))?.basis).toBe('promoted_in_bulk');
  });

  it('does not touch the record it describes', async () => {
    // The point of the sidecar. A verification is not a lifecycle event, so the record's state and
    // its row version are exactly where they were — nothing changed about the object itself.
    const object = await withTransaction(harness.pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
      const rows = await tx.query<{ lifecycle_state: string; row_version: string }>(
        'select lifecycle_state, row_version::text as row_version from core.object where id = $1',
        [objectId],
      );
      return rows[0];
    });
    expect(object?.lifecycle_state, 'verified while still in its initial state').toBe('draft');
    expect(object?.row_version, 'verifying a record is not a change to the record').toBe('1');
  });

  it('reaches the master-record member, so a projection can label it (RQ-229)', async () => {
    const { enumeratePermissionSet } = await import('@kf/documents');
    const members = await withTransaction(harness.pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
      return enumeratePermissionSet(tx, f.organizationId);
    });
    const subject = members.find((m) => m.objectId === objectId);
    expect(subject?.verified?.basis).toBe('promoted_in_bulk');
    expect(
      members.some((m) => m.verified === undefined),
      'the join must be a LEFT join: an inner one drops every unchecked record from the corpus, ' +
        'which is the silent omission RQ-229 forbids arriving as a query shape',
    ).toBe(true);
  });

  it('hides the verification from a session that cannot see the record', async () => {
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, f);
      await tx.query(
        'update core.object set classification = $2, row_version = row_version + 1 where id = $1',
        [objectId, 'restricted'],
      );
    });

    const atLowerCeiling = await withTransaction(harness.pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'internal']);
      const rows = await tx.query('select 1 from core.object_verification where object_id = $1', [
        objectId,
      ]);
      return rows.length;
    });
    expect(
      atLowerCeiling,
      'a session that cannot see the record has no business learning that somebody checked it',
    ).toBe(0);
  });
});
