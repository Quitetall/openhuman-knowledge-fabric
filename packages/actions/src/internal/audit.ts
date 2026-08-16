import { auditChainDigest, compareCanonicalText } from '@kf/canonicalization';
import type { Tx } from '@kf/database';
import type { ActionRequest, EffectContext } from './contracts.js';
import type { PreparedActionState } from './state.js';

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
  await tx.query("select pg_advisory_xact_lock(hashtextextended('kf:audit-chain:v1', 0))");
  const head = await tx.one<{ digest: string }>('select digest from core.audit_chain_head');
  const prevDigest = head.digest;
  const entry = {
    action_id: ctx.actionId,
    action_type: request.actionType,
    actor_id: request.actorId,
    acting_role_id: request.actingRoleId,
    object_ids: [...state.targetIds].sort(compareCanonicalText),
    effective_at: ctx.effectiveAt.toISOString(),
    before_digest: state.beforeDigest,
    after_digest: state.afterDigest,
  };
  const auditDigest = auditChainDigest(prevDigest, entry);

  await tx.query(
    `insert into core.audit_event
         (action_id, actor_id, acting_role_id, action_type, object_id, effective_at,
          request_id, reason, before_digest, after_digest, prev_digest, digest)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      ctx.actionId,
      request.actorId,
      request.actingRoleId,
      request.actionType,
      state.targetIds.length === 1 ? state.targetIds[0] : null,
      ctx.effectiveAt.toISOString(),
      request.requestId ?? null,
      request.reason ?? null,
      state.beforeDigest,
      state.afterDigest,
      prevDigest,
      auditDigest,
    ],
  );

  await tx.query(`insert into core.outbox (action_id, topic, payload) values ($1, $2, $3)`, [
    ctx.actionId,
    `kf.${request.actionType}`,
    JSON.stringify({ action_id: ctx.actionId, targets: state.targetIds }),
  ]);
  return auditDigest;
}
