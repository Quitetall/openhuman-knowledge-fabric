import {
  setAccessContext,
  setTransactionContext,
  withTransaction,
  type Pool,
  type Tx,
} from '@kf/database';
import { applyAction } from './application.js';
import {
  assertActionAvailable,
  assertCanonicalEffectiveAt,
  assertReasonPresent,
  assertRoleHeld,
  loadDefinition,
} from './authority.js';
import { finalizeAction } from './audit.js';
import {
  resolveDispatcherOptions,
  type ActionDispatcher,
  type ActionRequest,
  type ActionResult,
  type DispatcherOptions,
  type EffectContext,
  type TransactionalActionDispatcher,
} from './contracts.js';
import {
  lockIdempotencyKey,
  replayPriorAction,
  semanticActionRequestDigest,
} from './idempotency.js';
import { prepareActionState } from './state.js';

/** Build transactional action kernel over explicitly composed action atoms. */
export function createTransactionalDispatcher(
  options: DispatcherOptions = {},
): TransactionalActionDispatcher {
  const resolved = resolveDispatcherOptions(options);

  return async function executeAction(tx: Tx, request: ActionRequest): Promise<ActionResult> {
    assertActionAvailable(request.actionType, resolved.allowedActions);
    assertCanonicalEffectiveAt(request);
    await setAccessContext(tx, {
      organizationId: request.organizationId,
      maxClassification: request.maxClassification,
    });

    const requestDigest = semanticActionRequestDigest(request);
    await lockIdempotencyKey(tx, request);
    const replay = await replayPriorAction(tx, request, requestDigest);
    if (replay !== undefined) return replay;

    const definition = await loadDefinition(tx, request.actionType);
    await assertRoleHeld(tx, request.actorId, request.actingRoleId);
    assertReasonPresent(request, resolved.reasonRequired);

    const actionId = (await tx.one<{ id: string }>('select uuidv7() as id')).id;
    const effectiveAt = request.effectiveAt ?? new Date();
    const ctx: EffectContext = { actionId, effectiveAt };
    await setTransactionContext(tx, {
      actorId: request.actorId,
      actingRoleId: request.actingRoleId,
      actionId,
      ...(request.requestId !== undefined ? { requestId: request.requestId } : {}),
    });

    const state = await prepareActionState(tx, request, definition, resolved, ctx);
    await applyAction(tx, request, requestDigest, state, ctx, resolved);
    const auditDigest = await finalizeAction(tx, request, state, ctx);
    return {
      actionId,
      status: 'applied',
      replayed: false,
      objectIds: [...state.targetIds],
      auditDigest,
    };
  };
}

/** Standalone action seam: exactly one action and audit receipt per transaction. */
export function createDispatcher(pool: Pool, options: DispatcherOptions = {}): ActionDispatcher {
  const executeInTransaction = createTransactionalDispatcher(options);
  return async function executeAction(request: ActionRequest): Promise<ActionResult> {
    return withTransaction(pool, (tx) => executeInTransaction(tx, request));
  };
}
