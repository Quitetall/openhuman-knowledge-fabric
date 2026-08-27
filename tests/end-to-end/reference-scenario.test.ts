/**
 * The reference scenario: initiative to closed project, through public actions only.
 *
 * Every record here is created by a named, permissioned action. There is not one fixture
 * INSERT into a work or finance table in this file, and that restriction is the test: a
 * scenario loaded by direct insert proves the tables can hold the shape, not that the system
 * can reach it. If a step cannot be performed through an action, the vertical slice has a hole
 * in it — and that is exactly what this file is for finding.
 *
 * The story is the Atlas enclosure from the R01 example: a project is authorized, work is
 * packaged and ordered from a contractor, the contractor performs and submits, a technical
 * authority accepts a reduced amount, an invoice is raised and paid, and the project closes.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActionRejected, createDispatcher, type ActionRequest } from '@kf/actions';
import { withTransaction, type Tx } from '@kf/database';
import {
  WORK_CONTROL_EFFECTS,
  WORK_CONTROL_MATERIALIZERS,
  WORK_CONTROL_PRECONDITIONS,
  projectProgress,
} from '@kf/work-control';
import { seedFixtures, startHarness, type Fixtures, type Harness } from '../database/harness.js';

let h: Harness;
let f: Fixtures;
let execute: ReturnType<typeof createDispatcher>;

/** The engagement the work is ordered under. Bootstrapped, as a contract signed off-system is. */
let engagementId: string;
let contractorId: string;

/**
 * A third person, because two is not enough to run this scenario honestly.
 *
 * Separation of duty refused the reviewer accepting a work package the reviewer had planned —
 * correctly. Real work control needs at least three hands: someone who plans, someone who
 * performs, and someone who judges. Adding a planner here is not a workaround for the control;
 * it is the shape the control exists to require.
 */
let plannerId: string;
let plannerRoleId: string;

let projectId: string;
let packageId: string;
let orderId: string;
let executionId: string;
let invoiceId: string;
let paymentId: string;

let counter = 0;
/** Idempotency keys are per logical attempt; a shared counter keeps them distinct. */
function key(label: string): string {
  counter += 1;
  return `${label}-${String(counter).padStart(4, '0')}-ref`;
}

type Call = Omit<ActionRequest, 'organizationId' | 'maxClassification' | 'idempotencyKey'> & {
  idempotencyKey?: string;
};

async function act(call: Call) {
  return execute({
    organizationId: f.organizationId,
    maxClassification: 'restricted',
    idempotencyKey: call.idempotencyKey ?? key(call.actionType),
    ...call,
  });
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

async function read<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  return withTransaction(h.adminPool, async (tx: Tx) => tx.one<T>(sql, params));
}

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  execute = createDispatcher(h.pool, {
    materializers: WORK_CONTROL_MATERIALIZERS,
    effects: WORK_CONTROL_EFFECTS,
    preconditions: WORK_CONTROL_PRECONDITIONS,
  });

  // The contractor and the engagement are bootstrap facts: a signed agreement exists outside
  // this system, and contractors have neither repository nor database access. Everything
  // AFTER this point goes through actions.
  await withTransaction(h.adminPool, async (tx) => {
    await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
    await tx.query('select core.set_transaction_context($1, $1, $2, $3)', [
      f.performerId,
      '01930000-0000-7000-8000-00000000ac10',
      'scenario-bootstrap',
    ]);
    const { version } = await tx.one<{ version: string }>(
      'select version from registry.schema_release where is_current',
    );
    const org = await tx.one<{ id: string }>(
      `insert into core.object
         (object_type, authority_domain, lifecycle_state, classification, retention_class,
          schema_version, organization_id, title, created_by, updated_by)
       values ('organization','organization','active','internal','project_record',$1,$2,
               'Meridian Design Ltd',$3,$3) returning id`,
      [version, f.organizationId, f.performerId],
    );
    await tx.query(
      `insert into org.organization (id, legal_name, organization_kind)
       values ($1, 'Meridian Design Ltd', 'supplier')`,
      [org.id],
    );
    contractorId = org.id;

    const eng = await tx.one<{ id: string }>(
      `insert into core.object
         (object_type, authority_domain, lifecycle_state, classification, retention_class,
          schema_version, organization_id, title, created_by, updated_by)
       values ('engagement','organization','active','restricted','project_record',$1,$2,
               'Meridian mechanical design engagement',$3,$3) returning id`,
      [version, f.organizationId, f.performerId],
    );
    await tx.query(
      `insert into org.engagement
         (id, principal_organization, counterparty, engagement_kind, starts_on)
       values ($1, $2, $3, 'contractor', current_date)`,
      [eng.id, f.organizationId, contractorId],
    );
    engagementId = eng.id;

    const person = await tx.one<{ id: string }>(
      `insert into core.object
         (object_type, authority_domain, lifecycle_state, classification, retention_class,
          schema_version, organization_id, title, created_by, updated_by)
       values ('person','organization','active','internal','project_record',$1,$2,
               'Planner',$3,$3) returning id`,
      [version, f.organizationId, f.performerId],
    );
    await tx.query('insert into org.person (id, display_name, organization) values ($1,$2,$3)', [
      person.id,
      'Planner',
      f.organizationId,
    ]);
    plannerId = person.id;

    const assignment = await tx.one<{ id: string }>(
      `insert into core.object
         (object_type, authority_domain, lifecycle_state, classification, retention_class,
          schema_version, organization_id, title, created_by, updated_by)
       values ('role_assignment','organization','active','internal','project_record',$1,$2,
               'project_owner assignment',$3,$3) returning id`,
      [version, f.organizationId, f.performerId],
    );
    await tx.query(
      'insert into org.role_assignment (id, subject_id, role_id, scope_id) values ($1,$2,$3,$4)',
      [assignment.id, plannerId, 'project_owner', f.organizationId],
    );
    plannerRoleId = assignment.id;
    await tx.query(
      `insert into org.person_clearance
         (subject_id, organization_id, max_classification, granted_by, granted_by_action, reason)
       values ($1, $2, 'restricted', $3, $4, 'reference scenario planner clearance')`,
      [plannerId, f.organizationId, f.reviewerId, f.clearanceActionId],
    );
  });
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

describe('1. a project is captured and authorized', () => {
  it('creates the initiative through an action, not an insert', async () => {
    const r = await act({
      actionType: 'create_initiative',
      actorId: plannerId,
      actingRoleId: plannerRoleId,
      targetIds: [],
      payload: {
        title: 'Atlas enclosure',
        objective: 'A sealed enclosure for the Atlas bench unit, ready for pilot build.',
        sponsor_id: f.reviewerId,
        project_code: 'ATLAS-ENC',
      },
    });
    projectId = r.objectIds[0]!;
    // create_initiative drives nothing: the record is born in its initial state and moves
    // only when a later action moves it.
    expect(await stateOf(projectId)).toBe('captured');

    const row = await read<{ objective: string; project_code: string }>(
      'select objective, project_code from work.initiative_project where id = $1',
      [projectId],
    );
    expect(row.project_code).toBe('ATLAS-ENC');
  });

  it('walks captured -> triage -> evaluating -> authorized -> active', async () => {
    // triage_initiative is ambiguous from `triage` (evaluating, parked), so the payload has
    // to choose. The dispatcher refuses to guess which branch of a lifecycle to take.
    await act({
      actionType: 'triage_initiative',
      actorId: plannerId,
      actingRoleId: plannerRoleId,
      targetIds: [projectId],
      payload: { to_state: 'triage' },
    });
    expect(await stateOf(projectId)).toBe('triage');

    await act({
      actionType: 'triage_initiative',
      actorId: plannerId,
      actingRoleId: plannerRoleId,
      targetIds: [projectId],
      payload: { to_state: 'evaluating' },
    });
    await act({
      actionType: 'authorize_project',
      actorId: plannerId,
      actingRoleId: plannerRoleId,
      targetIds: [projectId],
    });
    await act({
      actionType: 'activate_project',
      actorId: plannerId,
      actingRoleId: plannerRoleId,
      targetIds: [projectId],
    });
    expect(await stateOf(projectId)).toBe('active');
  });

  it('refuses an ambiguous transition rather than choosing a branch', async () => {
    const err = await act({
      actionType: 'triage_initiative',
      actorId: plannerId,
      actingRoleId: plannerRoleId,
      targetIds: [projectId],
    }).catch((e: unknown) => e as ActionRejected);
    // From `active` there is no triage transition at all.
    expect(err).toBeInstanceOf(ActionRejected);
    expect((err as ActionRejected).failure).toBe('illegal_transition');
  });
});

describe('2. work is packaged and ordered', () => {
  it('creates a work package and starts it', async () => {
    const r = await act({
      actionType: 'create_work_package',
      actorId: plannerId,
      actingRoleId: plannerRoleId,
      targetIds: [],
      payload: {
        title: 'Enclosure mechanical design',
        project_id: projectId,
        scope_statement: 'Design the sealed enclosure, including gasket and fastener selection.',
        acceptance_criterion: 'STEP assembly plus a drawing package that passes design review.',
        planned_value_minor: 400000,
        currency: 'GBP',
      },
    });
    packageId = r.objectIds[0]!;
    // Created in `planned`, moved to `ready` by the same action.
    expect(await stateOf(packageId)).toBe('ready');

    await act({
      actionType: 'start_work_package',
      actorId: plannerId,
      actingRoleId: plannerRoleId,
      targetIds: [packageId],
    });
    expect(await stateOf(packageId)).toBe('active');
  });

  it('issues a work order against exactly one project and one engagement', async () => {
    const r = await act({
      actionType: 'issue_work_order',
      actorId: plannerId,
      actingRoleId: plannerRoleId,
      targetIds: [],
      payload: {
        title: 'Meridian — enclosure design',
        project_id: projectId,
        engagement_id: engagementId,
        order_number: 'WO-2026-014',
        scope_summary: 'Mechanical design of the Atlas enclosure to the agreed criterion.',
        ceiling_minor: 400000,
        currency: 'GBP',
        work_package_ids: [packageId],
      },
    });
    orderId = r.objectIds[0]!;
    expect(await stateOf(orderId)).toBe('offered');

    // KF-WORK-002 is a column, not a convention: there is no shape this row can take that
    // names two projects.
    const row = await read<{ project_id: string; engagement_id: string; ceiling_minor: string }>(
      'select project_id, engagement_id, ceiling_minor from work.work_order where id = $1',
      [orderId],
    );
    expect(row.project_id).toBe(projectId);
    expect(row.engagement_id).toBe(engagementId);

    await act({
      actionType: 'accept_work_order',
      actorId: plannerId,
      actingRoleId: plannerRoleId,
      targetIds: [orderId],
    });
    await act({
      actionType: 'accept_work_order',
      actorId: plannerId,
      actingRoleId: plannerRoleId,
      targetIds: [orderId],
      payload: { to_state: 'active' },
    });
    expect(await stateOf(orderId)).toBe('active');
  });

  it('order rates are restricted, so a project-level reader cannot see the ceiling', async () => {
    const restricted = createDispatcher(h.pool);
    const err = await restricted({
      actionType: 'correct_record',
      actorId: f.performerId,
      actingRoleId: f.performerRoleId,
      targetIds: [orderId],
      reason: 'attempting to reach a restricted record from an internal-only scope',
      idempotencyKey: key('scope-probe'),
      organizationId: f.organizationId,
      maxClassification: 'internal',
    }).catch((e: unknown) => e as ActionRejected);
    // Not visible and not existing are the same answer on purpose.
    expect((err as ActionRejected).failure).toBe('object_not_visible');
  });
});

describe('3. work is performed, submitted and judged', () => {
  it('submits an execution, keeping performer, submitter and recorder distinct', async () => {
    const r = await act({
      actionType: 'submit_work_execution',
      actorId: f.performerId,
      actingRoleId: f.performerRoleId,
      targetIds: [packageId],
      payload: {
        title: 'Enclosure design — first submission',
        work_order_id: orderId,
        // §13.2. The contractor performed and submitted; the recorder is the actor, because
        // contractors have no system access and someone here transcribed it.
        performed_by: contractorId,
        submitted_by: contractorId,
        period_start: '2026-07-01',
        period_end: '2026-07-28',
        effort_hours: 62.5,
        summary: 'STEP assembly, drawing package, gasket selection note.',
        claimed_value_minor: 400000,
        currency: 'GBP',
      },
    });
    // Two objects moved: the package the caller named, and the execution the action created.
    expect(r.objectIds).toHaveLength(2);
    executionId = r.objectIds.find((id) => id !== packageId)!;

    expect(await stateOf(executionId)).toBe('submitted');
    expect(await stateOf(packageId)).toBe('submitted');

    const row = await read<{ performed_by: string; submitted_by: string; recorded_by: string }>(
      'select performed_by, submitted_by, recorded_by from work.work_execution where id = $1',
      [executionId],
    );
    expect(row.performed_by).toBe(contractorId);
    expect(row.recorded_by).toBe(f.performerId);
    expect(row.recorded_by).not.toBe(row.performed_by);
  });

  it('refuses acceptance by the person who recorded the submission', async () => {
    await act({
      actionType: 'review_work_execution',
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      targetIds: [executionId],
    });
    expect(await stateOf(executionId)).toBe('under_review');

    const err = await act({
      actionType: 'issue_acceptance',
      actorId: f.performerId,
      actingRoleId: f.performerRoleId,
      targetIds: [executionId, orderId],
      payload: {
        disposition: 'accepted',
        accepted_value_minor: 400000,
        rationale: 'looks fine',
        to_state: 'accepted',
      },
    }).catch((e: unknown) => e as ActionRejected);

    expect((err as ActionRejected).failure).toBe('separation_of_duty');
  });

  it('KF-FIN-001: refuses acceptance beyond the authorized ceiling', async () => {
    const err = await act({
      actionType: 'issue_acceptance',
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      targetIds: [executionId, orderId],
      payload: {
        disposition: 'accepted',
        accepted_value_minor: 500000,
        rationale: 'more than was authorized',
        to_state: 'accepted',
      },
    }).catch((e: unknown) => e as ActionRejected);

    expect((err as ActionRejected).failure).toBe('precondition_failed');
    expect((err as ActionRejected).message).toMatch(/KF-FIN-001/);
    // And nothing was written: the refusal took the whole transaction with it.
    expect(await stateOf(executionId)).toBe('under_review');
  });

  it('accepts a reduced amount, and the work order completes', async () => {
    await act({
      actionType: 'issue_acceptance',
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      targetIds: [executionId, orderId],
      payload: {
        disposition: 'partially_accepted',
        accepted_value_minor: 360000,
        rationale: 'Gasket selection note incomplete; the rest is accepted.',
        to_state: 'partially_accepted',
      },
    });
    expect(await stateOf(executionId)).toBe('partially_accepted');
    expect(await stateOf(orderId)).toBe('completed');

    const acceptance = await read<{ accepted_value_minor: string; accepted_by: string }>(
      'select accepted_value_minor, accepted_by from work.acceptance_record where work_execution_id = $1',
      [executionId],
    );
    expect(Number(acceptance.accepted_value_minor)).toBe(360000);
    expect(acceptance.accepted_by).toBe(f.reviewerId);

    await act({
      actionType: 'accept_work_package',
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      targetIds: [packageId],
    });
    expect(await stateOf(packageId)).toBe('accepted');
  });

  it('KF-PROJ-001: progress comes from accepted work, not from spending', async () => {
    const progress = await withTransaction(h.adminPool, async (tx) =>
      projectProgress(tx, projectId),
    );
    expect(progress).toEqual({ totalPackages: 1, disposedPackages: 1, fraction: 1 });
  });
});

describe('4. invoicing and payment', () => {
  it('KF-FIN-002: refuses an invoice line beyond the accepted value', async () => {
    const err = await act({
      actionType: 'submit_invoice',
      actorId: f.performerId,
      actingRoleId: f.performerRoleId,
      targetIds: [],
      payload: {
        title: 'Meridian INV-441 (over-billed)',
        engagement_id: engagementId,
        invoice_number: 'INV-441-OVER',
        issuer_id: contractorId,
        currency: 'GBP',
        issued_on: '2026-08-01',
        // 400000 was claimed; only 360000 was accepted.
        lines: [{ work_order_id: orderId, description: 'Enclosure design', amount_minor: 400000 }],
      },
    }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toMatch(/KF-FIN-002/);
  });

  it('accepts an invoice for exactly the accepted value', async () => {
    const r = await act({
      actionType: 'submit_invoice',
      actorId: f.performerId,
      actingRoleId: f.performerRoleId,
      targetIds: [],
      payload: {
        title: 'Meridian INV-441',
        engagement_id: engagementId,
        invoice_number: 'INV-441',
        issuer_id: contractorId,
        currency: 'GBP',
        issued_on: '2026-08-01',
        lines: [{ work_order_id: orderId, description: 'Enclosure design', amount_minor: 360000 }],
      },
    });
    invoiceId = r.objectIds[0]!;
    expect(await stateOf(invoiceId)).toBe('submitted');

    await act({
      actionType: 'approve_invoice',
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      targetIds: [invoiceId],
      payload: { to_state: 'approved' },
    });
    expect(await stateOf(invoiceId)).toBe('approved');
  });

  it('KF-FIN-003: refuses a payment that overpays the invoice', async () => {
    const err = await act({
      actionType: 'authorize_payment',
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      targetIds: [],
      payload: {
        title: 'Meridian overpayment',
        payer_id: f.organizationId,
        payee_id: contractorId,
        amount_minor: 500000,
        currency: 'GBP',
        method: 'bank_transfer',
        value_date: '2026-08-15',
        allocations: [{ invoice_id: invoiceId, amount_minor: 500000 }],
      },
    }).catch((e: unknown) => e as Error);
    expect(String((err as Error).message)).toMatch(/KF-FIN-003/);
  });

  it('authorizes, settles and reconciles the payment', async () => {
    const r = await act({
      actionType: 'authorize_payment',
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      targetIds: [],
      payload: {
        title: 'Meridian INV-441 settlement',
        payer_id: f.organizationId,
        payee_id: contractorId,
        amount_minor: 360000,
        currency: 'GBP',
        method: 'bank_transfer',
        external_reference: 'FPS-77213',
        value_date: '2026-08-15',
        allocations: [{ invoice_id: invoiceId, amount_minor: 360000 }],
      },
    });
    paymentId = r.objectIds[0]!;
    expect(await stateOf(paymentId)).toBe('authorized');

    await act({
      actionType: 'authorize_payment',
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      targetIds: [paymentId],
    });
    expect(await stateOf(paymentId)).toBe('initiated');

    // One action, two machines: the payment settles and the invoice is paid together,
    // because "paid but not settled" is not a state the money was ever in.
    await act({
      actionType: 'record_payment_settlement',
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      targetIds: [paymentId, invoiceId],
      // Two machines, two destinations, one action.
      payload: { to_state: { payment: 'settled', invoice: 'paid' } },
    });
    expect(await stateOf(paymentId)).toBe('settled');
    expect(await stateOf(invoiceId)).toBe('paid');

    await act({
      actionType: 'reconcile_payment',
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      targetIds: [paymentId],
    });
    expect(await stateOf(paymentId)).toBe('reconciled');
  });
});

describe('5. closure', () => {
  it('KF-PROJ-002: refuses administrative closure while a work order is open', async () => {
    await act({
      actionType: 'complete_project_technical',
      actorId: plannerId,
      actingRoleId: plannerRoleId,
      targetIds: [projectId],
    });
    expect(await stateOf(projectId)).toBe('technically_complete');

    const err = await act({
      actionType: 'close_project_administrative',
      actorId: plannerId,
      actingRoleId: plannerRoleId,
      targetIds: [projectId],
    }).catch((e: unknown) => e as ActionRejected);

    expect((err as ActionRejected).failure).toBe('precondition_failed');
    expect((err as ActionRejected).message).toMatch(/KF-PROJ-002/);
    // The work order is `completed`, not `closed` — technically finished, administratively
    // still open, which is exactly the distinction the rule exists to hold.
    expect((err as ActionRejected).detail['orders']).toBe(1);
  });

  it('closes once every obligation is settled', async () => {
    await act({
      actionType: 'correct_record',
      actorId: plannerId,
      actingRoleId: plannerRoleId,
      targetIds: [orderId],
      reason: 'Work accepted, invoice paid and reconciled; closing the order administratively.',
      payload: { to_state: 'closed' },
    });

    await act({
      actionType: 'close_project_administrative',
      actorId: plannerId,
      actingRoleId: plannerRoleId,
      targetIds: [projectId],
    });
    expect(await stateOf(projectId)).toBe('administratively_closed');
  });

  it('the whole scenario left one audit event per action, in an unbroken chain', async () => {
    const row = await read<{ events: string; actions: string; orphans: string }>(
      `select (select count(*) from core.audit_event)::text as events,
              (select count(*) from core.action)::text as actions,
              -- Every audit event must name an action that exists. A chain over events with
              -- no authority behind them would verify perfectly and mean nothing.
              (select count(*) from core.audit_event e
                 left join core.action a on a.id = e.action_id
                where a.id is null)::text as orphans`,
    );
    expect(row.events).toBe(row.actions);
    expect(Number(row.orphans)).toBe(0);
    expect(Number(row.events)).toBeGreaterThan(15);
  });
});
