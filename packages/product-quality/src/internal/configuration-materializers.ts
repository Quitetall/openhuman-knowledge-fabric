import type { ActionMaterializer } from '@kf/actions';
import { createControlledObject, optionalString, requireString } from '@kf/record-atoms';

/**
 * A configuration item is DEFINED and PROMOTED by the same action.
 *
 * The same shape as `create_work_package`: the record is born in `proposed` and the action
 * that created it moves it to `active`. Splitting the two would leave a proposed item that
 * no action can advance, because nothing else drives that transition.
 */
export const promoteConfigurationItem: ActionMaterializer = async (tx, request) => {
  if (request.targetIds.length > 0) return [];
  const id = await createControlledObject(tx, {
    objectType: 'configuration_item',
    authorityDomain: 'configuration',
    lifecycleState: 'proposed',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into product.configuration_item
       (id, item_kind, part_number, revision_label, parent_system)
     values ($1,$2,$3,$4,$5)`,
    [
      id,
      requireString(request.payload, 'item_kind'),
      requireString(request.payload, 'part_number'),
      requireString(request.payload, 'revision_label'),
      requireString(request.payload, 'parent_system'),
    ],
  );
  return [id];
};

export const publishInterfaceContract: ActionMaterializer = async (tx, request) => {
  if (request.targetIds.length > 0) return [];
  const id = await createControlledObject(tx, {
    objectType: 'interface_contract',
    authorityDomain: 'configuration',
    lifecycleState: 'draft',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into product.interface_contract
       (id, interface_kind, generation, provider, consumer, specification)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      id,
      requireString(request.payload, 'interface_kind'),
      requireString(request.payload, 'generation'),
      requireString(request.payload, 'provider'),
      optionalString(request.payload, 'consumer'),
      requireString(request.payload, 'specification'),
    ],
  );
  return [id];
};

export const recordPhysicalBinding: ActionMaterializer = async (tx, request) => {
  if (request.targetIds.length > 0) return [];
  const id = await createControlledObject(tx, {
    objectType: 'physical_binding',
    authorityDomain: 'configuration',
    lifecycleState: 'planned',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into product.physical_binding
       (id, configuration_item, serial_number, installed_on, location)
     values ($1,$2,$3, now(), $4)`,
    [
      id,
      requireString(request.payload, 'configuration_item'),
      requireString(request.payload, 'serial_number'),
      optionalString(request.payload, 'location'),
    ],
  );
  return [id];
};
