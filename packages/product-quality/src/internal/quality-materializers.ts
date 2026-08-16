import type { ActionMaterializer } from '@kf/actions';
import { createControlledObject, optionalString, requireString } from '@kf/record-atoms';

export const submitDocumentForReview: ActionMaterializer = async (tx, request) => {
  if (request.targetIds.length > 0) return [];
  const id = await createControlledObject(tx, {
    objectType: 'controlled_document',
    authorityDomain: 'qms',
    lifecycleState: 'draft',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into quality.controlled_document
       (id, document_class, document_number, revision, owning_role, content_version)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      id,
      requireString(request.payload, 'document_class'),
      requireString(request.payload, 'document_number'),
      requireString(request.payload, 'revision'),
      requireString(request.payload, 'owning_role'),
      optionalString(request.payload, 'content_version'),
    ],
  );
  return [id];
};

export const raiseNonconformity: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'nonconformity',
    authorityDomain: 'qms',
    lifecycleState: 'open',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into quality.nonconformity (id, severity, detected_on, description, subject_id)
     values ($1,$2, now(), $3, $4)`,
    [
      id,
      requireString(request.payload, 'severity'),
      requireString(request.payload, 'description'),
      optionalString(request.payload, 'subject_id'),
    ],
  );
  return [id];
};

export const openCapa: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'capa',
    authorityDomain: 'qms',
    lifecycleState: 'open',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into quality.capa
       (id, capa_kind, problem_statement, effectiveness_criterion)
     values ($1,$2,$3,$4)`,
    [
      id,
      requireString(request.payload, 'capa_kind'),
      requireString(request.payload, 'problem_statement'),
      requireString(request.payload, 'effectiveness_criterion'),
    ],
  );

  const answers = request.payload?.['nonconformities'];
  if (Array.isArray(answers)) {
    for (const ncId of answers) {
      await tx.query(
        'insert into quality.capa_nonconformity (capa_id, nonconformity_id) values ($1,$2)',
        [id, ncId],
      );
    }
  }
  return [id];
};

export const registerSupplier: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'supplier',
    authorityDomain: 'qms',
    lifecycleState: 'prospective',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into quality.supplier (id, organization, criticality, scope_of_supply)
     values ($1,$2,$3,$4)`,
    [
      id,
      requireString(request.payload, 'organization'),
      requireString(request.payload, 'criticality'),
      requireString(request.payload, 'scope_of_supply'),
    ],
  );
  return [id];
};

export const registerEquipment: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'equipment',
    authorityDomain: 'qms',
    lifecycleState: 'in_service',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into quality.equipment (id, asset_number, equipment_kind, calibration_due, location)
     values ($1,$2,$3,$4,$5)`,
    [
      id,
      requireString(request.payload, 'asset_number'),
      requireString(request.payload, 'equipment_kind'),
      optionalString(request.payload, 'calibration_due'),
      optionalString(request.payload, 'location'),
    ],
  );
  return [id];
};

export const receiveComplaint: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'complaint',
    authorityDomain: 'qms',
    lifecycleState: 'received',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
    classification: 'restricted',
  });
  await tx.query(
    `insert into quality.complaint (id, received_on, summary, reporter_reference, affected_binding)
     values ($1, now(), $2, $3, $4)`,
    [
      id,
      requireString(request.payload, 'summary'),
      optionalString(request.payload, 'reporter_reference'),
      optionalString(request.payload, 'affected_binding'),
    ],
  );
  return [id];
};
