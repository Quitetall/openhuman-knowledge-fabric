/**
 * Gate 3 exit criteria, against a real PostgreSQL 18.
 *
 * Every case here is a planted violation: the system is asked to do something it must
 * refuse, and the test asserts it refused for the RIGHT reason. A suite that only exercises
 * the happy path would pass just as well against a kernel with every check removed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDispatcher, ActionRejected } from '@kf/actions';
import { createPool, withTransaction } from '@kf/database';
import {
  bindContext,
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
      await bindContext(tx, f);
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
      await bindContext(tx, f);
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

  it('rejects the same key when targets or payload change', async () => {
    const firstTarget = await proposedDecision();
    const secondTarget = await proposedDecision();
    const idempotencyKey = key();
    const base = {
      actionType: 'accept_decision',
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      targetIds: [firstTarget],
      idempotencyKey,
      organizationId: f.organizationId,
      maxClassification: 'restricted',
    };

    await execute(base);
    const err = await rejection(execute({ ...base, targetIds: [secondTarget] }));
    expect(err.failure).toBe('idempotency_conflict');

    await withTransaction(h.pool, async (tx) => {
      await bindContext(tx, f);
      const action = await tx.one<{ organization_id: string; request_digest: string }>(
        `select organization_id::text, request_digest
           from core.action where action_type = $1 and idempotency_key = $2`,
        [base.actionType, idempotencyKey],
      );
      expect(action.organization_id).toBe(f.organizationId);
      expect(action.request_digest).toMatch(/^[0-9a-f]{64}$/);
      const untouched = await tx.one<{ lifecycle_state: string }>(
        'select lifecycle_state from core.object where id = $1',
        [secondTarget],
      );
      expect(untouched.lifecycle_state).toBe('proposed');
    });
  });

  it('replays across an audit predecessor hidden by another organization RLS scope', async () => {
    const other = await seedFixtures(h.adminPool);
    const firstTarget = await proposedDecision();
    const otherTarget = await createObject(h.adminPool, other, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'proposed',
      title: 'Other organization interleaving event',
      createdBy: other.performerId,
    });
    const replayTarget = await proposedDecision();

    await execute({
      actionType: 'accept_decision',
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      targetIds: [firstTarget],
      idempotencyKey: key(),
      organizationId: f.organizationId,
      maxClassification: 'restricted',
    });
    await execute({
      actionType: 'accept_decision',
      actorId: other.reviewerId,
      actingRoleId: other.reviewerRoleId,
      targetIds: [otherTarget],
      idempotencyKey: key(),
      organizationId: other.organizationId,
      maxClassification: 'restricted',
    });
    const request = {
      actionType: 'accept_decision',
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      targetIds: [replayTarget],
      idempotencyKey: key(),
      organizationId: f.organizationId,
      maxClassification: 'restricted',
    } as const;

    const first = await execute(request);
    const replay = await execute(request);
    expect(replay).toMatchObject({
      actionId: first.actionId,
      auditDigest: first.auditDigest,
      replayed: true,
      status: 'applied',
    });

    const global = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ breaks: number; head_matches: boolean }>(
        `with linked as (
           select seq, digest, prev_digest, lag(digest) over (order by seq) as expected_prev
             from core.audit_event
         )
         select count(*) filter (
                  where (expected_prev is null and prev_digest <> repeat('0', 64))
                     or (expected_prev is not null and prev_digest <> expected_prev)
                )::integer as breaks,
                (select head.digest = (select digest from linked order by seq desc limit 1)
                   from core.audit_chain_head head) as head_matches
           from linked`,
      ),
    );
    expect(global).toEqual({ breaks: 0, head_matches: true });
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
      });
    }

    await withTransaction(h.adminPool, async (tx) => {
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
      await bindContext(tx, f);
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
      await bindContext(tx, f);
      expect(await tx.query('select id from core.object where id = $1', [id])).toHaveLength(1);
    });
  });
});

describe('the registry constrains the domain', () => {
  it('refuses an object in a state its lifecycle does not define', async () => {
    await expect(
      withTransaction(h.pool, async (tx) => {
        await bindContext(tx, f);
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
        await bindContext(tx, f);
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

describe('the dispatcher cannot be bypassed', () => {
  // Before these guards existed, kf_app held UPDATE on core.object and no trigger consulted
  // the transaction context. A direct `update core.object set lifecycle_state = ...` would
  // have moved a record with no action, no audit event and no actor. The guarantee was a
  // convention; these are the tests that make it a control.

  it('refuses a direct write with no transaction context', async () => {
    const id = await proposedDecision();
    await expect(
      withTransaction(h.pool, async (tx) => {
        await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
        await tx.query(
          'update core.object set lifecycle_state = $2, row_version = row_version + 1 where id = $1',
          [id, 'accepted'],
        );
      }),
    ).rejects.toThrow(/no transaction context/);
  });

  it('refuses a lifecycle change with a context but no action', async () => {
    const id = await proposedDecision();
    await expect(
      withTransaction(h.pool, async (tx) => {
        await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
        // Context set, action id deliberately null: an actor is named, but nothing
        // authorized the move.
        await tx.query('select core.set_transaction_context($1, $1, null, $2)', [
          f.reviewerId,
          'bypass-attempt',
        ]);
        await tx.query(
          'update core.object set lifecycle_state = $2, row_version = row_version + 1 where id = $1',
          [id, 'accepted'],
        );
      }),
    ).rejects.toThrow(/requires an action/);
  });

  it('refuses a lifecycle move the acting action does not permit', async () => {
    // A real action, applied to a transition it does not drive. The trigger checks the move
    // against THIS action, not against "some action somewhere permits it".
    const id = await proposedDecision();
    const applied = await execute({
      actionType: 'accept_decision',
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      targetIds: [id],
      idempotencyKey: key(),
      organizationId: f.organizationId,
      maxClassification: 'restricted',
    });

    const other = await proposedDecision();
    await expect(
      withTransaction(h.pool, async (tx) => {
        await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
        await tx.query('select core.set_transaction_context($1, $1, $2, $3)', [
          f.reviewerId,
          applied.actionId,
          'wrong-transition',
        ]);
        // accept_decision drives proposed -> accepted, never proposed -> withdrawn.
        await tx.query(
          'update core.object set lifecycle_state = $2, row_version = row_version + 1 where id = $1',
          [other, 'withdrawn'],
        );
      }),
    ).rejects.toThrow(/cannot move decision_record from proposed to withdrawn/);
  });

  it('refuses a silent update that does not advance row_version', async () => {
    const id = await proposedDecision();
    await expect(
      withTransaction(h.pool, async (tx) => {
        await bindContext(tx, f);
        await tx.query('update core.object set title = $2 where id = $1', [id, 'Renamed']);
      }),
    ).rejects.toThrow(/row_version must advance/);
  });

  it('refuses two different actors in one transaction', async () => {
    // Otherwise one transaction could commit two actions attributed to two people, and the
    // audit trail would be true row by row and false as a whole.
    await expect(
      withTransaction(h.pool, async (tx) => {
        await tx.query('select core.set_transaction_context($1, $1, null, $2)', [
          f.reviewerId,
          'first',
        ]);
        await tx.query('select core.set_transaction_context($1, $1, null, $2)', [
          f.performerId,
          'second',
        ]);
      }),
    ).rejects.toThrow(/already set to a different actor/);
  });
});

describe('function privileges', () => {
  it('does not let a reader declare itself an actor', async () => {
    // PostgreSQL grants EXECUTE to PUBLIC by default, so without an explicit revoke a
    // read-only connection could name any actor it liked.
    const rows = await withTransaction(h.adminPool, async (tx) =>
      tx.query<{ readonly_can_set_actor: boolean; auditor_can_set_actor: boolean }>(
        `select
           has_function_privilege('kf_readonly',
             'core.set_transaction_context(uuid,uuid,uuid,text)', 'execute') as readonly_can_set_actor,
           has_function_privilege('kf_auditor',
             'core.set_transaction_context(uuid,uuid,uuid,text)', 'execute') as auditor_can_set_actor`,
      ),
    );
    expect(rows[0]!.readonly_can_set_actor).toBe(false);
    expect(rows[0]!.auditor_can_set_actor).toBe(false);
  });

  it('lets kf_backup read what pg_dump needs', async () => {
    // Its whole job is pg_dump. It had schema USAGE and no SELECT, so a backup would have
    // failed on the first table — a fault that stays invisible until the day it is needed.
    const rows = await withTransaction(h.adminPool, async (tx) =>
      tx.query<{ core: boolean; registry: boolean; org: boolean }>(
        `select has_table_privilege('kf_backup','core.object','select') as core,
                has_table_privilege('kf_backup','registry.object_type','select') as registry,
                has_table_privilege('kf_backup','org.person','select') as org`,
      ),
    );
    expect(rows[0]).toEqual({ core: true, registry: true, org: true });
  });
});

describe('a blocked statement and a slow statement fail differently', () => {
  // `statement_timeout` alone cannot tell "waiting for a lock" from "running too long": both
  // arrive as one aborted statement with one message. That ambiguity cost a real diagnosis —
  // the document-dogfood CI flake (#156) is a `count(*)` over tables holding under twenty rows,
  // and its log cannot say whether it was blocked or starved. `lock_timeout` splits them.
  //
  // Asserting on SQLSTATE rather than message text: the codes are contract, the prose is not.
  const LOCK_NOT_AVAILABLE = '55P03';
  const QUERY_CANCELED = '57014';

  const sqlstate = (error: unknown): string | undefined =>
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: string }).code
      : undefined;

  it('applies lock_timeout to the session at all — pg could have dropped it silently', async () => {
    // `pg` accepts unknown PoolConfig keys without complaint, so a typo or an unsupported
    // option produces a pool that looks configured and enforces nothing. Read it back from
    // the server, which is the only party whose opinion counts.
    const pool = createPool({
      connectionString: h.connectionString,
      lockTimeoutMillis: 1_000,
      statementTimeoutMillis: 20_000,
    });
    try {
      const shown = await pool.query<{ lock_timeout: string; statement_timeout: string }>(
        'show lock_timeout',
      );
      expect(shown.rows[0]!.lock_timeout).toBe('1s');
    } finally {
      await pool.end();
    }
  });

  it('reports a lock wait as a LOCK timeout, not a statement timeout', async () => {
    const pool = createPool({
      connectionString: h.connectionString,
      lockTimeoutMillis: 1_000,
      statementTimeoutMillis: 20_000,
    });
    const blocker = await h.adminPool.connect();
    try {
      // ACCESS EXCLUSIVE is the one lock class that blocks a bare `count(*)`.
      await blocker.query('begin');
      await blocker.query('lock table core.object in access exclusive mode');

      const started = Date.now();
      await expect(pool.query('select count(*) from core.object')).rejects.toMatchObject({
        code: LOCK_NOT_AVAILABLE,
      });
      // It must give up on the LOCK budget, not sit there until the statement budget. Without
      // this the assertion above would still pass if lock_timeout were ignored and the wait
      // ran the full twenty seconds, which is the failure mode being ruled out.
      //
      // 10x the 1s budget, deliberately loose: the bound only has to separate 1s from 20s, and
      // tightening it towards the budget would trade a real distinction for CI jitter.
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await blocker.query('rollback');
      blocker.release();
      await pool.end();
    }
  });

  it('reports a genuinely slow statement as a STATEMENT timeout, with no lock involved', async () => {
    // The other half of the discriminator. If both conditions produced 55P03 the split would
    // be worthless, so the contrast is asserted rather than assumed.
    const pool = createPool({
      connectionString: h.connectionString,
      lockTimeoutMillis: 1_000,
      statementTimeoutMillis: 1_500,
    });
    try {
      const failure = await pool.query('select pg_sleep(5)').then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(sqlstate(failure)).toBe(QUERY_CANCELED);
      expect(sqlstate(failure)).not.toBe(LOCK_NOT_AVAILABLE);
    } finally {
      await pool.end();
    }
  });

  it('clamps the DEFAULT lock budget under a tight statement budget instead of refusing it', async () => {
    // A caller who sets a short statement budget and no lock budget has written nothing wrong.
    // Refusing that config would be `createPool` inventing an error out of a default the caller
    // never chose — so the default gives way and only an explicit contradiction is refused.
    const pool = createPool({
      connectionString: h.connectionString,
      statementTimeoutMillis: 5_000,
    });
    try {
      const shown = await pool.query<{ lock_timeout: string }>('show lock_timeout');
      expect(shown.rows[0]!.lock_timeout).toBe('4999ms');
    } finally {
      await pool.end();
    }
  });

  it('refuses a lock budget that can never fire', () => {
    // A bound above the statement budget is unreachable: the statement is killed first, every
    // time. That is not a conservative setting, it is a control that reports itself present
    // while enforcing nothing — the exact shape of defect this suite exists to catch.
    expect(() =>
      createPool({
        connectionString: h.connectionString,
        lockTimeoutMillis: 30_000,
        statementTimeoutMillis: 30_000,
      }),
    ).toThrow(/must be below statementTimeoutMillis/);
  });
});
