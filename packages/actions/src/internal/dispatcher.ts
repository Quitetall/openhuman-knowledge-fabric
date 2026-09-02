import { setTransactionContext, withTransaction, type Pool, type Tx } from '@kf/database';
import { applyAction } from './application.js';
import {
  assertActionAvailable,
  bindResolvedAccessContext,
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
    const requestDigest = semanticActionRequestDigest(request);
    await lockIdempotencyKey(tx, request);
    const definition = await loadDefinition(tx, request.actionType);
    // Role ownership is an authority fact, not a classified record. The database helper is
    // SECURITY DEFINER so this check remains independent of the later reader ceiling.
    await assertRoleHeld(tx, request.actorId, request.actingRoleId);
    // Resolve before any context is bound. The caller's requested value is untrusted and
    // must never reach RLS directly; the resolver validates it before setting RLS context.
    await bindResolvedAccessContext(tx, request);
    assertReasonPresent(request, resolved.reasonRequired);

    // Replay is still an authorized action path: resolve clearance before reading its
    // receipt, rather than letting an idempotency retry bypass the authority boundary.
    const replay = await replayPriorAction(tx, request, requestDigest, resolved.receipts);
    if (replay !== undefined) return replay;

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
    const readReceipt = resolved.receipts[request.actionType];
    const receipt = readReceipt === undefined ? undefined : await readReceipt(tx, actionId);
    return {
      actionId,
      status: 'applied',
      replayed: false,
      objectIds: [...state.targetIds],
      auditDigest,
      ...(receipt === undefined ? {} : { receipt }),
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
