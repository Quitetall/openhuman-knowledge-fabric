import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryObjectStore } from '@kf/artifacts';
import { withTransaction } from '@kf/database';
import { createDocumentActionAtoms } from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
import {
  bindContext,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

/**
 * An engagement has a lifecycle (ontology/state-machines.yaml `engagement`).
 *
 * R01 declared the five states and no transitions, so an engagement `record_engagement` made
 * stayed in `draft` for ever. Each transition is walked through a dispatched act, and the ones the
 * machine does not declare are refused.
 */

let h: Harness;
let f: Fixtures;
let execute: ReturnType<typeof createFabricDispatcher>;
let counterparty: string;

async function act(
  actionType: string,
  targetIds: readonly string[],
  payload: Record<string, unknown> = {},
) {
  return execute({
    actionType,
    actorId: f.reviewerId,
    actingRoleId: f.reviewerRoleId,
    organizationId: f.organizationId,
    maxClassification: 'restricted',
    targetIds: [...targetIds],
    idempotencyKey: `engagement-${actionType}-${randomUUID()}`,
    payload: payload as never,
  });
}

async function stateOf(id: string): Promise<string> {
  const row = await withTransaction(h.adminPool, (tx) =>
    tx.one<{ lifecycle_state: string }>('select lifecycle_state from core.object where id = $1', [
      id,
    ]),
  );
  return row.lifecycle_state;
}

async function recorded(): Promise<string> {
  const result = await act('record_engagement', [], {
    title: `Engagement ${randomUUID().slice(0, 8)}`,
    counterparty,
    engagement_kind: 'contractor',
    starts_on: '2026-10-01',
  });
  expect(result.status, JSON.stringify(result)).toBe('applied');
  return result.objectIds[0]!;
}

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  execute = createFabricDispatcher(
    h.pool,
    createDocumentActionAtoms({
      store: new InMemoryObjectStore(),
      parser: {
        async parse() {
          return undefined;
        },
      },
    }),
  );
  counterparty = await createObject(h.adminPool, f, {
    type: 'organization',
    domain: 'organization',
    state: 'active',
    title: 'Contractor Ltd',
    createdBy: f.reviewerId,
  });
  await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f, f.reviewerId);
    await tx.query(
      `insert into org.organization (id, legal_name, organization_kind)
       values ($1, $2, 'supplier')`,
      [counterparty, `Contractor Ltd (${counterparty})`],
    );
  });
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe('the engagement lifecycle', () => {
  it('is born in draft and runs draft → active → suspended → active → closed', async () => {
    const id = await recorded();
    expect(await stateOf(id)).toBe('draft');
    for (const [actionType, state] of [
      ['activate_engagement', 'active'],
      ['suspend_engagement', 'suspended'],
      ['resume_engagement', 'active'],
      ['close_engagement', 'closed'],
    ] as const) {
      const result = await act(actionType, [id]);
      expect(result.status, `${actionType}: ${JSON.stringify(result)}`).toBe('applied');
      expect(await stateOf(id)).toBe(state);
    }
  });

  it('terminates a draft that was never taken up, and a suspended engagement', async () => {
    const draft = await recorded();
    expect((await act('terminate_engagement', [draft])).status).toBe('applied');
    expect(await stateOf(draft)).toBe('terminated');

    const suspended = await recorded();
    await act('activate_engagement', [suspended]);
    await act('suspend_engagement', [suspended]);
    expect((await act('terminate_engagement', [suspended])).status).toBe('applied');
    expect(await stateOf(suspended)).toBe('terminated');
  });

  it('refuses a transition the machine does not declare, and any from a terminal state', async () => {
    const draft = await recorded();
    await expect(act('close_engagement', [draft])).rejects.toMatchObject({
      failure: expect.any(String),
    });
    expect(await stateOf(draft)).toBe('draft');

    const closed = await recorded();
    await act('activate_engagement', [closed]);
    await act('close_engagement', [closed]);
    for (const actionType of ['activate_engagement', 'resume_engagement', 'terminate_engagement']) {
      await expect(act(actionType, [closed]), actionType).rejects.toMatchObject({
        failure: expect.any(String),
      });
    }
    expect(await stateOf(closed)).toBe('closed');
  });
});

/**
 * KF-ENG-001: an engagement does not end while a work order under it is open, and no order is
 * placed under an engagement that has ended.
 */
describe('an engagement ends after its work orders', () => {
  async function orderUnder(engagement: string): Promise<string> {
    const project = (
      await act('create_initiative', [], {
        title: `Project ${randomUUID().slice(0, 8)}`,
        objective: 'Work under an engagement.',
        sponsor_id: f.reviewerId,
      })
    ).objectIds[0]!;
    const order = await createObject(h.adminPool, f, {
      type: 'work_order',
      domain: 'commercial',
      state: 'draft',
      title: 'Work order',
      createdBy: f.reviewerId,
    });
    await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f, f.reviewerId);
      await tx.query(
        `insert into work.work_order
           (id, project_id, engagement_id, order_number, scope_summary, ceiling_minor, currency)
         values ($1, $2, $3, $4, 'Scope', 1000, 'GBP')`,
        [order, project, engagement, `WO-${randomUUID().slice(0, 8)}`],
      );
    });
    return order;
  }

  it('KF-ENG-001: refuses to close or terminate an engagement while a work order under it is open', async () => {
    const engagement = await recorded();
    await act('activate_engagement', [engagement]);
    const order = await orderUnder(engagement);

    for (const actionType of ['close_engagement', 'terminate_engagement']) {
      await expect(act(actionType, [engagement]), actionType).rejects.toMatchObject({
        failure: 'precondition_failed',
        message: expect.stringMatching(/^KF-ENG-001: .*\(draft\)/),
      });
    }
    expect(await stateOf(engagement)).toBe('active');

    // Once the order is in a terminal state, the engagement can close.
    const cancelled = await execute({
      actionType: 'correct_record',
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      organizationId: f.organizationId,
      maxClassification: 'restricted',
      targetIds: [order],
      reason: 'The order was never issued; cancelling it before the engagement closes.',
      idempotencyKey: `engagement-cancel-order-${randomUUID()}`,
      payload: { to_state: 'cancelled' } as never,
    });
    expect(cancelled.status, JSON.stringify(cancelled)).toBe('applied');
    expect(await stateOf(order)).toBe('cancelled');
    expect((await act('close_engagement', [engagement])).status).toBe('applied');
    expect(await stateOf(engagement)).toBe('closed');
  });

  it('KF-ENG-001: the database refuses the state change and a new order, whatever the caller', async () => {
    // The trigger is the authority: a write that bypasses the act meets it too.
    const engagement = await recorded();
    await act('activate_engagement', [engagement]);
    await orderUnder(engagement);
    await expect(
      withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f, f.reviewerId);
        await tx.query(`update core.object set lifecycle_state = 'terminated' where id = $1`, [
          engagement,
        ]);
      }),
    ).rejects.toThrow(/KF-ENG-001: .* while 1 work order\(s\) under it are open/);
    expect(await stateOf(engagement)).toBe('active');

    const ended = await recorded();
    await act('terminate_engagement', [ended]);
    expect(await stateOf(ended)).toBe('terminated');
    await expect(orderUnder(ended)).rejects.toThrow(
      /KF-ENG-001: engagement .* is terminated; a work order cannot be placed under it/,
    );
  });
});
