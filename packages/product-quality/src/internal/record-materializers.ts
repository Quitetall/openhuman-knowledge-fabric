import { ActionRejected, type ActionMaterializer } from '@kf/actions';
import type { Tx } from '@kf/database';
import {
  classificationFrom,
  createControlledObject,
  optionalString,
  requireString,
} from '@kf/record-atoms';

/**
 * Create acts for the R01 product and quality records (KF-SAS-RQ-143).
 *
 * product_system, requirement, risk, test, baseline and release had no create act, so the only
 * way one came to exist was an owner-credential insert. Each materializer here creates the
 * envelope and its typed row in the act's transaction, and nothing else.
 *
 * R01 declares states for these types and no lifecycle, so there is no initial state to read
 * from a state machine. Each is born in its FIRST declared state (object-types.yaml order) —
 * one rule for all six rather than a caller-chosen state, because a create act that let the
 * caller pick `retired` or `effective` would be an approval nobody performed.
 */

function oneOf(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
  values: readonly string[],
): string {
  const value = requireString(payload, key);
  if (!values.includes(value)) {
    throw new ActionRejected('precondition_failed', `${key} must be one of ${values.join(', ')}`, {
      key,
      value,
    });
  }
  return value;
}

/** A create act names no target; one that does is asking to change a record, which these cannot. */
function refuseTargets(actionType: string, targetIds: readonly string[]): void {
  if (targetIds.length > 0) {
    throw new ActionRejected(
      'precondition_failed',
      `${actionType} creates a record; it names none`,
      {
        actionType,
      },
    );
  }
}

/** Items a baseline or release contains: configuration items, by the existing item tables. */
function containedNodes(payload: Readonly<Record<string, unknown>> | undefined): string[] {
  const nodes = payload?.['contained_nodes'];
  if (!Array.isArray(nodes) || nodes.some((n) => typeof n !== 'string')) {
    throw new ActionRejected(
      'precondition_failed',
      'contained_nodes is required: the configuration items this record contains',
    );
  }
  const unique = [...new Set(nodes as string[])];
  if (unique.length !== nodes.length) {
    throw new ActionRejected('precondition_failed', 'contained_nodes names an item twice');
  }
  return unique;
}

async function insertItems(
  tx: Tx,
  table: 'product.baseline_item' | 'product.release_item',
  column: 'baseline_id' | 'release_id',
  id: string,
  nodes: readonly string[],
): Promise<void> {
  for (const node of nodes) {
    await tx.query(`insert into ${table} (${column}, configuration_item) values ($1, $2)`, [
      id,
      node,
    ]);
  }
}

export const registerProductSystem: ActionMaterializer = async (tx, request) => {
  refuseTargets(request.actionType, request.targetIds);
  const id = await createControlledObject(tx, {
    ...classificationFrom(request.payload),
    objectType: 'product_system',
    authorityDomain: 'configuration',
    lifecycleState: 'concept',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into product.product_system
       (id, product_kind, responsible_owner, configuration_authority)
     values ($1, $2, $3, $4)`,
    [
      id,
      oneOf(request.payload, 'product_kind', [
        'product',
        'platform',
        'subsystem',
        'service',
        'infrastructure',
      ]),
      requireString(request.payload, 'responsible_owner'),
      optionalString(request.payload, 'configuration_authority'),
    ],
  );
  return [id];
};

export const defineRequirement: ActionMaterializer = async (tx, request) => {
  refuseTargets(request.actionType, request.targetIds);
  const id = await createControlledObject(tx, {
    ...classificationFrom(request.payload),
    objectType: 'requirement',
    authorityDomain: 'qms',
    lifecycleState: 'draft',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into engineering.requirement (id, statement, requirement_kind, verification_method)
     values ($1, $2, $3, $4)`,
    [
      id,
      requireString(request.payload, 'statement'),
      oneOf(request.payload, 'requirement_kind', [
        'stakeholder',
        'system',
        'subsystem',
        'software',
        'process',
        'regulatory',
      ]),
      optionalString(request.payload, 'verification_method'),
    ],
  );
  return [id];
};

export const identifyRisk: ActionMaterializer = async (tx, request) => {
  refuseTargets(request.actionType, request.targetIds);
  const id = await createControlledObject(tx, {
    ...classificationFrom(request.payload),
    objectType: 'risk',
    authorityDomain: 'qms',
    lifecycleState: 'identified',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into engineering.risk (id, risk_kind, description, severity, probability)
     values ($1, $2, $3, $4, $5)`,
    [
      id,
      oneOf(request.payload, 'risk_kind', [
        'hazard',
        'project',
        'technical',
        'supplier',
        'cybersecurity',
        'business',
      ]),
      requireString(request.payload, 'description'),
      optionalString(request.payload, 'severity'),
      optionalString(request.payload, 'probability'),
    ],
  );
  return [id];
};

export const registerTest: ActionMaterializer = async (tx, request) => {
  refuseTargets(request.actionType, request.targetIds);
  const id = await createControlledObject(tx, {
    ...classificationFrom(request.payload),
    objectType: 'test',
    authorityDomain: 'qms',
    lifecycleState: 'draft',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into engineering.test (id, test_kind, objective, procedure_artifact, result_artifact)
     values ($1, $2, $3, $4, $5)`,
    [
      id,
      oneOf(request.payload, 'test_kind', ['method', 'case', 'protocol', 'execution']),
      requireString(request.payload, 'objective'),
      optionalString(request.payload, 'procedure_artifact'),
      optionalString(request.payload, 'result_artifact'),
    ],
  );
  return [id];
};

export const defineBaseline: ActionMaterializer = async (tx, request) => {
  refuseTargets(request.actionType, request.targetIds);
  const nodes = containedNodes(request.payload);
  const id = await createControlledObject(tx, {
    ...classificationFrom(request.payload),
    objectType: 'baseline',
    authorityDomain: 'configuration',
    lifecycleState: 'draft',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query('insert into product.baseline (id, baseline_kind) values ($1, $2)', [
    id,
    oneOf(request.payload, 'baseline_kind', [
      'functional',
      'allocated',
      'product',
      'project',
      'manufacturing',
      'verification',
    ]),
  ]);
  await insertItems(tx, 'product.baseline_item', 'baseline_id', id, nodes);
  return [id];
};

export const defineRelease: ActionMaterializer = async (tx, request) => {
  refuseTargets(request.actionType, request.targetIds);
  const nodes = containedNodes(request.payload);
  const id = await createControlledObject(tx, {
    ...classificationFrom(request.payload),
    objectType: 'release',
    authorityDomain: 'configuration',
    lifecycleState: 'draft',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query('insert into product.release (id, release_kind) values ($1, $2)', [
    id,
    oneOf(request.payload, 'release_kind', [
      'product',
      'document',
      'software',
      'manufacturing',
      'schema',
    ]),
  ]);
  await insertItems(tx, 'product.release_item', 'release_id', id, nodes);
  return [id];
};
