import type { ActionEffect } from '@kf/actions';
import { createControlledObject, requireMinor, requireString } from '../objects.js';
import { recordAdrDecisionBody } from './decision-effects.js';
import { refuse } from './errors.js';

export const recordAcceptance: ActionEffect = async (tx, request, objects) => {
  const execution = objects.find((o) => o.object_type === 'work_execution');
  if (execution === undefined) {
    // KF-WORK-TARGET-001, not KF-WORK-001. `ontology/rules.yaml` declares KF-WORK-001 as
    // "a work_execution references exactly one work_order" — a structural invariant of the
    // record. This is a caller who did not name a target. A client that special-cases the
    // declared code would read "your record is malformed" and act on the wrong thing.
    refuse('KF-WORK-TARGET-001', 'issue_acceptance must name the work execution being judged');
  }

  const disposition = requireString(request.payload, 'disposition');
  const acceptedValue =
    disposition === 'rejected' ? 0 : requireMinor(request.payload, 'accepted_value_minor');

  const claimed = await tx.one<{ claimed_value_minor: string; currency: string }>(
    'select claimed_value_minor, currency from work.work_execution where id = $1',
    [execution.id],
  );
  if (acceptedValue > Number(claimed.claimed_value_minor)) {
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

export const amendWorkOrder: ActionEffect = async (tx, request, objects) => {
  const order = objects.find((o) => o.object_type === 'work_order');
  // KF-FIN-TARGET-001, not KF-FIN-001. The declared rule is "accepted value must not exceed
  // authorized work-order ceiling without an approved amendment", whose remedy is to raise an
  // amendment — advice that is actively wrong for a caller who simply named no work order.
  if (order === undefined) refuse('KF-FIN-TARGET-001', 'amend_work_order must name a work order');

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
  propose_decision: recordAdrDecisionBody,
  accept_decision: recordAdrDecisionBody,
  issue_acceptance: recordAcceptance,
  amend_work_order: amendWorkOrder,
};
