/**
 * Agent tools: eight reads and one rehearsal.
 *
 * The property under test is the one the whole design rests on — an agent can find out what
 * WOULD happen and cannot make it happen. So the rehearsal tests do not stop at "it reported
 * success": they check the database afterwards, because a rehearsal that reports success and
 * also commits is worse than no rehearsal at all.
 *
 * The second property is scope. An agent reads as the person it acts for, never as itself and
 * never as a convenient superset "for context". Every tool is checked against a record the
 * caller may not see.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDispatcher } from '@kf/actions';
import { withTransaction } from '@kf/database';
import {
  AGENT_TOOLS,
  availableActions,
  evidenceFor,
  externalCitations,
  findRecords,
  readHistory,
  readRecord,
  rehearseAction,
  traceRelations,
  verificationOf,
  type AgentScope,
} from '@kf/agent-tools';
import { indexObject } from '@kf/search';
import { WORK_CONTROL_MATERIALIZERS, WORK_CONTROL_PRECONDITIONS } from '@kf/work-control';
import {
  bindContext,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from '../database/harness.js';

let h: Harness;
let f: Fixtures;
let decision: string;
let restrictedRecord: string;
let successor: string;

const DISPATCHER = {
  materializers: WORK_CONTROL_MATERIALIZERS,
  preconditions: WORK_CONTROL_PRECONDITIONS,
};

function scope(maxClassification = 'restricted'): AgentScope {
  return {
    organizationId: f.organizationId,
    maxClassification,
    actorId: f.reviewerId,
    actingRoleId: f.reviewerRoleId,
  };
}

async function stateOf(id: string): Promise<string> {
  return withTransaction(h.adminPool, async (tx) => {
    const row = await tx.one<{ lifecycle_state: string }>(
      'select lifecycle_state from core.object where id = $1',
      [id],
    );
    return row.lifecycle_state;
  });
}

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);

  decision = await createObject(h.adminPool, f, {
    type: 'decision_record',
    domain: 'engineering',
    state: 'proposed',
    title: 'Adopt the 10 kOhm series resistor',
    createdBy: f.performerId,
  });
  successor = await createObject(h.adminPool, f, {
    type: 'decision_record',
    domain: 'engineering',
    state: 'proposed',
    title: 'Revisit the resistor value for gen 3',
    createdBy: f.performerId,
  });

  restrictedRecord = await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f);
    const { version } = await tx.one<{ version: string }>(
      'select version from registry.schema_release where is_current',
    );
    const row = await tx.one<{ id: string }>(
      `insert into core.object
         (object_type, authority_domain, lifecycle_state, classification, retention_class,
          schema_version, organization_id, title, created_by, updated_by)
       values ('decision_record','engineering','proposed','restricted','project_record',
               $1,$2,'Contractor rate for the resistor rework',$3,$3)
       returning id`,
      [version, f.organizationId, f.performerId],
    );
    return row.id;
  });

  await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f);
    await tx.query(
      `insert into core.relation (relation_type, source_id, target_id, created_by)
       values ('supersedes', $1, $2, $3)`,
      [successor, decision, f.performerId],
    );
    for (const id of [decision, successor, restrictedRecord]) await indexObject(tx, id);
  });
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

describe('the tool set', () => {
  it('is nine tools, eight of which only read', () => {
    // The count is the safety argument, so it is asserted rather than described. A tenth
    // tool that acts would be a decision somebody must make deliberately.
    expect(AGENT_TOOLS).toHaveLength(9);
    expect(AGENT_TOOLS.filter((t) => t === 'rehearse_action')).toHaveLength(1);
  });
});

describe('reading', () => {
  it('finds, reads, and traces', async () => {
    const hits = await findRecords(h.pool, scope(), { text: 'resistor' });
    expect(hits.map((x) => x.objectId)).toContain(decision);

    const record = await readRecord(h.pool, scope(), decision);
    expect(record?.title).toBe('Adopt the 10 kOhm series resistor');

    const edges = await traceRelations(h.pool, scope(), successor);
    expect(edges.map((e) => e.toId)).toContain(decision);
    expect(edges[0]!.relationType).toBe('supersedes');
  });

  it('bounds a traversal no matter what depth is asked for', async () => {
    // An unbounded walk over a cyclic graph is a way to make the database do arbitrary work
    // on request.
    const edges = await traceRelations(h.pool, scope(), successor, { maxDepth: 10_000 });
    expect(edges.every((e) => e.depth <= 6)).toBe(true);
  });

  it('reports verification as unverified-with-no-evidence, not as absent', async () => {
    // An absent row reads as "no problems found" in any left join, which is how "we never
    // tested it" turns into a pass.
    const status = await verificationOf(h.pool, scope(), decision);
    expect(status).toEqual({
      subjectId: decision,
      verified: false,
      approvedDefinitions: 0,
      definitionsPassed: 0,
      failed: 0,
      invalidated: 0,
      unexecuted: 0,
    });
  });

  it('returns evidence as digests and identity, never bytes', async () => {
    const evidence = await evidenceFor(h.pool, scope(), decision);
    // No content field exists to return. An agent that can stream the evidence vault is an
    // exfiltration path with a friendly name.
    for (const item of evidence) {
      expect(Object.keys(item)).not.toContain('content');
      expect(Object.keys(item)).not.toContain('bytes');
    }
  });

  it('returns no citations for a record that cites nothing', async () => {
    expect(await externalCitations(h.pool, scope(), decision)).toEqual([]);
  });
});

describe('scope: an agent sees what its principal sees', () => {
  it('hides a restricted record from an internal-only agent', async () => {
    expect(await readRecord(h.pool, scope('internal'), restrictedRecord)).toBeUndefined();
    expect(await readRecord(h.pool, scope('restricted'), restrictedRecord)).toBeDefined();
  });

  it('hides its HISTORY too, not just the record', async () => {
    // Action names alone leak most of what a record is. Returning history for a record the
    // caller cannot read would be a disclosure through the side door.
    expect(await readHistory(h.pool, scope('internal'), restrictedRecord)).toEqual([]);
  });

  it('hides what can be DONE to it', async () => {
    expect(await availableActions(h.pool, scope('internal'), restrictedRecord)).toEqual([]);
    expect(
      (await availableActions(h.pool, scope('restricted'), restrictedRecord)).length,
    ).toBeGreaterThan(0);
  });

  it('hides it from search, and from verification', async () => {
    const hits = await findRecords(h.pool, scope('internal'), { text: 'contractor rate' });
    expect(hits.map((x) => x.objectId)).not.toContain(restrictedRecord);
    expect(await verificationOf(h.pool, scope('internal'), restrictedRecord)).toBeUndefined();
  });
});

describe('rehearsal: says what would happen, and does not do it', () => {
  it('reports the move a legal action would make', async () => {
    const before = await stateOf(decision);
    const outcome = await rehearseAction(
      h.pool,
      scope(),
      {
        actionType: 'accept_decision',
        targetIds: [decision],
        idempotencyKey: 'rehearse-accept-0001',
      },
      DISPATCHER,
    );

    expect(outcome.wouldSucceed).toBe(true);
    expect(outcome.wouldMove).toEqual([{ objectId: decision, from: 'proposed', to: 'accepted' }]);
    // AND THE RECORD DID NOT MOVE. This is the assertion the design exists for.
    expect(await stateOf(decision)).toBe(before);
  });

  it('leaves no action, no audit event and no outbox row behind', async () => {
    const before = await withTransaction(h.adminPool, async (tx) =>
      tx.one<{ actions: string; events: string; outbox: string }>(
        `select (select count(*) from core.action)::text as actions,
                (select count(*) from core.audit_event)::text as events,
                (select count(*) from core.outbox)::text as outbox`,
      ),
    );

    await rehearseAction(
      h.pool,
      scope(),
      {
        actionType: 'accept_decision',
        targetIds: [decision],
        idempotencyKey: 'rehearse-accept-0002',
      },
      DISPATCHER,
    );

    const after = await withTransaction(h.adminPool, async (tx) =>
      tx.one<{ actions: string; events: string; outbox: string }>(
        `select (select count(*) from core.action)::text as actions,
                (select count(*) from core.audit_event)::text as events,
                (select count(*) from core.outbox)::text as outbox`,
      ),
    );
    // A rehearsal that left an audit event would put an action in the record that nobody
    // performed — and the chain would carry it forever.
    expect(after).toEqual(before);
  });

  it('does not burn the idempotency key it rehearsed with', async () => {
    // If it did, the real attempt afterwards would REPLAY the rehearsal's result and do
    // nothing — the quietest possible way for an agent to prevent work.
    const key = 'rehearse-then-do-001';
    await rehearseAction(
      h.pool,
      scope(),
      { actionType: 'accept_decision', targetIds: [decision], idempotencyKey: key },
      DISPATCHER,
    );

    const execute = createDispatcher(h.pool, DISPATCHER);
    const real = await execute({
      actionType: 'accept_decision',
      targetIds: [decision],
      idempotencyKey: key,
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      organizationId: f.organizationId,
      maxClassification: 'restricted',
    });
    expect(real.replayed).toBe(false);
    expect(await stateOf(decision)).toBe('accepted');
  });

  it('reports a refusal with the same code the API would return', async () => {
    // The decision is now `accepted`, so this is genuinely illegal rather than contrived.
    const outcome = await rehearseAction(
      h.pool,
      scope(),
      {
        actionType: 'accept_decision',
        targetIds: [decision],
        idempotencyKey: 'rehearse-illegal-001',
      },
      DISPATCHER,
    );
    expect(outcome.wouldSucceed).toBe(false);
    expect(outcome.refusal?.failure).toBe('illegal_transition');
    expect(outcome.wouldMove).toEqual([]);
  });

  it('rehearses a CREATING action without creating anything', async () => {
    const before = await withTransaction(h.adminPool, async (tx) =>
      tx.one<{ n: string }>('select count(*)::text as n from core.object'),
    );

    const outcome = await rehearseAction(
      h.pool,
      scope(),
      {
        actionType: 'create_initiative',
        targetIds: [],
        idempotencyKey: 'rehearse-create-0001',
        payload: {
          title: 'A project that must not exist afterwards',
          objective: 'Prove the rehearsal cannot commit.',
          sponsor_id: f.reviewerId,
        },
      },
      DISPATCHER,
    );
    expect(outcome.wouldSucceed).toBe(true);
    expect(outcome.wouldCreate).toBe(1);

    const after = await withTransaction(h.adminPool, async (tx) =>
      tx.one<{ n: string }>('select count(*)::text as n from core.object'),
    );
    // The materializer ran, the object existed inside the transaction, and it is gone.
    expect(after.n).toBe(before.n);
  });

  it('is refused by the same scope everything else is', async () => {
    const outcome = await rehearseAction(
      h.pool,
      scope('internal'),
      {
        actionType: 'accept_decision',
        targetIds: [restrictedRecord],
        idempotencyKey: 'rehearse-scope-0001',
      },
      DISPATCHER,
    );
    // Not visible and not existing are the same answer here too.
    expect(outcome.wouldSucceed).toBe(false);
    expect(outcome.refusal?.failure).toBe('object_not_visible');
  });
});
