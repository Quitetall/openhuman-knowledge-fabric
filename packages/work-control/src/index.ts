/**
 * Work control: the path from a captured initiative to a closed project, as typed actions.
 *
 * This package is where the R01 pack's ten invariants stop being prose. Six of them were
 * documented and unenforced; §27.1 makes an unenforced rule NONCONFORMING, so each one here
 * is either a database constraint, an action precondition, or both — and the ones that are
 * both are that way deliberately. A financial ceiling guarded only by application code is
 * guarded only against callers who go through the application.
 *
 * | Rule        | Where it lives                                                        |
 * |-------------|-----------------------------------------------------------------------|
 * | KF-WORK-001 | `work.work_execution.work_order_id` not null, single column           |
 * | KF-WORK-002 | `work.work_order.project_id` + `engagement_id`, both not null         |
 * | KF-DEC-001  | `assertDecisionMutable` — accepted and rejected decisions are frozen   |
 * | KF-CHG-001  | `assertChangeCitesDecision` — a change implements a decision          |
 * | KF-FIN-001  | trigger `acceptance_within_ceiling` + `assertWithinCeiling`           |
 * | KF-FIN-002  | trigger `invoice_line_within_accepted` + `assertLineWithinAccepted`   |
 * | KF-FIN-003  | trigger `allocation_within_bounds` + `assertAllocationWithinBounds`   |
 * | KF-PROJ-001 | `projectProgress` — computed from accepted work, never from spending  |
 * | KF-PROJ-002 | `assertClosable` — closure requires open work and money settled      |
 * | KF-GRAPH-001| foreign keys throughout; nothing references a row that does not exist  |
 */

import {
  ActionRejected,
  type ActionEffect,
  type ActionMaterializer,
  type PreconditionCheck,
} from '@kf/actions';
import type { Tx } from '@kf/database';
import {
  createControlledObject,
  optionalString,
  requireCurrency,
  requireMinor,
  requireString,
} from './objects.js';

// Re-exported so the Gate 6 operations use the SAME payload readers rather than a second
// set that drifts: the money and identifier rules live in one place or they live in two.
export {
  createControlledObject,
  optionalString,
  requireCurrency,
  requireMinor,
  requireString,
} from './objects.js';

/** A precondition failure, phrased so the caller learns which rule refused them. */
function refuse(rule: string, message: string, detail: Record<string, unknown> = {}): never {
  throw new ActionRejected('precondition_failed', `${rule}: ${message}`, { rule, ...detail });
}

// ── materializers: actions that bring a record into existence ───────────────────────────

const createInitiative: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'initiative_project',
    authorityDomain: 'project',
    lifecycleState: 'captured',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into work.initiative_project (id, project_code, objective, sponsor_id)
     values ($1, $2, $3, $4)`,
    [
      id,
      optionalString(request.payload, 'project_code'),
      requireString(request.payload, 'objective'),
      requireString(request.payload, 'sponsor_id'),
    ],
  );
  return [id];
};

const createWorkPackage: ActionMaterializer = async (tx, request) => {
  const projectId = requireString(request.payload, 'project_id');
  const id = await createControlledObject(tx, {
    objectType: 'work_package',
    authorityDomain: 'project',
    lifecycleState: 'planned',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });

  // Sequence allocated under a lock on the project, so two packages created at once cannot
  // both take the same number.
  const { next } = await tx.one<{ next: number }>(
    `select coalesce(max(sequence_no), 0) + 1 as next from work.work_package
      where project_id = (select id from work.initiative_project where id = $1 for update)`,
    [projectId],
  );
  await tx.query(
    `insert into work.work_package
       (id, project_id, sequence_no, scope_statement, acceptance_criterion,
        planned_value_minor, currency)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      projectId,
      next,
      requireString(request.payload, 'scope_statement'),
      requireString(request.payload, 'acceptance_criterion'),
      request.payload?.['planned_value_minor'] ?? null,
      optionalString(request.payload, 'currency'),
    ],
  );
  return [id];
};

const issueWorkOrder: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'work_order',
    authorityDomain: 'project',
    lifecycleState: 'draft',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
    // Rates and ceilings need a narrower audience than the rest of the project record.
    classification: 'restricted',
  });
  await tx.query(
    `insert into work.work_order
       (id, project_id, engagement_id, order_number, scope_summary, ceiling_minor, currency,
        issued_on)
     values ($1,$2,$3,$4,$5,$6,$7, current_date)`,
    [
      id,
      requireString(request.payload, 'project_id'),
      requireString(request.payload, 'engagement_id'),
      requireString(request.payload, 'order_number'),
      requireString(request.payload, 'scope_summary'),
      requireMinor(request.payload, 'ceiling_minor'),
      requireCurrency(request.payload),
    ],
  );

  const packages = request.payload?.['work_package_ids'];
  if (Array.isArray(packages)) {
    for (const packageId of packages) {
      await tx.query(
        'insert into work.work_order_scope (work_order_id, work_package_id) values ($1,$2)',
        [id, packageId],
      );
    }
  }
  return [id];
};

const submitWorkExecution: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'work_execution',
    authorityDomain: 'project',
    lifecycleState: 'draft',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into work.work_execution
       (id, work_order_id, performed_by, submitted_by, recorded_by, period_start, period_end,
        effort_hours, summary, claimed_value_minor, currency)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id,
      requireString(request.payload, 'work_order_id'),
      // §13.2 keeps these three distinct. A contractor performs and submits; someone with
      // system access records. Defaulting them to the actor would attribute a contractor's
      // work to whoever transcribed it.
      requireString(request.payload, 'performed_by'),
      requireString(request.payload, 'submitted_by'),
      request.actorId,
      requireString(request.payload, 'period_start'),
      requireString(request.payload, 'period_end'),
      request.payload?.['effort_hours'] ?? null,
      requireString(request.payload, 'summary'),
      requireMinor(request.payload, 'claimed_value_minor'),
      requireCurrency(request.payload),
    ],
  );
  return [id];
};

const submitInvoice: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'invoice',
    authorityDomain: 'finance',
    lifecycleState: 'draft',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
    classification: 'restricted',
  });
  await tx.query(
    `insert into finance.invoice (id, engagement_id, invoice_number, issuer_id, currency, issued_on)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      id,
      requireString(request.payload, 'engagement_id'),
      requireString(request.payload, 'invoice_number'),
      requireString(request.payload, 'issuer_id'),
      requireCurrency(request.payload),
      requireString(request.payload, 'issued_on'),
    ],
  );

  const lines = request.payload?.['lines'];
  if (!Array.isArray(lines) || lines.length === 0) {
    refuse('KF-FIN-002', 'an invoice with no lines bills for nothing');
  }
  let lineNo = 1;
  for (const raw of lines) {
    const line = raw as Record<string, unknown>;
    // The KF-FIN-002 trigger fires per line and refuses anything beyond accepted value.
    await tx.query(
      `insert into finance.invoice_line
         (invoice_id, line_no, work_order_id, acceptance_id, description, amount_minor)
       values ($1,$2,$3,$4,$5,$6)`,
      [
        id,
        lineNo++,
        requireString(line, 'work_order_id'),
        optionalString(line, 'acceptance_id'),
        requireString(line, 'description'),
        requireMinor(line, 'amount_minor'),
      ],
    );
  }
  return [id];
};

const authorizePayment: ActionMaterializer = async (tx, request) => {
  // Only on the first leg: `authorize_payment` also drives authorized -> initiated, and a
  // materializer that ran then would create a second payment for the same money.
  if (request.targetIds.length > 0) return [];

  const id = await createControlledObject(tx, {
    objectType: 'payment',
    authorityDomain: 'finance',
    lifecycleState: 'planned',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
    classification: 'restricted',
  });
  await tx.query(
    `insert into finance.payment
       (id, payer_id, payee_id, amount_minor, currency, method, external_reference, value_date)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      requireString(request.payload, 'payer_id'),
      requireString(request.payload, 'payee_id'),
      requireMinor(request.payload, 'amount_minor'),
      requireCurrency(request.payload),
      requireString(request.payload, 'method'),
      // Deliberately a provider reference, never bank details: account numbers, tax
      // identifiers and payroll data do not enter this system at all.
      optionalString(request.payload, 'external_reference'),
      requireString(request.payload, 'value_date'),
    ],
  );

  const allocations = request.payload?.['allocations'];
  if (Array.isArray(allocations)) {
    for (const raw of allocations) {
      const a = raw as Record<string, unknown>;
      // The KF-FIN-003 trigger refuses over-allocation of the payment and overpayment of
      // the invoice, each under a lock on the row it is summing against.
      await tx.query(
        'insert into finance.payment_allocation (payment_id, invoice_id, amount_minor) values ($1,$2,$3)',
        [id, requireString(a, 'invoice_id'), requireMinor(a, 'amount_minor')],
      );
    }
  }
  return [id];
};

const proposeDecision: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'decision_record',
    authorityDomain: 'engineering',
    lifecycleState: 'draft',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  return [id];
};

const openChange: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'change_record',
    authorityDomain: 'engineering',
    lifecycleState: 'proposed',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  // KF-CHG-001: the authorizing decision is recorded as the change is opened, because
  // asking for it later means asking someone to justify a change already under way.
  await tx.query(
    `insert into core.relation (relation_type, source_id, target_id, created_by, authorizing_action)
     values ('implements', $1, $2, $3, $4)`,
    [id, requireString(request.payload, 'decision_id'), request.actorId, null],
  );
  return [id];
};

export const WORK_CONTROL_MATERIALIZERS: Readonly<Record<string, ActionMaterializer>> = {
  create_initiative: createInitiative,
  create_work_package: createWorkPackage,
  issue_work_order: issueWorkOrder,
  submit_work_execution: submitWorkExecution,
  submit_invoice: submitInvoice,
  authorize_payment: authorizePayment,
  propose_decision: proposeDecision,
  open_change: openChange,
};

// ── effects: typed writes that need the action row to exist ─────────────────────────────

/**
 * `issue_acceptance` creates the acceptance record itself.
 *
 * An effect rather than a materializer because `acceptance_record` has no lifecycle machine —
 * it is not a target of this action, it is what the action produces. The KF-FIN-001 trigger
 * fires on this insert and refuses anything beyond the authorized ceiling.
 */
const recordAcceptance: ActionEffect = async (tx, request, objects) => {
  const execution = objects.find((o) => o.object_type === 'work_execution');
  if (execution === undefined) {
    refuse('KF-WORK-001', 'issue_acceptance must name the work execution being judged');
  }

  const disposition = requireString(request.payload, 'disposition');
  // A rejection accepts nothing, so the field is not required on that path — and if a caller
  // supplies one anyway it is ignored rather than honoured, because "rejected, and here is
  // what we are paying" is a contradiction the CHECK constraint would refuse in any case.
  const acceptedValue =
    disposition === 'rejected' ? 0 : requireMinor(request.payload, 'accepted_value_minor');

  const claimed = await tx.one<{ claimed_value_minor: string; currency: string }>(
    'select claimed_value_minor, currency from work.work_execution where id = $1',
    [execution.id],
  );
  if (acceptedValue > Number(claimed.claimed_value_minor)) {
    // Acceptance may reduce a claim and may reject it. It may not INCREASE it: that would be
    // the reviewer awarding money nobody asked for, with no submission behind it.
    refuse('KF-FIN-001', 'accepted value exceeds the value claimed by the submission', {
      claimed: Number(claimed.claimed_value_minor),
      accepted: acceptedValue,
    });
  }

  const id = await createControlledObject(tx, {
    objectType: 'acceptance_record',
    authorityDomain: 'project',
    lifecycleState: 'issued',
    title: `Acceptance of ${execution.id}`,
    organizationId: request.organizationId,
    createdBy: request.actorId,
    classification: 'restricted',
  });
  await tx.query(
    `insert into work.acceptance_record
       (id, work_execution_id, accepted_by, disposition, accepted_value_minor, currency, rationale)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      execution.id,
      request.actorId,
      disposition,
      acceptedValue,
      claimed.currency,
      requireString(request.payload, 'rationale'),
    ],
  );
};

/** An amendment is a record, never an edit of the ceiling it changes (§16.3). */
const amendWorkOrder: ActionEffect = async (tx, request, objects) => {
  const order = objects.find((o) => o.object_type === 'work_order');
  if (order === undefined) refuse('KF-FIN-001', 'amend_work_order must name a work order');

  const { next, currency } = await tx.one<{ next: number; currency: string }>(
    `select coalesce(max(a.amendment_no), 0) + 1 as next, wo.currency
       from work.work_order wo
       left join work.work_order_amendment a on a.work_order_id = wo.id
      where wo.id = $1
      group by wo.currency`,
    [order.id],
  );

  const id = await createControlledObject(tx, {
    objectType: 'work_order_amendment',
    authorityDomain: 'project',
    lifecycleState: 'issued',
    title: `Amendment ${next} to ${order.id}`,
    organizationId: request.organizationId,
    createdBy: request.actorId,
    classification: 'restricted',
  });

  const delta = request.payload?.['ceiling_delta_minor'];
  if (typeof delta !== 'number' || !Number.isSafeInteger(delta)) {
    throw new Error('ceiling_delta_minor is required and must be an integer in minor units');
  }
  await tx.query(
    `insert into work.work_order_amendment
       (id, work_order_id, amendment_no, ceiling_delta_minor, currency, rationale,
        approved_at, approved_by)
     values ($1,$2,$3,$4,$5,$6, now(), $7)`,
    [id, order.id, next, delta, currency, request.reason ?? 'amendment', request.actorId],
  );
};

export const WORK_CONTROL_EFFECTS: Readonly<Record<string, ActionEffect>> = {
  issue_acceptance: recordAcceptance,
  amend_work_order: amendWorkOrder,
};

// ── preconditions: the invariants that are not expressible as constraints ───────────────

/** KF-DEC-001. An accepted or rejected decision is immutable; supersession makes a new one. */
const assertDecisionMutable: PreconditionCheck = async (_tx, _request, objects) => {
  for (const o of objects) {
    if (o.object_type !== 'decision_record') continue;
    if (o.lifecycle_state === 'accepted' || o.lifecycle_state === 'rejected') {
      refuse(
        'KF-DEC-001',
        `a ${o.lifecycle_state} decision is immutable — supersede it with a new decision record`,
        { objectId: o.id, state: o.lifecycle_state },
      );
    }
  }
};

/**
 * KF-CHG-001. A change implements a decision; it never substitutes for one.
 *
 * Checked as the change is APPROVED rather than only as it is opened, because the rationale
 * is what approval rests on, and a relation deleted in between would leave an approved change
 * standing on nothing.
 */
const assertChangeCitesDecision: PreconditionCheck = async (tx, _request, objects) => {
  for (const o of objects) {
    if (o.object_type !== 'change_record') continue;
    const cited = await tx.maybeOne<{ target_id: string }>(
      `select target_id from core.relation
        where source_id = $1 and relation_type = 'implements' limit 1`,
      [o.id],
    );
    if (cited === undefined) {
      refuse('KF-CHG-001', 'this change cites no decision; a change may not be its own rationale', {
        objectId: o.id,
      });
    }
  }
};

/**
 * KF-PROJ-002. Administrative closure needs technical disposition, closed work orders, and
 * settled money.
 *
 * The financial half is the one that matters in practice: a project closed with an approved
 * invoice still unpaid looks finished and is not.
 *
 * "Settled money" means invoices with a line against one of THIS project's work orders —
 * deliberately not every invoice on the engagement. An engagement usually spans several
 * projects, and blocking project A's closure because project B is still being billed would
 * make the rule unusable and teach people to route around it. An invoice that touches no
 * work order cannot exist: `finance.invoice_line.work_order_id` is not null, and
 * `submit_invoice` refuses an invoice with no lines.
 */
const assertClosable: PreconditionCheck = async (tx, _request, objects) => {
  for (const o of objects) {
    if (o.object_type !== 'initiative_project') continue;

    const open = await tx.one<{ orders: string; invoices: string; packages: string }>(
      `select
         (select count(*) from work.work_order wo
            join core.object obj on obj.id = wo.id
           where wo.project_id = $1
             and obj.lifecycle_state not in ('closed', 'cancelled', 'terminated'))::text as orders,
         (select count(*) from finance.invoice i
            join core.object obj on obj.id = i.id
            join finance.invoice_line il on il.invoice_id = i.id
            join work.work_order wo on wo.id = il.work_order_id
           where wo.project_id = $1
             and obj.lifecycle_state not in ('paid', 'void'))::text as invoices,
         (select count(*) from work.work_package wp
            join core.object obj on obj.id = wp.id
           where wp.project_id = $1
             and obj.lifecycle_state not in ('accepted', 'waived', 'cancelled'))::text as packages`,
      [o.id],
    );

    const orders = Number(open.orders);
    const invoices = Number(open.invoices);
    const packages = Number(open.packages);
    if (orders > 0 || invoices > 0 || packages > 0) {
      refuse(
        'KF-PROJ-002',
        `closure requires every obligation settled: ${orders} open work order(s), ` +
          `${invoices} unsettled invoice(s), ${packages} undisposed work package(s)`,
        { objectId: o.id, orders, invoices, packages },
      );
    }
  }
};

/** KF-FIN-001, at the application tier. The trigger is the guarantee; this is the message. */
const assertWithinCeiling: PreconditionCheck = async (tx, request, objects) => {
  const execution = objects.find((o) => o.object_type === 'work_execution');
  if (execution === undefined) return;

  const proposed = Number(request.payload?.['accepted_value_minor'] ?? 0);
  const room = await tx.maybeOne<{ remaining: string; order_number: string }>(
    `select (wo.ceiling_minor
             + coalesce((select sum(a.ceiling_delta_minor) from work.work_order_amendment a
                          where a.work_order_id = wo.id and a.approved_at is not null), 0)
             - coalesce((select sum(ar.accepted_value_minor)
                           from work.acceptance_record ar
                           join work.work_execution we2 on we2.id = ar.work_execution_id
                          where we2.work_order_id = wo.id), 0))::text as remaining,
            wo.order_number
       from work.work_order wo
       join work.work_execution we on we.work_order_id = wo.id
      where we.id = $1`,
    [execution.id],
  );
  if (room !== undefined && proposed > Number(room.remaining)) {
    refuse(
      'KF-FIN-001',
      `work order ${room.order_number} has ${Number(room.remaining) / 100} remaining under its ` +
        `authorized ceiling; accepting ${proposed / 100} needs an approved amendment first`,
      { remaining: Number(room.remaining), proposed },
    );
  }
};

export const WORK_CONTROL_PRECONDITIONS: Readonly<Record<string, PreconditionCheck>> = {
  accept_decision: assertDecisionMutable,
  reject_decision: assertDecisionMutable,
  correct_record: assertDecisionMutable,
  approve_change: assertChangeCitesDecision,
  verify_change: assertChangeCitesDecision,
  close_project_administrative: assertClosable,
  issue_acceptance: assertWithinCeiling,
};

// ── KF-PROJ-001: progress is computed, never stored ─────────────────────────────────────

export interface ProjectProgress {
  readonly totalPackages: number;
  readonly disposedPackages: number;
  /** Fraction in [0, 1]. Null when a project has no work packages yet. */
  readonly fraction: number | null;
}

/**
 * KF-PROJ-001. Progress comes from accepted or waived work packages.
 *
 * Not from spending, not from activity count, and not from a percentage someone typed. Those
 * are the three numbers that make a late project look on track, which is precisely why the
 * rule names them. Computed on read rather than stored, because a stored number is one more
 * thing that can disagree with the records it summarises.
 */
export async function projectProgress(tx: Tx, projectId: string): Promise<ProjectProgress> {
  const row = await tx.one<{ total: string; disposed: string }>(
    `select count(*)::text as total,
            count(*) filter (where obj.lifecycle_state in ('accepted', 'waived'))::text as disposed
       from work.work_package wp
       join core.object obj on obj.id = wp.id
      where wp.project_id = $1`,
    [projectId],
  );
  const total = Number(row.total);
  const disposed = Number(row.disposed);
  return {
    totalPackages: total,
    disposedPackages: disposed,
    fraction: total === 0 ? null : disposed / total,
  };
}

export const PACKAGE = {
  name: '@kf/work-control',
  role: 'Work control: projects, orders, execution, acceptance, invoicing, closure',
  owns: ['work', 'finance'],
} as const;
