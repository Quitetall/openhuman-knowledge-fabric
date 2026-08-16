import { createHash } from 'node:crypto';
import { auditChainDigest } from '@kf/canonicalization';
import type { LegacyActionMaterialization } from './contracts.js';

export function isTrustedPreSemanticAction(row: LegacyActionMaterialization): boolean {
  const legacyDigest = createHash('sha256')
    .update(`kf-action-legacy-v1:${row.actionId}`)
    .digest('hex');
  if (
    row.requestDigest !== legacyDigest ||
    row.resultStatus !== 'applied' ||
    row.resultAuditDigest !== row.auditDigest
  ) {
    return false;
  }
  try {
    return (
      auditChainDigest(row.prevDigest, {
        action_id: row.actionId,
        action_type: row.actionType,
        actor_id: row.actorId,
        acting_role_id: row.actingRoleId,
        object_ids: row.targetIds,
        effective_at: row.effectiveAt,
        before_digest: row.beforeDigest,
        after_digest: row.afterDigest,
      }) === row.auditDigest
    );
  } catch {
    return false;
  }
}
