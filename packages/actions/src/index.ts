/**
 * Typed action dispatcher: sole path for controlled writes.
 *
 * Every controlled state change crosses this seam in one transaction: authority resolves,
 * targets lock, preconditions run, typed writes apply, audit appends, and outbox emits. Commit
 * cannot contain controlled change without matching action and audit records.
 *
 * Public seam stays deliberately small. Private atoms compose authority, state preparation,
 * typed effects, semantic idempotency, audit finalization, and transaction orchestration.
 */

export {
  ActionRejected,
  DEFAULT_REASON_REQUIRED,
  type ActionDispatcher,
  type ActionEffect,
  type ActionReceiptReader,
  type ActionFailure,
  type ActionMaterializer,
  type ActionRequest,
  type ActionResult,
  type DispatcherOptions,
  type EffectContext,
  type ObjectRow,
  type PreconditionCheck,
  type TransactionalActionDispatcher,
  type TransactionalActionPreflight,
} from './internal/contracts.js';
// Exported for bootstrap-tier acts that CANNOT go through the dispatcher — see the note on
// appendAuditEvent. Dispatch binds authoritative clearance before effects, so the first
// clearance in an organization is granted outside it; it still has to extend the same chain,
// with the same arithmetic, or the chain disagrees with itself.
export { appendAuditEvent, type AuditChainEntry } from './internal/audit.js';
export { createTransactionalPreflight } from './internal/authority.js';
export { createDispatcher, createTransactionalDispatcher } from './internal/dispatcher.js';
export { semanticActionRequestDigest } from './internal/idempotency.js';

export const PACKAGE = {
  name: '@kf/actions',
  role: 'Typed action dispatcher',
  owns: [],
} as const;
