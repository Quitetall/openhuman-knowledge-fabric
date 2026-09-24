/**
 * ADR 0034 (proposed): an observation is captured in one gesture, and promoted by a separate act.
 *
 * Against a real database, through the fabric dispatcher every surface will use (RQ-203):
 *
 *   1. A person with a live assignment and NO act grant records an observation. The request is
 *      formed by `formObservationRequest` from the gesture alone — no role, key or version is
 *      asked of the person (RQ-200) — and a retried gesture replays rather than capturing twice.
 *   2. The observation reads as unverified (SAS §48A): no verification row, and the evidence
 *      guard treats it as an unverified record.
 *   3. Promotion without an act grant is refused as act_not_granted — capture is cheap,
 *      promotion is institutional.
 *   4. Promotion by somebody holding act authority, composed in ONE transaction with the create
 *      act of the record it becomes, cites the observation (`derived_from`).
 *   5. Withdrawal is a lifecycle move, and a withdrawn observation cannot then be promoted.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActionRejected } from '@kf/actions';
import { withTransaction } from '@kf/database';
import { createFabricDispatcher, createFabricTransactionalDispatcher } from '@kf/orchestrator';
import { formObservationRequest } from '@kf/work-control';
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
let execute: ReturnType<typeof createFabricDispatcher>;
let subject: string;
let observation: string;
/**
 * A person whose one live assignment is scoped to a project. Every role assignment is read AND
 * act authority at its scope (20260902000100), so an organization-scoped fixture person holds act
 * over everything in it; this one holds act over the project and nothing else — in particular,
 * not over an observation it captures. That is the person ADR 0034 is about.
 */
let noter: { personId: string; roleId: string };

async function projectScopedNoter(): Promise<{ personId: string; roleId: string }> {
  const project = await createObject(h.adminPool, f, {
    type: 'initiative_project',
    domain: 'project',
    state: 'captured',
    title: 'Front-end bench work',
    createdBy: f.reviewerId,
  });
  const personId = await createObject(h.adminPool, f, {
    type: 'person',
    domain: 'organization',
    state: 'active',
    title: 'Bench engineer',
    createdBy: f.reviewerId,
  });
  const roleId = await createObject(h.adminPool, f, {
    type: 'role_assignment',
    domain: 'organization',
    state: 'active',
    title: 'performer on the bench project',
    createdBy: f.reviewerId,
  });
  await withTransaction(h.adminPool, async (tx) => {
    await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
    await tx.query('select core.set_transaction_context($1, $1, $2, $3)', [
      f.reviewerId,
      f.clearanceActionId,
      'observation-fixture',
    ]);
    await tx.query('insert into org.person (id, display_name, organization) values ($1, $2, $3)', [
      personId,
      'Bench engineer',
      f.organizationId,
    ]);
    await tx.query(
      `insert into org.role_assignment (id, subject_id, role_id, scope_id, valid_to)
       values ($1, $2, 'performer', $3, now() + interval '1 year')`,
      [roleId, personId, project],
    );
    await tx.query(
      `insert into org.person_clearance
         (subject_id, organization_id, max_classification, granted_by, granted_by_action, reason)
       values ($1, $2, 'restricted', $3, $4, 'observation fixture clearance')`,
      [personId, f.organizationId, f.reviewerId, f.clearanceActionId],
    );
  });
  return { personId, roleId };
}

const capture = (gestureId: string, body: string, subjects: string[] = []) =>
  formObservationRequest({
    organizationId: f.organizationId,
    actorId: noter.personId,
    liveAssignmentIds: [noter.roleId],
    gestureId,
    body,
    subjects,
    tags: ['bench', 'eeg-front-end'],
    maxClassification: 'restricted',
  });

const stateOf = (id: string) =>
  withTransaction(
    h.adminPool,
    async (tx) =>
      (
        await tx.one<{ lifecycle_state: string }>(
          'select lifecycle_state from core.object where id = $1',
          [id],
        )
      ).lifecycle_state,
  );

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  execute = createFabricDispatcher(h.pool);
  subject = await createObject(h.adminPool, f, {
    type: 'decision_record',
    domain: 'engineering',
    state: 'draft',
    title: 'Front-end board rev B',
    createdBy: f.reviewerId,
  });
  noter = await projectScopedNoter();
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

describe('capture is cheap (ADR 0034 §2, RQ-200)', () => {
  it('the noter holds no act grant over the organization — the premise of what follows', async () => {
    const reaches = await withTransaction(h.adminPool, async (tx) =>
      tx.one<{ ok: boolean }>('select org.act_grant_reaches($1, $2, $3::uuid[]) as ok', [
        noter.personId,
        f.organizationId,
        [f.organizationId],
      ]),
    );
    expect(reaches.ok).toBe(false);
  });

  it('records an observation for a person with a live assignment and no act grant', async () => {
    const request = capture(
      'gesture-0001',
      'Channel 3 noise floor 2.1 µV RMS at 250 Hz.\nBoard B.',
      [subject],
    );
    // Everything the person did not supply was formed: the assignment, the key, no version.
    expect(request.actingRoleId).toBe(noter.roleId);
    expect(request.idempotencyKey).toMatch(/^observation:gesture-0001:[0-9a-f]{64}$/);
    expect(request.expectedVersion).toBeUndefined();

    const result = await execute(request);
    observation = result.objectIds[0]!;
    expect(await stateOf(observation)).toBe('captured');

    const row = await withTransaction(h.adminPool, async (tx) =>
      tx.one<{ title: string; body: string; tags: string[]; concerns: string[]; by: string }>(
        `select o.title, x.body, x.tags, o.created_by as by,
                array(select r.target_id::text from core.relation r
                       where r.source_id = o.id and r.relation_type = 'concerns') as concerns
           from core.object o join content.observation x on x.id = o.id where o.id = $1`,
        [observation],
      ),
    );
    expect(row.title).toBe('Channel 3 noise floor 2.1 µV RMS at 250 Hz.');
    expect(row.tags).toEqual(['bench', 'eeg-front-end']);
    expect(row.concerns).toEqual([subject]);
    expect(row.by).toBe(noter.personId);
  });

  it('replays a retried gesture instead of capturing twice', async () => {
    const again = await execute(
      capture('gesture-0001', 'Channel 3 noise floor 2.1 µV RMS at 250 Hz.\nBoard B.', [subject]),
    );
    expect(again.replayed).toBe(true);
    expect(again.objectIds).toEqual([observation]);
  });

  it('refuses to guess an assignment when the caller holds several and named none', () => {
    expect(() =>
      formObservationRequest({
        organizationId: f.organizationId,
        actorId: f.reviewerId,
        liveAssignmentIds: [f.reviewerRoleId, f.performerRoleId],
        gestureId: 'gesture-0002',
        body: 'x',
        maxClassification: 'restricted',
      }),
    ).toThrow(ActionRejected);
  });
});

describe('an observation is unverified until somebody verifies it (SAS §48A)', () => {
  it('has no verification, and the evidence guard reads it as an unverified record', async () => {
    const read = await withTransaction(h.pool, async (tx) => {
      await bindContext(tx, f, f.reviewerId);
      return tx.one<{ verified: boolean; unverified_record: boolean }>(
        `select exists (select 1 from core.object_verification where object_id = $1) as verified,
                work.evidence_ref_is_unverified_record($1::text) as unverified_record`,
        [observation],
      );
    });
    expect(read).toEqual({ verified: false, unverified_record: true });
  });
});

describe('promotion is institutional (ADR 0034 §4)', () => {
  it('refuses promotion to somebody with no act grant', async () => {
    await expect(
      execute({
        organizationId: f.organizationId,
        actorId: noter.personId,
        actingRoleId: noter.roleId,
        maxClassification: 'restricted',
        idempotencyKey: 'promote-no-grant',
        actionType: 'promote_observation',
        targetIds: [observation],
      }),
    ).rejects.toMatchObject({ failure: 'act_not_granted' });
    expect(await stateOf(observation)).toBe('captured');
  });

  it('promotes, in one transaction with the create act of the record it becomes, citing it', async () => {
    const inTransaction = createFabricTransactionalDispatcher();
    const requirement = await withTransaction(h.pool, async (tx) => {
      const created = await inTransaction(tx, {
        organizationId: f.organizationId,
        actorId: f.reviewerId,
        actingRoleId: f.reviewerRoleId,
        maxClassification: 'restricted',
        idempotencyKey: 'promote-requirement',
        actionType: 'define_requirement',
        targetIds: [],
        payload: {
          title: 'Channel noise floor',
          statement: 'Input-referred noise SHALL NOT exceed 3 µV RMS in 0.5-100 Hz.',
          requirement_kind: 'system',
        },
      });
      await inTransaction(tx, {
        organizationId: f.organizationId,
        actorId: f.reviewerId,
        actingRoleId: f.reviewerRoleId,
        maxClassification: 'restricted',
        idempotencyKey: 'promote-observation',
        actionType: 'promote_observation',
        targetIds: [observation],
        payload: { promoted_to: [created.objectIds[0]!] },
      });
      return created.objectIds[0]!;
    });
    expect(await stateOf(observation)).toBe('promoted');
    const cited = await withTransaction(h.adminPool, async (tx) =>
      tx.maybeOne<{ ok: number }>(
        `select 1 as ok from core.relation
          where relation_type = 'derived_from' and source_id = $1 and target_id = $2`,
        [requirement, observation],
      ),
    );
    expect(cited).toEqual({ ok: 1 });
  });
});

describe('withdrawal', () => {
  it('withdraws a captured observation, which then cannot be promoted', async () => {
    const withdrawn = (await execute(capture('gesture-0003', 'Mislabelled trace; ignore.')))
      .objectIds[0]!;
    await execute({
      organizationId: f.organizationId,
      actorId: noter.personId,
      actingRoleId: noter.roleId,
      maxClassification: 'restricted',
      idempotencyKey: 'withdraw-0003',
      actionType: 'withdraw_observation',
      targetIds: [withdrawn],
    });
    expect(await stateOf(withdrawn)).toBe('withdrawn');
    await expect(
      execute({
        organizationId: f.organizationId,
        actorId: f.reviewerId,
        actingRoleId: f.reviewerRoleId,
        maxClassification: 'restricted',
        idempotencyKey: 'promote-withdrawn',
        actionType: 'promote_observation',
        targetIds: [withdrawn],
      }),
    ).rejects.toMatchObject({ failure: 'illegal_transition' });
  });
});
