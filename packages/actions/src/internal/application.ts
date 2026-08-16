import type { Tx } from '@kf/database';
import type { ActionRequest, EffectContext, ResolvedDispatcherOptions } from './contracts.js';
import type { PreparedActionState } from './state.js';

/** Record authoritative action, apply transitions, then run action-owned typed writes. */
export async function applyAction(
  tx: Tx,
  request: ActionRequest,
  requestDigest: string,
  state: PreparedActionState,
  ctx: EffectContext,
  options: ResolvedDispatcherOptions,
): Promise<void> {
  await tx.query(
    `insert into core.action
         (id, organization_id, request_digest, action_type, actor_id, acting_role_id,
          target_ids, parameters, preconditions, idempotency_key, effective_at, request_id,
          reason, result_status, result)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'applied','{}'::jsonb)`,
    [
      ctx.actionId,
      request.organizationId,
      requestDigest,
      request.actionType,
      request.actorId,
      request.actingRoleId,
      [...state.targetIds],
      JSON.stringify(request.payload ?? {}),
      JSON.stringify({ before: state.before, expected_version: request.expectedVersion ?? null }),
      request.idempotencyKey,
      ctx.effectiveAt.toISOString(),
      request.requestId ?? null,
      request.reason ?? null,
    ],
  );

  for (const [objectId, toState] of state.transitions) {
    await tx.query(
      `update core.object
            set lifecycle_state = $2,
                row_version = row_version + 1,
                updated_at = now(),
                updated_by = $3
          where id = $1`,
      [objectId, toState, request.actorId],
    );
  }

  const effect = options.effects[request.actionType];
  if (effect !== undefined) await effect(tx, request, state.objects, ctx);
}
