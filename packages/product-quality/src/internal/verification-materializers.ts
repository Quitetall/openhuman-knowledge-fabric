import type { ActionMaterializer } from '@kf/actions';
import { createControlledObject, optionalString, requireString } from '@kf/record-atoms';

export const proposeRiskControl: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'risk_control',
    authorityDomain: 'engineering',
    lifecycleState: 'proposed',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into engineering.risk_control (id, control_kind, mitigates, description)
     values ($1,$2,$3,$4)`,
    [
      id,
      requireString(request.payload, 'control_kind'),
      requireString(request.payload, 'mitigates'),
      requireString(request.payload, 'description'),
    ],
  );
  return [id];
};

export const defineTest: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'test_definition',
    authorityDomain: 'engineering',
    lifecycleState: 'draft',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into engineering.test_definition
       (id, method_kind, acceptance_criterion, verifies, procedure_version)
     values ($1,$2,$3,$4,$5)`,
    [
      id,
      requireString(request.payload, 'method_kind'),
      requireString(request.payload, 'acceptance_criterion'),
      requireString(request.payload, 'verifies'),
      optionalString(request.payload, 'procedure_version'),
    ],
  );
  return [id];
};

export const planTestExecution: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'test_execution',
    authorityDomain: 'engineering',
    lifecycleState: 'planned',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into engineering.test_execution (id, test_definition, configuration_item)
     values ($1,$2,$3)`,
    [
      id,
      requireString(request.payload, 'test_definition'),
      optionalString(request.payload, 'configuration_item'),
    ],
  );
  return [id];
};
