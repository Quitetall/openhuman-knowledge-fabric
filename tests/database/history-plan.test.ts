import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDispatcher, OBJECT_HISTORY_SQL } from '@kf/actions';
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
 * An object's history is read by index, not by walking the ledger (OBJECT_HISTORY_SQL,
 * @kf/actions; the history facet of every object view and `/objects/:id/history`).
 *
 * The query read every audit event and ran a subquery on `core.action.target_ids` per row, so one
 * object's history cost O(ledger). Measured here the way that matters: the shared buffers the plan
 * touches for one object, before and after ten thousand UNRELATED acts join the ledger. An
 * index-driven plan reads the same few pages either way; the old one read every page it added.
 */

let h: Harness;
let f: Fixtures;
let subject: string;
let other: string;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Shared Hit Blocks': number;
  'Shared Read Blocks': number;
  'Actual Rows': number;
  Plans?: PlanNode[];
}

function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

/** The plan and rows of one object's history, as the application reads it (row security on). */
async function measured(
  objectId: string,
): Promise<{ buffers: number; plan: PlanNode; rows: number }> {
  return withTransaction(h.pool, async (tx) => {
    await bindContext(tx, f, f.reviewerId);
    const rows = await tx.query(OBJECT_HISTORY_SQL, [objectId]);
    const explained = await tx.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
      `explain (analyze, buffers, format json) ${OBJECT_HISTORY_SQL}`,
      [objectId],
    );
    const plan = explained[0]!['QUERY PLAN'][0].Plan;
    return {
      buffers: plan['Shared Hit Blocks'] + plan['Shared Read Blocks'],
      plan,
      rows: rows.length,
    };
  });
}

/** Append `count` acts that target somebody else, one audit event each, bypassing the dispatcher. */
async function growLedger(count: number): Promise<void> {
  await withTransaction(h.adminPool, async (tx) => {
    // Owner fixture rows: the chain, triggers and guards are not what is measured here, and ten
    // thousand dispatched acts would take minutes. Every row is shaped from a real one.
    await tx.query('set local session_replication_role = replica');
    const template = await tx.one<{ action_id: string }>(
      'select action_id from core.audit_event where object_id = $1 order by seq limit 1',
      [other],
    );
    await tx.query(
      `with source_action as (select * from core.action where id = $1),
            source_event as (select * from core.audit_event where action_id = $1 limit 1),
            acts as (
              insert into core.action
              select (jsonb_populate_record(null::core.action, to_jsonb(s) || jsonb_build_object(
                        'id', uuidv7(),
                        'idempotency_key', 'history-plan-' || g || '-' || gen_random_uuid(),
                        'request_digest', encode(sha256(gen_random_uuid()::text::bytea), 'hex'),
                        'target_ids', array[gen_random_uuid()]))).*
                from source_action s, generate_series(1, $2) g
              returning id)
       insert into core.audit_event
       select (jsonb_populate_record(null::core.audit_event, to_jsonb(e) || jsonb_build_object(
                 'seq', nextval(pg_get_serial_sequence('core.audit_event', 'seq')),
                 'id', uuidv7(),
                 'action_id', acts.id,
                 'object_id', null,
                 'digest', encode(sha256(acts.id::text::bytea), 'hex')))).*
         from acts, source_event e`,
      [template.action_id, count],
    );
    await tx.query('analyze core.action');
    await tx.query('analyze core.audit_event');
  });
}

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  const execute = createDispatcher(h.pool);
  const decision = (title: string) =>
    createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'proposed',
      title,
      createdBy: f.performerId,
    });
  subject = await decision('The record whose history is read');
  other = await decision('Somebody else');
  for (const [id, key] of [
    [subject, 'history-plan-subject-aaaaaaaa'],
    [other, 'history-plan-other-aaaaaaaa'],
  ] as const) {
    await execute({
      actionType: 'accept_decision',
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      targetIds: [id],
      idempotencyKey: key,
      organizationId: f.organizationId,
      maxClassification: 'restricted',
    });
  }
  await growLedger(1_000);
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe('an object history', () => {
  it('reads the same pages however many unrelated acts the ledger holds', async () => {
    const before = await measured(subject);
    expect(before.rows).toBeGreaterThan(0);

    await growLedger(10_000);
    const after = await measured(subject);

    expect(after.rows).toBe(before.rows);
    // Ten times the unrelated ledger; an O(ledger) plan reads hundreds of pages more.
    expect(
      after.buffers,
      `buffers ${before.buffers} -> ${after.buffers}\n${JSON.stringify(after.plan, null, 1)}`,
    ).toBeLessThanOrEqual(before.buffers + 8);
    // And no node walks either ledger table end to end.
    const scans = nodes(after.plan)
      .filter((node) => node['Node Type'] === 'Seq Scan')
      .map((node) => node['Relation Name']);
    expect(scans).not.toContain('audit_event');
    expect(scans).not.toContain('action');
  }, 240_000);
});
