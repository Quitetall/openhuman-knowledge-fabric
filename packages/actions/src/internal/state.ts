import { compareCanonicalText, digest } from '@kf/canonicalization';
import type { Tx } from '@kf/database';
import {
  ActionRejected,
  type ActionDefinition,
  type ActionRequest,
  type EffectContext,
  type ObjectRow,
  type ResolvedDispatcherOptions,
} from './contracts.js';

export interface PreparedActionState {
  readonly createdIds: readonly string[];
  readonly targetIds: readonly string[];
  readonly objects: readonly ObjectRow[];
  readonly transitions: ReadonlyMap<string, string>;
  readonly before: readonly { id: string; state: string }[];
  readonly beforeDigest: string;
  readonly afterDigest: string;
}

/** Materialize, lock, validate, and digest action targets without applying state changes. */
export async function prepareActionState(
  tx: Tx,
  request: ActionRequest,
  definition: ActionDefinition,
  options: ResolvedDispatcherOptions,
  ctx: EffectContext,
): Promise<PreparedActionState> {
  const materialize = options.materializers[request.actionType];
  const createdIds = materialize === undefined ? [] : await materialize(tx, request, ctx);
  const targetIds = [...request.targetIds, ...createdIds];
  if (targetIds.length === 0) {
    throw new ActionRejected(
      'precondition_failed',
      `${request.actionType} names no target and creates none`,
      { actionType: request.actionType },
    );
  }

  const objects = (
    await tx.query<ObjectRow>(
      `select id, object_type, lifecycle_state, row_version, organization_id, created_by
         from core.object where id = any($1::uuid[]) for update`,
      [targetIds],
    )
  ).sort((left, right) => compareCanonicalText(left.id, right.id));
  if (objects.length !== targetIds.length) {
    throw new ActionRejected(
      'object_not_visible',
      'one or more targets do not exist or are not visible to this actor',
      { requested: targetIds.length, found: objects.length },
    );
  }

  assertExpectedVersion(request, objects, createdIds);
  const transitions = resolveTransitions(request, objects, definition);
  assertSeparationOfDuty(request, objects, options.separationOfDuty);

  const check = options.preconditions[request.actionType];
  if (check !== undefined) await check(tx, request, objects);

  const before = objects.map((object) => ({
    id: object.id,
    state: object.lifecycle_state,
  }));
  const after = objects.map((object) => ({
    id: object.id,
    state: transitions.get(object.id) ?? object.lifecycle_state,
  }));
  return {
    createdIds,
    targetIds,
    objects,
    transitions,
    before,
    beforeDigest: digest(before),
    afterDigest: digest(after),
  };
}

function assertExpectedVersion(
  request: ActionRequest,
  objects: readonly ObjectRow[],
  createdIds: readonly string[],
): void {
  if (request.expectedVersion === undefined) return;
  const justCreated = new Set(createdIds);
  for (const object of objects) {
    if (justCreated.has(object.id)) continue;
    if (Number(object.row_version) !== request.expectedVersion) {
      throw new ActionRejected('version_conflict', 'the object changed since it was read', {
        objectId: object.id,
        expected: request.expectedVersion,
        actual: Number(object.row_version),
      });
    }
  }
}

function resolveTransitions(
  request: ActionRequest,
  objects: readonly ObjectRow[],
  definition: ActionDefinition,
): ReadonlyMap<string, string> {
  const transitions = new Map<string, string>();
  for (const object of objects) {
    const permitted = definition.transitions.filter(
      (transition) =>
        transition.machine === object.object_type && transition.from === object.lifecycle_state,
    );
    if (definition.transitions.length > 0 && permitted.length === 0) {
      throw new ActionRejected(
        'illegal_transition',
        `${request.actionType} cannot move ${object.object_type} out of '${object.lifecycle_state}'`,
        { objectId: object.id, from: object.lifecycle_state },
      );
    }
    if (permitted.length === 1) transitions.set(object.id, permitted[0]!.to);
    if (permitted.length > 1) {
      const chosen = chooseState(request.payload?.['to_state'], object);
      const target = permitted.find((transition) => transition.to === chosen);
      if (target === undefined) {
        throw new ActionRejected(
          'precondition_failed',
          `${request.actionType} from '${object.lifecycle_state}' is ambiguous; payload.to_state must be one of ${permitted
            .map((transition) => transition.to)
            .join(', ')}`,
          { objectId: object.id, candidates: permitted.map((transition) => transition.to) },
        );
      }
      transitions.set(object.id, target.to);
    }
  }
  return transitions;
}

function assertSeparationOfDuty(
  request: ActionRequest,
  objects: readonly ObjectRow[],
  rules: Readonly<Record<string, readonly string[]>>,
): void {
  const restrictedTypes = rules[request.actionType];
  if (restrictedTypes === undefined) return;
  for (const object of objects) {
    if (restrictedTypes.length > 0 && !restrictedTypes.includes(object.object_type)) continue;
    if (object.created_by === request.actorId) {
      throw new ActionRejected(
        'separation_of_duty',
        `${request.actionType} may not be performed by the actor who created the record`,
        { objectId: object.id, actorId: request.actorId },
      );
    }
  }
}

/** Resolve string, object-type, or object-id state selection for an ambiguous transition. */
function chooseState(toState: unknown, object: ObjectRow): unknown {
  if (toState === null || typeof toState !== 'object') return toState;
  const byKey = toState as Record<string, unknown>;
  return byKey[object.id] ?? byKey[object.object_type];
}
