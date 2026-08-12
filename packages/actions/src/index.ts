/**
 * The typed action dispatcher.
 *
 * Every controlled state change in the system passes through `executeAction`, in one
 * transaction, with authority resolved, preconditions checked, an audit event written and
 * an outbox row emitted. There is no other way to change a controlled fact — no
 * `PATCH /work-orders/123 {status}` anywhere in the API — because a record that can be
 * moved by field assignment cannot answer "who moved it, under what authority, and why".
 *
 * The fourteen steps run in the order the directive gives them. Order matters: authority is
 * resolved before anything is read, the row is locked before its version is checked, and
 * the audit event is written before the transaction commits, so a committed change without
 * a matching audit row is not a state the database can reach.
 */

import { chainDigest, digest, GENESIS_DIGEST, type JsonValue } from '@kf/canonicalization';
import {
  setAccessContext,
  setTransactionContext,
  withTransaction,
  type Pool,
  type Tx,
} from '@kf/database';

// ── failures ────────────────────────────────────────────────────────────────────────────

/** Why an action was refused. Distinct codes so a caller can respond, not just log. */
export type ActionFailure =
  | 'unknown_action'
  | 'actor_not_authorized'
  | 'role_not_held'
  | 'object_not_visible'
  | 'version_conflict'
  | 'illegal_transition'
  | 'precondition_failed'
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

// ── request and result ──────────────────────────────────────────────────────────────────

export interface ActionRequest {
  readonly actionType: string;
  readonly actorId: string;
  readonly actingRoleId: string;
  readonly targetIds: readonly string[];
  readonly payload?: Readonly<Record<string, JsonValue>>;
  readonly reason?: string;
  /**
   * Stable across retries of the SAME logical attempt. This is what makes a network
   * timeout safe: the retry replays the first result instead of applying twice.
   */
  readonly idempotencyKey: string;
  readonly requestId?: string;
  /**
   * The organization the actor is acting within, and how far up the classification ladder
   * they may see. Required: row-level security scopes every read to these, so without them
   * the dispatcher cannot see even the objects it is being asked to act on.
   */
  readonly organizationId: string;
  readonly maxClassification: string;
  /** When the event actually occurred, which is not always when we heard about it (§29.4). */
  readonly effectiveAt?: Date;
  /** The row_version the caller read. Omit only for actions that create. */
  readonly expectedVersion?: number;
}

export interface ActionResult {
  readonly actionId: string;
  readonly status: 'applied';
  /** True when this call replayed a previously-recorded result rather than applying. */
  readonly replayed: boolean;
  readonly objectIds: readonly string[];
  readonly auditDigest: string;
}

/**
 * What an action is permitted to do. Loaded from the registry, which the ontology compiler
 * seeds — so an action's authority comes from the reviewed ontology and not from a constant
 * someone edited in application code.
 */
interface ActionDefinition {
  readonly id: string;
  readonly transactional: boolean;
  /** Machine ids this action can drive, with the transitions it permits. */
  readonly transitions: readonly { machine: string; from: string; to: string }[];
}

/** Extra checks a specific action needs, beyond state and authority. */
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

/** What a materializer and an effect are told about the action running around them. */
export interface EffectContext {
  readonly actionId: string;
  readonly effectiveAt: Date;
}

/**
 * Create the record an action brings into existence, and return its id.
 *
 * Runs BEFORE the targets are locked, because a record that does not exist yet cannot be
 * locked. The ids it returns are appended to the caller's targets, so `submit_work_execution`
 * can create the execution and move the work package in one action.
 *
 * Restricted to what an INSERT can do: the transaction context is bound by this point, but
 * `core.action` is not yet written, so nothing here may move a lifecycle state or reference
 * the action row. Both of those belong in the effect.
 */
export type ActionMaterializer = (
  tx: Tx,
  request: ActionRequest,
  ctx: EffectContext,
) => Promise<readonly string[]>;

/**
 * The typed writes an action performs beyond moving state.
 *
 * Runs after `core.action` exists and after the transitions are applied, so it may reference
 * the action row. Part of the same transaction: an effect that fails fails the action, which
 * is the point — a work order whose typed row did not land is not a work order.
 */
export type ActionEffect = (
  tx: Tx,
  request: ActionRequest,
  objects: readonly ObjectRow[],
  ctx: EffectContext,
) => Promise<void>;

export interface DispatcherOptions {
  /**
   * Action-specific preconditions, keyed by action type.
   *
   * An action listed here without a check is a gap, not a default-allow: register a check
   * that throws until it is written, rather than letting the action through unverified.
   */
  readonly preconditions?: Readonly<Record<string, PreconditionCheck>>;
  /** Actions that create the record they control, keyed by action type. */
  readonly materializers?: Readonly<Record<string, ActionMaterializer>>;
  /** Typed writes performed by an action, keyed by action type. */
  readonly effects?: Readonly<Record<string, ActionEffect>>;
  /**
   * Actions where the actor may not be the person whose work is being judged, and the object
   * TYPES the restriction applies to.
   *
   * Scoped by type rather than blanket, because an action names more than the thing it
   * judges. `issue_acceptance` targets the work execution AND the work order it belongs to:
   * restricting on every target would mean whoever issued the order could never accept work
   * against it, which is not separation of duty — it is separation of the wrong two things,
   * and the workaround is for someone to issue orders they have no part in.
   *
   * An empty type list means every target, for actions where that is genuinely intended.
   */
  readonly separationOfDuty?: Readonly<Record<string, readonly string[]>>;
  /** Actions that must carry a reason. A silent correction is not a correction. */
  readonly reasonRequired?: readonly string[];
}

const DEFAULT_SEPARATION_OF_DUTY: Readonly<Record<string, readonly string[]>> = {
  issue_acceptance: ['work_execution'],
  accept_work_package: ['work_package'],
  approve_invoice: ['invoice'],
};
/**
 * Actions that must carry a reason, exported so the interface can ask instead of guessing.
 *
 * A UI holding its own copy of this list is a copy that goes stale — it would stop asking
 * for a reason on an action that started requiring one, and the user would meet a 400 with
 * no field to fill in.
 */
export const DEFAULT_REASON_REQUIRED: readonly string[] = [
  'correct_record',
  'reject_decision',
  'amend_work_order',
];

// ── dispatcher ──────────────────────────────────────────────────────────────────────────

export function createDispatcher(pool: Pool, options: DispatcherOptions = {}) {
  const separationOfDuty = options.separationOfDuty ?? DEFAULT_SEPARATION_OF_DUTY;
  const reasonRequired = new Set(options.reasonRequired ?? DEFAULT_REASON_REQUIRED);
  const preconditions = options.preconditions ?? {};
  const materializers = options.materializers ?? {};
  const effects = options.effects ?? {};

  return async function executeAction(request: ActionRequest): Promise<ActionResult> {
    return withTransaction(pool, async (tx) => {
      // Bind the reader's scope FIRST. Every subsequent read passes through row-level
      // security, so an action that skipped this would find none of its own targets.
      await setAccessContext(tx, {
        organizationId: request.organizationId,
        maxClassification: request.maxClassification,
      });

      // 13 (early). An idempotent replay must not re-run the work, so this is checked
      // before anything is locked or written, not after.
      const prior = await tx.maybeOne<{
        id: string;
        target_ids: string[];
        result: { audit_digest?: string };
      }>(
        `select id, target_ids, result from core.action
          where action_type = $1 and idempotency_key = $2`,
        [request.actionType, request.idempotencyKey],
      );
      if (prior !== undefined) {
        return {
          actionId: prior.id,
          status: 'applied' as const,
          replayed: true,
          // Creation actions had no caller-supplied target. Returning the retry's empty
          // array lost the object the first attempt created, so an orchestrator could not
          // continue from an idempotent replay. The committed action owns this answer.
          objectIds: [...prior.target_ids],
          auditDigest: prior.result.audit_digest ?? '',
        };
      }

      // 1-2. Authority. The action must exist in the registry, and the role must be one the
      // actor actually holds — checked against the database, not the caller's claim.
      const definition = await loadDefinition(tx, request.actionType);
      await assertRoleHeld(tx, request.actorId, request.actingRoleId);

      if (reasonRequired.has(request.actionType) && !request.reason?.trim()) {
        throw new ActionRejected('reason_required', `${request.actionType} requires a reason`, {
          actionType: request.actionType,
        });
      }

      // Identity and context are established BEFORE anything is created, because the write
      // guard refuses a controlled write with no actor — including the very first INSERT of
      // a record this action is bringing into existence.
      const actionId = (await tx.one<{ id: string }>('select uuidv7() as id')).id;
      const effectiveAt = request.effectiveAt ?? new Date();
      const ctx: EffectContext = { actionId, effectiveAt };

      await setTransactionContext(tx, {
        actorId: request.actorId,
        actingRoleId: request.actingRoleId,
        actionId,
        ...(request.requestId !== undefined ? { requestId: request.requestId } : {}),
      });

      const materialize = materializers[request.actionType];
      const created = materialize === undefined ? [] : await materialize(tx, request, ctx);
      const targetIds = [...request.targetIds, ...created];

      if (targetIds.length === 0) {
        // An action with no target changed nothing, and an audit entry saying so is worse
        // than useless: it records authority exercised over nothing.
        throw new ActionRejected(
          'precondition_failed',
          `${request.actionType} names no target and creates none`,
          { actionType: request.actionType },
        );
      }

      // 3-5. Read the targets under row-level security, locking them so a concurrent action
      // cannot move the state between our check and our write. FOR UPDATE is what makes the
      // version check meaningful rather than advisory.
      const objects = await tx.query<ObjectRow>(
        `select id, object_type, lifecycle_state, row_version, organization_id, created_by
           from core.object where id = any($1::uuid[]) for update`,
        [targetIds],
      );
      if (objects.length !== targetIds.length) {
        // Not visible and not existing are deliberately the same answer: distinguishing
        // them tells an unauthorized caller that a record exists.
        throw new ActionRejected(
          'object_not_visible',
          'one or more targets do not exist or are not visible to this actor',
          { requested: targetIds.length, found: objects.length },
        );
      }

      if (request.expectedVersion !== undefined) {
        const justCreated = new Set(created);
        for (const o of objects) {
          // A version the caller could not have read. Optimistic concurrency asks "is this
          // still what I saw"; for a row this action created a moment ago there is nothing
          // the caller saw, and failing it would punish callers who set expectedVersion
          // defensively on an action that both creates and moves.
          if (justCreated.has(o.id)) continue;
          if (Number(o.row_version) !== request.expectedVersion) {
            throw new ActionRejected('version_conflict', 'the object changed since it was read', {
              objectId: o.id,
              expected: request.expectedVersion,
              actual: Number(o.row_version),
            });
          }
        }
      }

      // 6. The transition must be one the ontology permits for this object's lifecycle.
      const transitions = new Map<string, string>();
      for (const o of objects) {
        const permitted = definition.transitions.filter(
          (t) => t.machine === o.object_type && t.from === o.lifecycle_state,
        );
        if (definition.transitions.length > 0 && permitted.length === 0) {
          throw new ActionRejected(
            'illegal_transition',
            `${request.actionType} cannot move ${o.object_type} out of '${o.lifecycle_state}'`,
            { objectId: o.id, from: o.lifecycle_state },
          );
        }
        if (permitted.length === 1) transitions.set(o.id, permitted[0]!.to);
        // More than one candidate means the payload must choose. Guessing would silently
        // pick a lifecycle branch on the caller's behalf.
        if (permitted.length > 1) {
          const chosen = chooseState(request.payload?.['to_state'], o);
          const target = permitted.find((t) => t.to === chosen);
          if (target === undefined) {
            throw new ActionRejected(
              'precondition_failed',
              `${request.actionType} from '${o.lifecycle_state}' is ambiguous; payload.to_state must be one of ${permitted
                .map((t) => t.to)
                .join(', ')}`,
              { objectId: o.id, candidates: permitted.map((t) => t.to) },
            );
          }
          transitions.set(o.id, target.to);
        }
      }

      // 8. Separation of duty, over the object types the restriction names.
      const restrictedTypes = separationOfDuty[request.actionType];
      if (restrictedTypes !== undefined) {
        for (const o of objects) {
          if (restrictedTypes.length > 0 && !restrictedTypes.includes(o.object_type)) continue;
          if (o.created_by === request.actorId) {
            throw new ActionRejected(
              'separation_of_duty',
              `${request.actionType} may not be performed by the actor who created the record`,
              { objectId: o.id, actorId: request.actorId },
            );
          }
        }
      }

      // 7. Action-specific preconditions. Financial invariants live here and in database
      // constraints both, so neither alone is the only thing standing in the way.
      const check = preconditions[request.actionType];
      if (check !== undefined) await check(tx, request, objects);

      const before = objects.map((o) => ({ id: o.id, state: o.lifecycle_state }));

      const head = await tx.maybeOne<{ digest: string }>(
        'select digest from core.audit_event order by seq desc limit 1',
      );
      const prevDigest = head?.digest ?? GENESIS_DIGEST;

      const beforeDigest = digest(before);
      const afterDigest = digest(
        objects.map((o) => ({ id: o.id, state: transitions.get(o.id) ?? o.lifecycle_state })),
      );

      const entry = {
        action_id: actionId,
        action_type: request.actionType,
        actor_id: request.actorId,
        acting_role_id: request.actingRoleId,
        object_ids: [...targetIds].sort(),
        effective_at: effectiveAt.toISOString(),
        before_digest: beforeDigest,
        after_digest: afterDigest,
      };
      const auditDigest = chainDigest(prevDigest, entry);

      await tx.query(
        `insert into core.action
           (id, action_type, actor_id, acting_role_id, target_ids, parameters, preconditions,
            idempotency_key, effective_at, request_id, reason, result_status, result)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'applied',$12)`,
        [
          actionId,
          request.actionType,
          request.actorId,
          request.actingRoleId,
          [...targetIds],
          JSON.stringify(request.payload ?? {}),
          JSON.stringify({ before, expected_version: request.expectedVersion ?? null }),
          request.idempotencyKey,
          effectiveAt.toISOString(),
          request.requestId ?? null,
          request.reason ?? null,
          JSON.stringify({ audit_digest: auditDigest }),
        ],
      );

      // 9. Apply, AFTER the action exists. The database trigger reads core.action to learn
      // which transition it is being asked to authorize; applying first would leave it able
      // to check only that SOME action permits the move, not that THIS one does.
      // row_version advances so a concurrent reader's expectedVersion stops validating.
      for (const [objectId, toState] of transitions) {
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

      // 10. The action's typed writes, now that `core.action` exists and can be referenced.
      // Same transaction: an effect that fails fails the action, because a work order whose
      // typed row did not land is not a work order.
      const effect = effects[request.actionType];
      if (effect !== undefined) await effect(tx, request, objects, ctx);

      // Exactly ONE audit event per action, because the action is the unit of authority and
      // the chain commits to it. A row per target would need a digest per target, and then
      // "what was authorized" would have to be reassembled from several rows that could
      // disagree. Multi-target actions record null and carry the full list on core.action.
      await tx.query(
        `insert into core.audit_event
           (action_id, actor_id, acting_role_id, action_type, object_id, effective_at,
            request_id, reason, before_digest, after_digest, prev_digest, digest)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          actionId,
          request.actorId,
          request.actingRoleId,
          request.actionType,
          targetIds.length === 1 ? targetIds[0] : null,
          effectiveAt.toISOString(),
          request.requestId ?? null,
          request.reason ?? null,
          beforeDigest,
          afterDigest,
          prevDigest,
          auditDigest,
        ],
      );

      // 12. Outbox, in the same transaction as the change. Delivery is the worker's problem;
      // "the change committed but the notification did not" is not.
      await tx.query(
        `insert into core.outbox (action_id, topic, payload)
         values ($1, $2, $3)`,
        [
          actionId,
          `kf.${request.actionType}`,
          JSON.stringify({ action_id: actionId, targets: targetIds }),
        ],
      );

      // 14. Commit is withTransaction's, on return.
      return {
        actionId,
        status: 'applied' as const,
        replayed: false,
        objectIds: [...targetIds],
        auditDigest,
      };
    });
  };
}

/**
 * Resolve `payload.to_state` for one target.
 *
 * A bare string is the common case and applies to every ambiguous target. But one action can
 * drive two machines that are BOTH ambiguous and want different destinations —
 * `record_payment_settlement` moves a payment to `settled` and its invoice to `paid` in the
 * same breath — and a single string cannot say that. So `to_state` may also be an object keyed
 * by object type, or by object id where two targets share a type.
 */
function chooseState(toState: unknown, o: ObjectRow): unknown {
  if (toState === null || typeof toState !== 'object') return toState;
  const byKey = toState as Record<string, unknown>;
  // Id first: it is the more specific of the two, and the only way to distinguish two
  // targets of the same type.
  return byKey[o.id] ?? byKey[o.object_type];
}

async function loadDefinition(tx: Tx, actionType: string): Promise<ActionDefinition> {
  const row = await tx.maybeOne<{ id: string; transactional: boolean }>(
    'select id, transactional from registry.action_type where id = $1',
    [actionType],
  );
  if (row === undefined) {
    throw new ActionRejected('unknown_action', `no such action type '${actionType}'`, {
      actionType,
    });
  }
  // Transitions come from the registry, which the ontology compiler seeds. An action's
  // authority is therefore whatever the reviewed ontology says, never a constant in code.
  const transitions = await tx.query<{ machine: string; from_state: string; to_state: string }>(
    `select object_type as machine, from_state, to_state
       from registry.state_transition where action_id = $1`,
    [actionType],
  );
  return {
    id: row.id,
    transactional: row.transactional,
    transitions: transitions.map((t) => ({
      machine: t.machine,
      from: t.from_state,
      to: t.to_state,
    })),
  };
}

async function assertRoleHeld(tx: Tx, actorId: string, roleId: string): Promise<void> {
  // org.holds_role checks BOTH that the assignment belongs to this person and that it is
  // within its effective window. Checking only ownership would let an expired authority
  // keep working — how a departed contractor carries on approving things.
  const held = await tx.maybeOne<{ ok: boolean }>('select org.holds_role($1, $2) as ok', [
    actorId,
    roleId,
  ]);
  if (held?.ok !== true) {
    throw new ActionRejected('role_not_held', 'the actor does not hold that role', {
      actorId,
      roleId,
    });
  }
}

export const PACKAGE = {
  name: '@kf/actions',
  role: 'Typed action dispatcher',
  owns: [],
} as const;
