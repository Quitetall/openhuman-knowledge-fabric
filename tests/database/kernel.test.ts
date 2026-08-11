/**
 * Gate 3 exit criteria, against a real PostgreSQL 18.
 *
 * Every case here is a planted violation: the system is asked to do something it must
 * refuse, and the test asserts it refused for the RIGHT reason. A suite that only exercises
 * the happy path would pass just as well against a kernel with every check removed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDispatcher, ActionRejected } from '@kf/actions';
import { withTransaction } from '@kf/database';
import {
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

let h: Harness;
let f: Fixtures;
let execute: ReturnType<typeof createDispatcher>;

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  execute = createDispatcher(h.pool);
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

/** A decision record in `proposed`, created by the performer. */
async function proposedDecision(): Promise<string> {
  return createObject(h.adminPool, f, {
    type: 'decision_record',
    domain: 'engineering',
    state: 'proposed',
    title: 'Use an independent internal frame',
    createdBy: f.performerId,
  });
}

const key = (): string => `test-${Math.random().toString(36).slice(2)}-${Date.now()}`;

async function rejection(p: Promise<unknown>): Promise<ActionRejected> {
  try {
    await p;
  } catch (err: unknown) {
    if (err instanceof ActionRejected) return err;
    throw err;
  }
  throw new Error('expected the action to be rejected, but it succeeded');
}

describe('the kernel applies a legitimate action', () => {
  it('moves the object, writes an audit event and emits an outbox row', async () => {
    const id = await proposedDecision();
    const result = await execute({
      actionType: 'accept_decision',
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      targetIds: [id],
      idempotencyKey: key(),
      organizationId: f.organizationId,
      maxClassification: 'restricted',
    });

    expect(result.status).toBe('applied');
    expect(result.replayed).toBe(false);
    expect(result.auditDigest).toMatch(/^[0-9a-f]{64}$/);

    await withTransaction(h.pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
      const o = await tx.one<{ lifecycle_state: string; row_version: string }>(
        'select lifecycle_state, row_version from core.object where id = $1',
        [id],
      );
      expect(o.lifecycle_state).toBe('accepted');
      // row_version moved, so a concurrent caller holding the old one now fails.
      expect(Number(o.row_version)).toBe(2);

      const audit = await tx.one<{ n: string }>(
        'select count(*) as n from core.audit_event where action_id = $1',
        [result.actionId],
      );
      expect(Number(audit.n)).toBe(1);

      const outbox = await tx.one<{ n: string }>(
        'select count(*) as n from core.outbox where action_id = $1',
        [result.actionId],
      );
      expect(Number(outbox.n)).toBe(1);
    });
  });
});

describe('planted violations — the kernel must refuse', () => {
  it('an action type the ontology does not define', async () => {
    const id = await proposedDecision();
    const err = await rejection(
      execute({
        actionType: 'teleport_decision',
        actorId: f.reviewerId,
        actingRoleId: f.reviewerRoleId,
        targetIds: [id],
        idempotencyKey: key(),
        organizationId: f.organizationId,
        maxClassification: 'restricted',
        organizationId: f.organizationId,
        maxClassification: 'restricted',
      }),
    );
    expect(err.failure).toBe('unknown_action');
  });

  it('a role the actor does not hold', async () => {
    const id = await proposedDecision();
    // The performer's role assignment, claimed by the reviewer.
    const err = await rejection(
      execute({
        actionType: 'accept_decision',
        actorId: f.reviewerId,
        actingRoleId: f.performerRoleId,
        targetIds: [id],
        idempotencyKey: key(),
        organizationId: f.organizationId,
        maxClassification: 'restricted',
        organizationId: f.organizationId,
        maxClassification: 'restricted',
      }),
    );
    expect(err.failure).toBe('role_not_held');
  });

  it('an object that does not exist — indistinguishable from one not visible', async () => {
    const err = await rejection(
      execute({
        actionType: 'accept_decision',
        actorId: f.reviewerId,
        actingRoleId: f.reviewerRoleId,
        targetIds: ['01930000-0000-7000-8000-0000deadbeef'],
        idempotencyKey: key(),
        organizationId: f.organizationId,
        maxClassification: 'restricted',
        organizationId: f.organizationId,
        maxClassification: 'restricted',
      }),
    );
    expect(err.failure).toBe('object_not_visible');
  });

  it('a transition the lifecycle does not permit', async () => {
    // accept_decision drives proposed -> accepted. From `draft` there is no such move.
    const id = await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Still a draft',
      createdBy: f.performerId,
    });
    const err = await rejection(
      execute({
        actionType: 'accept_decision',
        actorId: f.reviewerId,
        actingRoleId: f.reviewerRoleId,
        targetIds: [id],
        idempotencyKey: key(),
        organizationId: f.organizationId,
        maxClassification: 'restricted',
        organizationId: f.organizationId,
        maxClassification: 'restricted',
      }),
    );
    expect(err.failure).toBe('illegal_transition');
    expect(err.detail['from']).toBe('draft');
  });

  it('a stale row version — someone else moved the record first', async () => {
    const id = await proposedDecision();
    const err = await rejection(
      execute({
        actionType: 'accept_decision',
        actorId: f.reviewerId,
        actingRoleId: f.reviewerRoleId,
        targetIds: [id],
        idempotencyKey: key(),
        organizationId: f.organizationId,
        maxClassification: 'restricted',
        organizationId: f.organizationId,
        maxClassification: 'restricted',
        expectedVersion: 99,
      }),
    );
    expect(err.failure).toBe('version_conflict');
  });

  it('separation of duty — the creator may not accept their own work', async () => {
    const id = await createObject(h.adminPool, f, {
      type: 'work_package',
      domain: 'project',
      state: 'submitted',
      title: 'Enclosure drawings',
      createdBy: f.performerId,
    });
    const err = await rejection(
      execute({
        actionType: 'accept_work_package',
        actorId: f.performerId,
        actingRoleId: f.performerRoleId,
        targetIds: [id],
        idempotencyKey: key(),
        organizationId: f.organizationId,
        maxClassification: 'restricted',
        organizationId: f.organizationId,
        maxClassification: 'restricted',
      }),
    );
    expect(err.failure).toBe('separation_of_duty');
  });

  it('a correction with no reason', async () => {
    const id = await createObject(h.adminPool, f, {
      type: 'work_package',
      domain: 'project',
      state: 'active',
      title: 'Needs blocking',
      createdBy: f.performerId,
    });
    const err = await rejection(
      execute({
        actionType: 'correct_record',
        actorId: f.reviewerId,
        actingRoleId: f.reviewerRoleId,
        targetIds: [id],
        idempotencyKey: key(),
        organizationId: f.organizationId,
        maxClassification: 'restricted',
        organizationId: f.organizationId,
        maxClassification: 'restricted',
        payload: { to_state: 'blocked' },
      }),
    );
    expect(err.failure).toBe('reason_required');
  });

  it('an ambiguous transition with no chosen destination', async () => {
    // correct_record can take an active work package to blocked OR waived. Guessing would
    // silently pick a lifecycle branch on the caller's behalf.
    const id = await createObject(h.adminPool, f, {
      type: 'work_package',
      domain: 'project',
      state: 'active',
      title: 'Ambiguous',
      createdBy: f.performerId,
    });
    const err = await rejection(
      execute({
        actionType: 'correct_record',
        actorId: f.reviewerId,
        actingRoleId: f.reviewerRoleId,
        targetIds: [id],
        idempotencyKey: key(),
        organizationId: f.organizationId,
        maxClassification: 'restricted',
        organizationId: f.organizationId,
        maxClassification: 'restricted',
        reason: 'blocked on a supplier',
      }),
    );
    expect(err.failure).toBe('precondition_failed');
    expect(String(err.message)).toContain('to_state');
  });
});

describe('idempotency', () => {
  it('replays the first result instead of applying twice', async () => {
    const id = await proposedDecision();
    const idempotencyKey = key();
    const request = {
      actionType: 'accept_decision',
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      targetIds: [id],
      idempotencyKey,
      organizationId: f.organizationId,
      maxClassification: 'restricted',
    };

    const first = await execute(request);
    const second = await execute(request);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.actionId).toBe(first.actionId);
    expect(second.auditDigest).toBe(first.auditDigest);

    await withTransaction(h.pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
      // Applied ONCE: two audit events would mean the retry did the work again.
      const n = await tx.one<{ n: string }>(
        'select count(*) as n from core.audit_event where action_id = $1',
        [first.actionId],
      );
      expect(Number(n.n)).toBe(1);
      const o = await tx.one<{ row_version: string }>(
        'select row_version from core.object where id = $1',
        [id],
      );
      expect(Number(o.row_version)).toBe(2);
    });
  });
});

describe('the audit chain', () => {
  it('links each event to its predecessor', async () => {
    for (let i = 0; i < 3; i++) {
      const id = await proposedDecision();
      await execute({
        actionType: 'accept_decision',
        actorId: f.reviewerId,
        actingRoleId: f.reviewerRoleId,
        targetIds: [id],
        idempotencyKey: key(),
        organizationId: f.organizationId,
        maxClassification: 'restricted',
        organizationId: f.organizationId,
        maxClassification: 'restricted',
      });
    }

    await withTransaction(h.pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
      const rows = await tx.query<{ seq: string; prev_digest: string; digest: string }>(
        'select seq, prev_digest, digest from core.audit_event order by seq',
      );
      expect(rows.length).toBeGreaterThanOrEqual(3);
      expect(rows[0]!.prev_digest).toBe('0'.repeat(64));
      for (let i = 1; i < rows.length; i++) {
        // Each row commits to the one before it. A gap or a reorder breaks the walk.
        expect(rows[i]!.prev_digest, `event ${rows[i]!.seq}`).toBe(rows[i - 1]!.digest);
      }
    });
  });

  it('cannot be rewritten by the application, at either layer', async () => {
    // Two independent defences. For kf_app the GRANT answers first — it holds no UPDATE or
    // DELETE on this table at all — so the message is "permission denied", not the
    // trigger's. Asserting only the trigger text would have made this test depend on the
    // weaker of the two protections.
    for (const sql of [
      "update core.audit_event set reason = 'tampered'",
      'delete from core.audit_event',
    ]) {
      await expect(
        withTransaction(h.pool, async (tx) => {
          await tx.query(sql);
        }),
      ).rejects.toThrow(/permission denied|append-only/);
    }
  });

  it('cannot be rewritten by the OWNER either — the trigger is the second defence', async () => {
    // The owner does hold the privilege, so here the trigger is what refuses. This is the
    // case that matters: privileges can be re-granted by accident, a trigger cannot.
    for (const sql of [
      "update core.audit_event set reason = 'tampered'",
      'delete from core.audit_event',
    ]) {
      await expect(
        withTransaction(h.adminPool, async (tx) => {
          await tx.query(sql);
        }),
      ).rejects.toThrow(/append-only/);
    }
  });
});

describe('row-level security', () => {
  it('hides objects belonging to another organization', async () => {
    const id = await proposedDecision();
    await withTransaction(h.pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [
        '01930000-0000-7000-8000-00000000ffff',
        'restricted',
      ]);
      const rows = await tx.query('select id from core.object where id = $1', [id]);
      expect(rows).toEqual([]);
    });
  });

  it('hides everything when no access context is set', async () => {
    // The unset case must be the most restrictive one, not the most permissive.
    await withTransaction(h.pool, async (tx) => {
      const rows = await tx.query('select id from core.object limit 1');
      expect(rows).toEqual([]);
    });
  });

  it('hides objects above the reader classification ceiling', async () => {
    const id = await withTransaction(h.pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
      const row = await tx.one<{ id: string }>(
        `insert into core.object
           (object_type, authority_domain, lifecycle_state, classification, retention_class,
            schema_version, organization_id, title, created_by, updated_by)
         values ('decision_record','engineering','proposed','restricted','project_record',
                 $1,$2,'Restricted decision',$3,$3)
         returning id`,
        [f.schemaVersion, f.organizationId, f.performerId],
      );
      return row.id;
    });

    await withTransaction(h.pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'internal']);
      expect(await tx.query('select id from core.object where id = $1', [id])).toEqual([]);
    });
    await withTransaction(h.pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
      expect(await tx.query('select id from core.object where id = $1', [id])).toHaveLength(1);
    });
  });
});

describe('the registry constrains the domain', () => {
  it('refuses an object in a state its lifecycle does not define', async () => {
    await expect(
      withTransaction(h.pool, async (tx) => {
        await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
        await tx.query(
          `insert into core.object
             (object_type, authority_domain, lifecycle_state, classification, retention_class,
              schema_version, organization_id, title, created_by, updated_by)
           values ('decision_record','engineering','levitating','internal','project_record',
                   $1,$2,'Nope',$3,$3)`,
          [f.schemaVersion, f.organizationId, f.performerId],
        );
      }),
    ).rejects.toThrow(/object_state_defined|violates foreign key/);
  });

  it('refuses overlapping assignments of the same role in the same scope', async () => {
    // "Was this person authorized on that date" must have one answer.
    await expect(
      withTransaction(h.pool, async (tx) => {
        await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
        const row = await tx.one<{ id: string }>(
          `insert into core.object
             (object_type, authority_domain, lifecycle_state, classification, retention_class,
              schema_version, organization_id, title, created_by, updated_by)
           values ('role_assignment','organization','active','internal','project_record',
                   $1,$2,'Duplicate authority',$3,$3)
           returning id`,
          [f.schemaVersion, f.organizationId, f.performerId],
        );
        await tx.query(
          'insert into org.role_assignment (id, subject_id, role_id, scope_id) values ($1,$2,$3,$4)',
          [row.id, f.reviewerId, 'technical_authority', f.organizationId],
        );
      }),
    ).rejects.toThrow(/role_assignment_no_overlap|exclusion constraint/);
  });
});
