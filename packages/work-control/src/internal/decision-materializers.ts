import type { ActionMaterializer } from '@kf/actions';
import { createControlledObject, requireString } from '../objects.js';

export const proposeDecision: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'decision_record',
    authorityDomain: 'engineering',
    lifecycleState: 'draft',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  return [id];
};

export const openChange: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'change_record',
    authorityDomain: 'engineering',
    lifecycleState: 'proposed',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into core.relation (relation_type, source_id, target_id, created_by, authorizing_action)
     values ('implements', $1, $2, $3, $4)`,
    [id, requireString(request.payload, 'decision_id'), request.actorId, null],
  );
  return [id];
};
