import { auditChainDigest, compareCanonicalText } from '@kf/canonicalization';
import type { Tx } from '@kf/database';
import type { ActionRequest, EffectContext } from './contracts.js';
import type { PreparedActionState } from './state.js';

/** One audit-chain link, independent of how the acting code obtained its authority. */
export interface AuditChainEntry {
  readonly actionId: string;
  readonly actionType: string;
  readonly actorId: string;
  readonly actingRoleId: string;
  readonly objectIds: readonly string[];
  readonly effectiveAt: Date;
  readonly requestId?: string | undefined;
  readonly reason?: string | undefined;
  readonly beforeDigest: string | null;
  readonly afterDigest: string | null;
}

/**
 * Extend the global audit chain by exactly one link, and return the new head digest.
 *
 * Extracted so there is ONE implementation of the chain arithmetic. The dispatcher is not the
 * only writer that has to exist: dispatch binds authoritative clearance before effects run, so
 * the FIRST clearance in an organization cannot be granted by a dispatched action without
 * circularity, and that grant is applied by an owner-credential bootstrap act instead. Two
 * hand-written chain appends would be two chances to compute `prev_digest` differently, and a
 * chain that disagrees with itself is indistinguishable from a tampered one.
 *
 * The advisory lock is taken here, as late as possible. Holding it across materialization,
 * object-store work or typed effects would stall unrelated actions.
 */
export async function appendAuditEvent(tx: Tx, entry: AuditChainEntry): Promise<string> {
  await tx.query("select pg_advisory_xact_lock(hashtextextended('kf:audit-chain:v1', 0))");
  const head = await tx.one<{ digest: string }>('select digest from core.audit_chain_head');
  const prevDigest = head.digest;
  const objectIds = [...entry.objectIds].sort(compareCanonicalText);
  const auditDigest = auditChainDigest(prevDigest, {
    action_id: entry.actionId,
    action_type: entry.actionType,
    actor_id: entry.actorId,
    acting_role_id: entry.actingRoleId,
    object_ids: objectIds,
    effective_at: entry.effectiveAt.toISOString(),
    before_digest: entry.beforeDigest,
    after_digest: entry.afterDigest,
  });

  await tx.query(
    `insert into core.audit_event
         (action_id, actor_id, acting_role_id, action_type, object_id, effective_at,
          request_id, reason, before_digest, after_digest, prev_digest, digest)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      entry.actionId,
      entry.actorId,
      entry.actingRoleId,
      entry.actionType,
      objectIds.length === 1 ? objectIds[0] : null,
      entry.effectiveAt.toISOString(),
      entry.requestId ?? null,
      entry.reason ?? null,
      entry.beforeDigest,
      entry.afterDigest,
      prevDigest,
      auditDigest,
    ],
  );
  return auditDigest;
}

/**
 * Append one audit event and outbox message after all potentially slow action work.
 *
 * Global chain lock is intentionally acquired here. Holding it during materialization,
 * parser/object-store work, transitions, or typed effects would stall unrelated actions.
 */
export async function finalizeAction(
  tx: Tx,
  request: ActionRequest,
  state: PreparedActionState,
  ctx: EffectContext,
): Promise<string> {
  const auditDigest = await appendAuditEvent(tx, {
    actionId: ctx.actionId,
    actionType: request.actionType,
    actorId: request.actorId,
    actingRoleId: request.actingRoleId,
    objectIds: state.targetIds,
    effectiveAt: ctx.effectiveAt,
    requestId: request.requestId ?? undefined,
    reason: request.reason ?? undefined,
    beforeDigest: state.beforeDigest,
    afterDigest: state.afterDigest,
  });

  await tx.query(`insert into core.outbox (action_id, topic, payload) values ($1, $2, $3)`, [
    ctx.actionId,
    `kf.${request.actionType}`,
    JSON.stringify({ action_id: ctx.actionId, targets: state.targetIds }),
  ]);
  return auditDigest;
}
