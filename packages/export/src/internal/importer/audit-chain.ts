import { auditChainDigest, compareCanonicalText, GENESIS_DIGEST } from '@kf/canonicalization';
import type { Tx } from '@kf/database';

interface RestoredAuditEvent extends Record<string, unknown> {
  readonly seq: string;
  readonly actionId: string;
  readonly actionType: string;
  readonly actorId: string;
  readonly actingRoleId: string;
  readonly targetIds: readonly string[];
  readonly objectId: string | null;
  readonly effectiveAt: string;
  readonly actionEffectiveAtExact: string;
  readonly eventEffectiveAtExact: string;
  readonly requestId: string | null;
  readonly actionRequestId: string | null;
  readonly reason: string | null;
  readonly actionReason: string | null;
  readonly beforeDigest: string | null;
  readonly afterDigest: string | null;
  readonly prevDigest: string;
  readonly expectedPrevDigest: string;
  readonly auditDigest: string;
  readonly actionActorId: string;
  readonly actionActingRoleId: string;
  readonly actionTypeFromAction: string;
  readonly actionEventCount: number;
}

/** Verify restored audit bytes against chain order and their originating action rows. */
export async function assertRestoredAuditChain(tx: Tx): Promise<void> {
  const receiptCountMismatch = await tx.query<{ action_id: string; receipts: string }>(
    `select action.id::text as action_id, count(event.seq)::text as receipts
       from core.action action
       left join core.audit_event event on event.action_id = action.id
      group by action.id
     having count(event.seq) <> 1
      order by action.id
      limit 1`,
  );
  if (receiptCountMismatch.length > 0) {
    const mismatch = receiptCountMismatch[0]!;
    throw new Error(
      `refusing to import: action ${mismatch.action_id} has ${mismatch.receipts} audit receipts; expected exactly one`,
    );
  }

  const events = await tx.query<RestoredAuditEvent>(
    `select event.seq::text as "seq", event.action_id::text as "actionId",
            event.action_type as "actionType", event.actor_id::text as "actorId",
            event.acting_role_id::text as "actingRoleId", action.target_ids as "targetIds",
            event.object_id::text as "objectId",
            to_char(event.effective_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "effectiveAt",
            to_char(action.effective_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "actionEffectiveAtExact",
            to_char(event.effective_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "eventEffectiveAtExact",
            event.request_id as "requestId", action.request_id as "actionRequestId",
            event.reason as "reason", action.reason as "actionReason",
            event.before_digest as "beforeDigest", event.after_digest as "afterDigest",
            event.prev_digest as "prevDigest",
            coalesce(
              lag(event.digest) over (order by event.seq), repeat('0', 64)
            ) as "expectedPrevDigest",
            event.digest as "auditDigest", action.actor_id::text as "actionActorId",
            action.acting_role_id::text as "actionActingRoleId",
            action.action_type as "actionTypeFromAction",
            count(*) over (partition by event.action_id)::integer as "actionEventCount"
       from core.audit_event event
       join core.action action on action.id = event.action_id
      order by event.seq`,
  );

  for (const event of events) {
    const expectedObjectId = event.targetIds.length === 1 ? event.targetIds[0]! : null;
    if (event.prevDigest !== event.expectedPrevDigest) {
      throw new Error(`refusing to import: audit chain predecessor mismatch at seq ${event.seq}`);
    }
    if (
      event.actionEventCount !== 1 ||
      event.actorId !== event.actionActorId ||
      event.actingRoleId !== event.actionActingRoleId ||
      event.actionType !== event.actionTypeFromAction ||
      event.objectId !== expectedObjectId ||
      event.eventEffectiveAtExact !== event.actionEffectiveAtExact ||
      event.requestId !== event.actionRequestId ||
      event.reason !== event.actionReason
    ) {
      throw new Error(`refusing to import: audit/action binding mismatch at seq ${event.seq}`);
    }
    let rebuilt: string;
    try {
      rebuilt = auditChainDigest(event.expectedPrevDigest, {
        action_id: event.actionId,
        action_type: event.actionType,
        actor_id: event.actorId,
        acting_role_id: event.actingRoleId,
        object_ids: [...event.targetIds].sort(compareCanonicalText),
        effective_at: event.effectiveAt,
        before_digest: event.beforeDigest,
        after_digest: event.afterDigest,
      });
    } catch {
      throw new Error(`refusing to import: malformed audit event at seq ${event.seq}`);
    }
    if (rebuilt !== event.auditDigest) {
      throw new Error(`refusing to import: audit digest mismatch at seq ${event.seq}`);
    }
  }
  if (events.length > 0 && events[0]!.expectedPrevDigest !== GENESIS_DIGEST) {
    throw new Error('refusing to import: audit chain does not start at genesis');
  }
}
