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
  type ActionReceiptReader,
  type DispatcherOptions,
  type PreconditionCheck,
} from '@kf/actions';
import {
  ACCESS_ACTION_IDS,
  ACCESS_EFFECTS,
  AGENT_ACT_ACTION_IDS,
  AGENT_ACT_EFFECTS,
  AGENT_AT_HOME_ACTION_IDS,
  AGENT_AT_HOME_EFFECTS,
  AGENT_AT_HOME_PRECONDITIONS,
  AGENT_AT_HOME_RECEIPTS,
  AGENT_ACT_PRECONDITIONS,
  AGENT_ACT_RECEIPTS,
  AUTHORITY_ACTION_IDS,
  AUTHORITY_EFFECTS,
  ROLE_PRESET_ACTION_IDS,
  ROLE_PRESET_EFFECTS,
} from '@kf/authorization';
import type { Pool } from '@kf/database';
import { StoreRegistry, createStorageActionAtoms, type StorageActionAtoms } from '@kf/artifacts';
import { createOrganizationLifecycleAtoms } from '@kf/authorization';
import {
  ORGANIZATION_OVERVIEW_ACTION_IDS,
  ORGANIZATION_OVERVIEW_EFFECTS,
  ORGANIZATION_OVERVIEW_MATERIALIZERS,
  type DocumentActionAtoms,
} from '@kf/documents';
import { IDENTIFIER_ACTION_IDS, IDENTIFIER_EFFECTS, IDENTIFIER_RECEIPTS } from '@kf/identifiers';
import {
  QUALIFICATION_ACTION_IDS,
  QUALIFICATION_EFFECTS,
  QUALIFICATION_MATERIALIZERS,
  QUALIFICATION_PRECONDITIONS,
  QUALIFICATION_RECEIPTS,
} from '@kf/qualification';
import { WARRANT_ACTION_IDS, WARRANT_EFFECTS, WARRANT_MATERIALIZERS } from '@kf/warrants';
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
  OBSERVATION_ACTION_IDS,
  OBSERVATION_EFFECTS,
  OBSERVATION_MATERIALIZERS,
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
  readonly receipts?: Readonly<Record<string, ActionReceiptReader>>;
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
  Pick<
    DispatcherOptions,
    'allowedActions' | 'materializers' | 'effects' | 'preconditions' | 'receipts'
  >
> {
  const owners = collectOwners(groups);
  return {
    allowedActions: new Set(owners.keys()),
    materializers: mergeOwnedHandlers(groups, owners, (group) => group.materializers),
    effects: mergeOwnedHandlers(groups, owners, (group) => group.effects),
    preconditions: mergeOwnedHandlers(groups, owners, (group) => group.preconditions),
    receipts: mergeOwnedHandlers(groups, owners, (group) => group.receipts),
  };
}

const BUILT_IN_ATOMS: readonly ActionAtoms[] = [
  // The organization lifecycle (ADR: R01 approved the states and no transitions). Built in
  // rather than injected: it needs no store, no key and no configuration, so a deployment that
  // forgot to wire it would be a deployment where an organization cannot be retired — which is
  // the state this group exists to end.
  createOrganizationLifecycleAtoms(),
  {
    // Granting a clearance is dispatchable once SOMEBODY in the organization already holds one.
    // The first grant cannot be — dispatch binds authoritative clearance before effects — and is
    // made by `apps/api/src/admin/grant-authority.ts`, which shares this package's single
    // `insertPersonClearance` rather than writing its own.
    name: 'authority',
    ownedActions: [...AUTHORITY_ACTION_IDS, ...ACCESS_ACTION_IDS],
    effects: { ...AUTHORITY_EFFECTS, ...ACCESS_EFFECTS },
  },
  {
    // Roles as composable presets of scope (ADR 0040, KF-SAS-RQ-269). Their own group so the
    // acts that change what every holder of a role may read are visible here as one set.
    name: 'role-presets',
    ownedActions: ROLE_PRESET_ACTION_IDS,
    effects: ROLE_PRESET_EFFECTS,
  },
  {
    // The living organization overview (ADR 0040): a record declared by an act, whose
    // statements are generated per reader and never stored. Built in, like the presets, because
    // it needs no store, key or configuration.
    name: 'organization-overview',
    ownedActions: ORGANIZATION_OVERVIEW_ACTION_IDS,
    materializers: ORGANIZATION_OVERVIEW_MATERIALIZERS,
    effects: ORGANIZATION_OVERVIEW_EFFECTS,
  },
  {
    // Agents submit; authority verifies (ADR 0040, 20261007100000): the verification policy, an
    // agent's proposal of an institutional act, and its person's answer. Built in: a deployment
    // without them would have agents whose institutional proposals had nowhere to wait.
    name: 'agents-as-colleagues',
    ownedActions: AGENT_ACT_ACTION_IDS,
    effects: AGENT_ACT_EFFECTS,
    preconditions: AGENT_ACT_PRECONDITIONS,
    receipts: AGENT_ACT_RECEIPTS,
  },
  {
    // The agent at home (ADR 0040, 20261007300000): what may leave the host per organization, and a
    // person's own notification setting.
    name: 'agent-at-home',
    ownedActions: AGENT_AT_HOME_ACTION_IDS,
    effects: AGENT_AT_HOME_EFFECTS,
    preconditions: AGENT_AT_HOME_PRECONDITIONS,
    receipts: AGENT_AT_HOME_RECEIPTS,
  },
  {
    // Qualification is evidence against a versioned pack (ADR 0038, 20261007400000): packs,
    // records, credits. Built in: joining (ADR 0040 decision 12) needs no store or configuration,
    // and an act that declares requires_qualification is checked whether or not any pack exists.
    name: 'qualification',
    ownedActions: QUALIFICATION_ACTION_IDS,
    materializers: QUALIFICATION_MATERIALIZERS,
    effects: QUALIFICATION_EFFECTS,
    preconditions: QUALIFICATION_PRECONDITIONS,
    receipts: QUALIFICATION_RECEIPTS,
  },
  {
    // R6 allocation (ADR 0018). The receipt reader is what puts the allocated identifier in
    // the action result — and in a replay's.
    name: 'identifiers',
    ownedActions: IDENTIFIER_ACTION_IDS,
    effects: IDENTIFIER_EFFECTS,
    receipts: IDENTIFIER_RECEIPTS,
  },
  {
    // OpenWarrant SAS §67 (ADR 0019): all thirty-two names owned here, so the vocabulary is
    // complete on the wire; the ADR lists which write nothing typed yet.
    name: 'warrants',
    ownedActions: WARRANT_ACTION_IDS,
    materializers: WARRANT_MATERIALIZERS,
    effects: WARRANT_EFFECTS,
  },
  {
    name: 'work-control',
    ownedActions: WORK_CONTROL_ACTION_IDS,
    materializers: WORK_CONTROL_MATERIALIZERS,
    effects: WORK_CONTROL_EFFECTS,
    preconditions: WORK_CONTROL_PRECONDITIONS,
  },
  {
    // ADR 0034 (proposed): capture is cheap, promotion is institutional. Its own group so the
    // capture seam's ownership is visible here rather than folded into work control's list.
    name: 'observations',
    ownedActions: OBSERVATION_ACTION_IDS,
    materializers: OBSERVATION_MATERIALIZERS,
    effects: OBSERVATION_EFFECTS,
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
  // With no configured stores the storage actions exist and refuse honestly ("store 'x' is
  // not configured") rather than being an action nobody owns.
  storageAtoms: StorageActionAtoms = createStorageActionAtoms(new StoreRegistry({})),
): Required<
  Pick<
    DispatcherOptions,
    'allowedActions' | 'materializers' | 'effects' | 'preconditions' | 'receipts'
  >
> {
  return composeActionAtoms([
    ...BUILT_IN_ATOMS,
    secureObjectAtoms,
    mlAtoms,
    ...(documentAtoms === undefined ? [] : [documentAtoms]),
    storageAtoms,
  ]);
}

export function createFabricDispatcher(
  pool: Pool,
  documentAtoms?: DocumentActionAtoms,
  secureObjectAtoms?: SecureObjectActionAtoms,
  mlAtoms?: MlActionAtoms,
  storageAtoms?: StorageActionAtoms,
) {
  return createDispatcher(
    pool,
    fabricDispatcherOptions(documentAtoms, secureObjectAtoms, mlAtoms, storageAtoms),
  );
}

/** Compose several typed actions under one caller-owned transaction. */
export function createFabricTransactionalDispatcher(
  documentAtoms?: DocumentActionAtoms,
  secureObjectAtoms?: SecureObjectActionAtoms,
  mlAtoms?: MlActionAtoms,
  storageAtoms?: StorageActionAtoms,
) {
  return createTransactionalDispatcher(
    fabricDispatcherOptions(documentAtoms, secureObjectAtoms, mlAtoms, storageAtoms),
  );
}

/** Read-only early refusal seam; passing it never replaces final typed-action execution. */
export function createFabricTransactionalPreflight(
  documentAtoms?: DocumentActionAtoms,
  secureObjectAtoms?: SecureObjectActionAtoms,
  mlAtoms?: MlActionAtoms,
  storageAtoms?: StorageActionAtoms,
) {
  return createTransactionalPreflight(
    fabricDispatcherOptions(documentAtoms, secureObjectAtoms, mlAtoms, storageAtoms),
  );
}

export const PACKAGE = {
  name: '@kf/orchestrator',
  role: 'Composition root for independently auditable Knowledge Fabric action atoms',
  owns: [],
} as const;
