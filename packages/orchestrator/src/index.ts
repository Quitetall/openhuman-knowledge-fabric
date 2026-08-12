/**
 * Knowledge Fabric composition root.
 *
 * Each package exports small action atoms. This module fuses them into one application while
 * refusing ambiguous ownership instead of silently choosing whichever module loaded last.
 */

import {
  createDispatcher,
  type ActionEffect,
  type ActionMaterializer,
  type DispatcherOptions,
  type PreconditionCheck,
} from '@kf/actions';
import type { Pool } from '@kf/database';
import type { DocumentActionAtoms } from '@kf/documents';
import {
  PRODUCT_QUALITY_EFFECTS,
  PRODUCT_QUALITY_MATERIALIZERS,
  PRODUCT_QUALITY_PRECONDITIONS,
} from '@kf/product-quality';
import {
  WORK_CONTROL_EFFECTS,
  WORK_CONTROL_MATERIALIZERS,
  WORK_CONTROL_PRECONDITIONS,
} from '@kf/work-control';

export interface ActionAtoms {
  readonly name: string;
  readonly materializers?: Readonly<Record<string, ActionMaterializer>>;
  readonly effects?: Readonly<Record<string, ActionEffect>>;
  readonly preconditions?: Readonly<Record<string, PreconditionCheck>>;
}

function mergeOwned<T>(
  groups: readonly ActionAtoms[],
  select: (group: ActionAtoms) => Readonly<Record<string, T>> | undefined,
): Record<string, T> {
  const result: Record<string, T> = {};
  const owners = new Map<string, string>();
  for (const group of groups) {
    for (const [name, atom] of Object.entries(select(group) ?? {})) {
      const owner = owners.get(name);
      if (owner !== undefined) {
        throw new Error(`action atom '${name}' is owned by both ${owner} and ${group.name}`);
      }
      owners.set(name, group.name);
      result[name] = atom;
    }
  }
  return result;
}

export function composeActionAtoms(
  groups: readonly ActionAtoms[],
): Required<Pick<DispatcherOptions, 'materializers' | 'effects' | 'preconditions'>> {
  return {
    materializers: mergeOwned(groups, (group) => group.materializers),
    effects: mergeOwned(groups, (group) => group.effects),
    preconditions: mergeOwned(groups, (group) => group.preconditions),
  };
}

const BUILT_IN_ATOMS: readonly ActionAtoms[] = [
  {
    name: 'work-control',
    materializers: WORK_CONTROL_MATERIALIZERS,
    effects: WORK_CONTROL_EFFECTS,
    preconditions: WORK_CONTROL_PRECONDITIONS,
  },
  {
    name: 'product-quality',
    materializers: PRODUCT_QUALITY_MATERIALIZERS,
    effects: PRODUCT_QUALITY_EFFECTS,
    preconditions: PRODUCT_QUALITY_PRECONDITIONS,
  },
];

export function fabricDispatcherOptions(
  documentAtoms?: DocumentActionAtoms,
): Required<Pick<DispatcherOptions, 'materializers' | 'effects' | 'preconditions'>> {
  return composeActionAtoms(
    documentAtoms === undefined ? BUILT_IN_ATOMS : [...BUILT_IN_ATOMS, documentAtoms],
  );
}

export function createFabricDispatcher(pool: Pool, documentAtoms?: DocumentActionAtoms) {
  return createDispatcher(pool, fabricDispatcherOptions(documentAtoms));
}

export const PACKAGE = {
  name: '@kf/orchestrator',
  role: 'Composition root for independently auditable Knowledge Fabric action atoms',
  owns: [],
} as const;
