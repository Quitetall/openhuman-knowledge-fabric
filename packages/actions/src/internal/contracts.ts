import type { JsonValue } from '@kf/canonicalization';
import type { Tx } from '@kf/database';

/** Why an action was refused. Distinct codes let callers respond, not only log. */
export type ActionFailure =
  | 'unknown_action'
  | 'actor_not_authorized'
  | 'role_not_held'
  | 'object_not_visible'
  | 'version_conflict'
  | 'illegal_transition'
  | 'precondition_failed'
  | 'idempotency_conflict'
  | 'separation_of_duty'
  | 'reason_required';

export class ActionRejected extends Error {
  readonly failure: ActionFailure;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(failure: ActionFailure, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ActionRejected';
    this.failure = failure;
    this.detail = detail;
  }
}

export interface ActionRequest {
  readonly actionType: string;
  readonly actorId: string;
  readonly actingRoleId: string;
  readonly targetIds: readonly string[];
  readonly payload?: Readonly<Record<string, JsonValue>>;
  readonly reason?: string;
  /**
   * Stable across retries of same logical attempt. Network-timeout retry replays first result
   * instead of applying twice.
   */
  readonly idempotencyKey: string;
  readonly requestId?: string;
  /**
   * Organization scope and highest visible classification. Required because row-level
   * security scopes every target read to these values.
   */
  readonly organizationId: string;
  readonly maxClassification: string;
  /** When event occurred, which can differ from receipt time. */
  readonly effectiveAt?: Date;
  /** Row version caller read. Omit only for actions that create. */
  readonly expectedVersion?: number;
}

export interface ActionResult {
  readonly actionId: string;
  readonly status: 'applied';
  /** True when call replayed a previously recorded result. */
  readonly replayed: boolean;
  readonly objectIds: readonly string[];
  readonly auditDigest: string;
}

/** Public action execution seam over one caller-owned transaction. */
export type TransactionalActionDispatcher = (
  tx: Tx,
  request: ActionRequest,
) => Promise<ActionResult>;

/** Public action execution seam that owns transaction lifetime. */
export type ActionDispatcher = (request: ActionRequest) => Promise<ActionResult>;

/** Read-only rehearsal seam; successful preflight never grants write authority. */
export type TransactionalActionPreflight = (
  tx: Tx,
  request: ActionRequest,
  prospectiveObjects?: readonly ObjectRow[],
) => Promise<void>;

export interface ActionDefinition {
  readonly id: string;
  readonly transactional: boolean;
  readonly transitions: readonly { machine: string; from: string; to: string }[];
}

/** Action-specific check beyond registry transition and authority. */
export type PreconditionCheck = (
  tx: Tx,
  request: ActionRequest,
  objects: readonly ObjectRow[],
) => Promise<void>;

export interface ObjectRow extends Record<string, unknown> {
  id: string;
  object_type: string;
  lifecycle_state: string;
  row_version: string;
  organization_id: string;
  created_by: string;
}

/** Context shared by materializer and effect surrounding one action. */
export interface EffectContext {
  readonly actionId: string;
  readonly effectiveAt: Date;
}

/**
 * Create records before target locking; returned ids join caller targets.
 *
 * Transaction context is bound, but core.action does not exist yet. Materializers therefore
 * insert only: lifecycle movement and action references belong in effects.
 */
export type ActionMaterializer = (
  tx: Tx,
  request: ActionRequest,
  ctx: EffectContext,
) => Promise<readonly string[]>;

/**
 * Apply typed writes after core.action exists and transitions are applied. Effect failure
 * rolls back whole action transaction.
 */
export type ActionEffect = (
  tx: Tx,
  request: ActionRequest,
  objects: readonly ObjectRow[],
  ctx: EffectContext,
) => Promise<void>;

export interface DispatcherOptions {
  /**
   * Explicitly composed action types. Registry presence does not prove process loaded owning
   * action atom. Omission enables registry-wide kernel tooling; explicit empty set denies all.
   */
  readonly allowedActions?: ReadonlySet<string>;
  /**
   * Checks keyed by action type. An owned action needing domain checks must register them;
   * registry transition authority alone does not substitute for a missing check.
   */
  readonly preconditions?: Readonly<Record<string, PreconditionCheck>>;
  /** Actions that create records, keyed by action type. */
  readonly materializers?: Readonly<Record<string, ActionMaterializer>>;
  /** Typed writes performed by action, keyed by action type. */
  readonly effects?: Readonly<Record<string, ActionEffect>>;
  /**
   * Action type to object types whose creator cannot perform that action. Empty type list
   * restricts every target; named types avoid over-restricting multi-target actions.
   */
  readonly separationOfDuty?: Readonly<Record<string, readonly string[]>>;
  /** Actions that require nonblank reason. */
  readonly reasonRequired?: readonly string[];
}

export const DEFAULT_SEPARATION_OF_DUTY: Readonly<Record<string, readonly string[]>> = {
  issue_acceptance: ['work_execution'],
  accept_work_package: ['work_package'],
  approve_invoice: ['invoice'],
};

/** Exported so callers can solicit required reason before dispatch. */
export const DEFAULT_REASON_REQUIRED: readonly string[] = [
  'correct_record',
  'reject_decision',
  'amend_work_order',
];

export interface ResolvedDispatcherOptions {
  readonly allowedActions: ReadonlySet<string> | undefined;
  readonly separationOfDuty: Readonly<Record<string, readonly string[]>>;
  readonly reasonRequired: ReadonlySet<string>;
  readonly preconditions: Readonly<Record<string, PreconditionCheck>>;
  readonly materializers: Readonly<Record<string, ActionMaterializer>>;
  readonly effects: Readonly<Record<string, ActionEffect>>;
}

export function resolveDispatcherOptions(options: DispatcherOptions): ResolvedDispatcherOptions {
  return {
    allowedActions:
      options.allowedActions === undefined ? undefined : new Set(options.allowedActions),
    separationOfDuty: options.separationOfDuty ?? DEFAULT_SEPARATION_OF_DUTY,
    reasonRequired: new Set(options.reasonRequired ?? DEFAULT_REASON_REQUIRED),
    preconditions: options.preconditions ?? {},
    materializers: options.materializers ?? {},
    effects: options.effects ?? {},
  };
}
