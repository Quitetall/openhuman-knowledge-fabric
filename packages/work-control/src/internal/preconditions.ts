import type { PreconditionCheck } from '@kf/actions';
import { refuse } from './errors.js';

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

/**
 * KF-FIN-003, as a refusal the caller can act on.
 *
 * `finance.assert_allocation_within_bounds` already enforces this, takes `for update` on the
 * payment and each invoice, and remains the authority. This is not the enforcement and must
 * not be mistaken for it: two allocations racing still meet each other at the trigger, which
 * is correct, because a precondition cannot hold a lock across the dispatcher.
 *
 * What was missing is the other half of what `ontology/rules.yaml` promises. The rule lists
 * `action_precondition` among its implementations and there was none, so a caller who
 * over-allocated received a raw PostgreSQL `check_violation`. That difference is not
 * cosmetic: `ActionRejected` carries a code a client can branch on and a message naming the
 * amounts, where the database error arrives as a transport-level failure that reads like the
 * fabric broke.
 *
 * Deliberately limited to what can be checked without a lock — currency agreement, and the
 * payment's own total. Reproducing the invoice-balance arithmetic would be a second copy of
 * the trigger's logic, free to drift, with none of its atomicity.
 */
const assertAllocationsFit: PreconditionCheck = async (tx, request) => {
  const allocations = request.payload?.['allocations'];
  if (!Array.isArray(allocations) || allocations.length === 0) return;

  const paymentMinor = Number(request.payload?.['amount_minor']);
  const currency = request.payload?.['currency'];
  let total = 0;
  for (const entry of allocations) {
    const allocation = entry as Record<string, unknown>;
    const amount = Number(allocation['amount_minor']);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      refuse('KF-FIN-003', 'every payment allocation needs a whole, non-negative minor amount');
    }
    total += amount;

    const invoiceId = allocation['invoice_id'];
    if (typeof invoiceId !== 'string' || invoiceId === '') continue;
    const invoice = await tx.maybeOne<{ currency: string; invoice_number: string }>(
      'select currency, invoice_number from finance.invoice where id = $1',
      [invoiceId],
    );
    // A missing invoice is the foreign key's to refuse; only disagreement is ours.
    if (invoice !== undefined && typeof currency === 'string' && invoice.currency !== currency) {
      refuse(
        'KF-FIN-003',
        `payment is in ${currency} and invoice ${invoice.invoice_number} is in ` +
          `${invoice.currency}; an allocation cannot cross currencies`,
        { paymentCurrency: currency, invoiceCurrency: invoice.currency },
      );
    }
  }

  if (Number.isSafeInteger(paymentMinor) && total > paymentMinor) {
    refuse(
      'KF-FIN-003',
      `allocations total ${total / 100} against a payment of ${paymentMinor / 100}; ` +
        'a payment cannot allocate more than it settles',
      { allocated: total, payment: paymentMinor },
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
  // `authorize_payment`, not `record_payment_settlement`. Allocations travel in the payload of
  // the action that CREATES the payment: `authorizePayment` in finance-materializers.ts reads
  // `payload.allocations` and writes each row. Registered against the settlement action
  // instead — as this was, first time — the check would find no `allocations` key on any call,
  // return at its first line every time, and verify nothing at all, while the registration
  // made it look as though KF-FIN-003 had gained a precondition.
  authorize_payment: assertAllocationsFit,
};
