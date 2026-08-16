import { auditChainDigest, compareCanonicalText, digest } from '@kf/canonicalization';
import type { Tx } from '@kf/database';
import { ActionRejected, type ActionRequest, type ActionResult } from './contracts.js';

/**
 * Stable identity of mutation semantics for one logical action attempt.
 *
 * Transport correlation and read scope do not change mutation semantics. Target order is
 * likewise non-semantic because authority and audit operate over a target set. Omitted event
 * time stays null so dispatcher wall clock cannot make otherwise identical retries differ.
 */
export function semanticActionRequestDigest(request: ActionRequest): string {
  return digest({
    format: 'kf-action-request-v1',
    organizationId: request.organizationId,
    actionType: request.actionType,
    actorId: request.actorId,
    actingRoleId: request.actingRoleId,
    targetIds: [...request.targetIds].sort(compareCanonicalText),
    payload: request.payload ?? {},
    reason: request.reason ?? null,
    expectedVersion: request.expectedVersion ?? null,
    effectiveAt: request.effectiveAt?.toISOString() ?? null,
  });
}

/** Serialize equivalent retry lookups before any materialization can occur. */
export async function lockIdempotencyKey(tx: Tx, request: ActionRequest): Promise<void> {
  const lockIdentity = digest({
    format: 'kf-action-idempotency-lock-v1',
    organizationId: request.organizationId,
    actionType: request.actionType,
    idempotencyKey: request.idempotencyKey,
  });
  await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [lockIdentity]);
}

/** Return committed result for an identical retry; reject conflicting key reuse. */
export async function replayPriorAction(
  tx: Tx,
  request: ActionRequest,
  requestDigest: string,
): Promise<ActionResult | undefined> {
  const prior = await tx.maybeOne<{
    id: string;
    actor_id: string;
    acting_role_id: string;
    organization_id: string;
    target_ids: string[];
    request_digest: string;
    result_status: string;
    action_type: string;
    action_effective_at_exact: string;
    action_request_id: string | null;
    action_reason: string | null;
    event_count: number;
    event_actor_id: string | null;
    event_acting_role_id: string | null;
    event_action_type: string | null;
    event_object_id: string | null;
    event_effective_at_exact: string | null;
    event_effective_at_wire: string | null;
    event_request_id: string | null;
    event_reason: string | null;
    event_before_digest: string | null;
    event_after_digest: string | null;
    event_prev_digest: string | null;
    audit_digest: string | null;
  }>(
    `select action.id, action.actor_id::text, action.acting_role_id::text,
            action.organization_id::text, action.target_ids, action.request_digest,
            action.result_status, action.action_type,
            to_char(action.effective_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as action_effective_at_exact,
            action.request_id as action_request_id, action.reason as action_reason,
            (select count(*)::integer from core.audit_event exact_event
              where exact_event.action_id = action.id) as event_count,
            event.actor_id::text as event_actor_id,
            event.acting_role_id::text as event_acting_role_id,
            event.action_type as event_action_type,
            event.object_id::text as event_object_id,
            to_char(event.effective_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as event_effective_at_exact,
            to_char(event.effective_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as event_effective_at_wire,
            event.request_id as event_request_id, event.reason as event_reason,
            event.before_digest as event_before_digest,
            event.after_digest as event_after_digest,
            event.prev_digest as event_prev_digest,
            event.digest as audit_digest
       from core.action action
       left join lateral (
         select receipt.* from core.audit_event receipt
          where receipt.action_id = action.id order by receipt.seq limit 1
       ) event on true
      where action.organization_id = $1
        and action.action_type = $2
        and action.idempotency_key = $3`,
    [request.organizationId, request.actionType, request.idempotencyKey],
  );
  if (prior === undefined) return undefined;

  if (prior.actor_id !== request.actorId || prior.acting_role_id !== request.actingRoleId) {
    throw new ActionRejected(
      'actor_not_authorized',
      'idempotency replay authorization does not match the original actor and role',
      { actionType: request.actionType },
    );
  }
  if (prior.request_digest !== requestDigest) {
    throw new ActionRejected(
      'idempotency_conflict',
      'idempotency key was already used for different action semantics',
      {
        actionType: request.actionType,
        organizationId: request.organizationId,
        idempotencyKey: request.idempotencyKey,
      },
    );
  }
  const targetIdsAreValid =
    Array.isArray(prior.target_ids) &&
    prior.target_ids.length > 0 &&
    prior.target_ids.every((targetId) => typeof targetId === 'string' && targetId.length > 0);
  const expectedAuditObjectId =
    targetIdsAreValid && prior.target_ids.length === 1 ? prior.target_ids[0]! : null;
  let recomputedAuditDigest: string | undefined;
  if (
    targetIdsAreValid &&
    prior.event_prev_digest !== null &&
    prior.event_effective_at_wire !== null
  ) {
    try {
      recomputedAuditDigest = auditChainDigest(prior.event_prev_digest, {
        action_id: prior.id,
        action_type: prior.action_type,
        actor_id: prior.actor_id,
        acting_role_id: prior.acting_role_id,
        object_ids: [...prior.target_ids].sort(compareCanonicalText),
        effective_at: prior.event_effective_at_wire,
        before_digest: prior.event_before_digest,
        after_digest: prior.event_after_digest,
      });
    } catch {
      recomputedAuditDigest = undefined;
    }
  }
  if (
    prior.result_status !== 'applied' ||
    prior.event_count !== 1 ||
    !targetIdsAreValid ||
    prior.audit_digest === null ||
    prior.event_actor_id !== prior.actor_id ||
    prior.event_acting_role_id !== prior.acting_role_id ||
    prior.event_action_type !== prior.action_type ||
    prior.event_object_id !== expectedAuditObjectId ||
    prior.event_effective_at_exact !== prior.action_effective_at_exact ||
    prior.event_request_id !== prior.action_request_id ||
    prior.event_reason !== prior.action_reason ||
    recomputedAuditDigest !== prior.audit_digest
  ) {
    throw new ActionRejected(
      'precondition_failed',
      'idempotency replay found an inconsistent action or audit receipt',
      { actionId: prior.id, actionType: request.actionType },
    );
  }
  return {
    actionId: prior.id,
    status: 'applied',
    replayed: true,
    objectIds: [...prior.target_ids],
    auditDigest: prior.audit_digest,
  };
}
