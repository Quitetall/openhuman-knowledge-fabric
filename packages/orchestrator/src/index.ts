/**
 * Knowledge Fabric composition root.
 *
 * Each package exports small action atoms. This module fuses them into one application while
 * refusing ambiguous ownership instead of silently choosing whichever module loaded last.
 */

import {
  createDispatcher,
  createTransactionalDispatcher,
  createTransactionalPreflight,
  type ActionEffect,
  type ActionMaterializer,
  type DispatcherOptions,
  type PreconditionCheck,
} from '@kf/actions';
import type { Pool } from '@kf/database';
import type { DocumentActionAtoms } from '@kf/documents';
import {
  createMlActionAtoms,
  createSecureObjectActionAtoms,
  type MlActionAtoms,
  type SecureObjectActionAtoms,
} from '@kf/integration';
import {
  PRODUCT_QUALITY_ACTION_IDS,
  PRODUCT_QUALITY_EFFECTS,
  PRODUCT_QUALITY_MATERIALIZERS,
  PRODUCT_QUALITY_PRECONDITIONS,
} from '@kf/product-quality';
import {
  WORK_CONTROL_ACTION_IDS,
  WORK_CONTROL_EFFECTS,
  WORK_CONTROL_MATERIALIZERS,
  WORK_CONTROL_PRECONDITIONS,
} from '@kf/work-control';

export interface ActionAtoms {
  readonly name: string;
  /** Exact action types this group owns, including handler-free registry transitions. */
  readonly ownedActions: readonly string[];
  readonly materializers?: Readonly<Record<string, ActionMaterializer>>;
  readonly effects?: Readonly<Record<string, ActionEffect>>;
  readonly preconditions?: Readonly<Record<string, PreconditionCheck>>;
}

function collectOwners(groups: readonly ActionAtoms[]): Map<string, ActionAtoms> {
  const owners = new Map<string, ActionAtoms>();
  for (const group of groups) {
    for (const actionType of group.ownedActions) {
      if (actionType.trim().length === 0) {
        throw new Error(`action group ${group.name} declares an empty action id`);
      }
      const owner = owners.get(actionType);
      if (owner !== undefined) {
        throw new Error(`action '${actionType}' is owned by both ${owner.name} and ${group.name}`);
      }
      owners.set(actionType, group);
    }
  }
  return owners;
}

function mergeOwnedHandlers<T>(
  groups: readonly ActionAtoms[],
  owners: ReadonlyMap<string, ActionAtoms>,
  select: (group: ActionAtoms) => Readonly<Record<string, T>> | undefined,
): Record<string, T> {
  const result: Record<string, T> = {};
  for (const group of groups) {
    for (const [name, atom] of Object.entries(select(group) ?? {})) {
      const owner = owners.get(name);
      if (owner === undefined) {
        throw new Error(`action handler '${name}' from ${group.name} has no declared owner`);
      }
      if (owner !== group) {
        throw new Error(
          `action handler '${name}' from ${group.name} belongs to declared owner ${owner.name}`,
        );
      }
      result[name] = atom;
    }
  }
  return result;
}

export function composeActionAtoms(
  groups: readonly ActionAtoms[],
): Required<
  Pick<DispatcherOptions, 'allowedActions' | 'materializers' | 'effects' | 'preconditions'>
> {
  const owners = collectOwners(groups);
  return {
    allowedActions: new Set(owners.keys()),
    materializers: mergeOwnedHandlers(groups, owners, (group) => group.materializers),
    effects: mergeOwnedHandlers(groups, owners, (group) => group.effects),
    preconditions: mergeOwnedHandlers(groups, owners, (group) => group.preconditions),
  };
}

const BUILT_IN_ATOMS: readonly ActionAtoms[] = [
  {
    name: 'work-control',
    ownedActions: WORK_CONTROL_ACTION_IDS,
    materializers: WORK_CONTROL_MATERIALIZERS,
    effects: WORK_CONTROL_EFFECTS,
    preconditions: WORK_CONTROL_PRECONDITIONS,
  },
  {
    name: 'product-quality',
    ownedActions: PRODUCT_QUALITY_ACTION_IDS,
    materializers: PRODUCT_QUALITY_MATERIALIZERS,
    effects: PRODUCT_QUALITY_EFFECTS,
    preconditions: PRODUCT_QUALITY_PRECONDITIONS,
  },
];

export function fabricDispatcherOptions(
  documentAtoms?: DocumentActionAtoms,
  secureObjectAtoms: SecureObjectActionAtoms = createSecureObjectActionAtoms(),
  mlAtoms: MlActionAtoms = createMlActionAtoms(),
): Required<
  Pick<DispatcherOptions, 'allowedActions' | 'materializers' | 'effects' | 'preconditions'>
> {
  return composeActionAtoms([
    ...BUILT_IN_ATOMS,
    secureObjectAtoms,
    mlAtoms,
    ...(documentAtoms === undefined ? [] : [documentAtoms]),
  ]);
}

export function createFabricDispatcher(
  pool: Pool,
  documentAtoms?: DocumentActionAtoms,
  secureObjectAtoms?: SecureObjectActionAtoms,
  mlAtoms?: MlActionAtoms,
) {
  return createDispatcher(pool, fabricDispatcherOptions(documentAtoms, secureObjectAtoms, mlAtoms));
}

/** Compose several typed actions under one caller-owned transaction. */
export function createFabricTransactionalDispatcher(
  documentAtoms?: DocumentActionAtoms,
  secureObjectAtoms?: SecureObjectActionAtoms,
  mlAtoms?: MlActionAtoms,
) {
  return createTransactionalDispatcher(
    fabricDispatcherOptions(documentAtoms, secureObjectAtoms, mlAtoms),
  );
}

/** Read-only early refusal seam; passing it never replaces final typed-action execution. */
export function createFabricTransactionalPreflight(
  documentAtoms?: DocumentActionAtoms,
  secureObjectAtoms?: SecureObjectActionAtoms,
  mlAtoms?: MlActionAtoms,
) {
  return createTransactionalPreflight(
    fabricDispatcherOptions(documentAtoms, secureObjectAtoms, mlAtoms),
  );
}

export const PACKAGE = {
  name: '@kf/orchestrator',
  role: 'Composition root for independently auditable Knowledge Fabric action atoms',
  owns: [],
} as const;
