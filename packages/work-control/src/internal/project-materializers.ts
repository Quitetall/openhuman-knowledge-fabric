import type { ActionMaterializer } from '@kf/actions';
import {
  createControlledObject,
  optionalString,
  requireCurrency,
  requireMinor,
  requireString,
} from '../objects.js';

export const createInitiative: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'initiative_project',
    authorityDomain: 'project',
    lifecycleState: 'captured',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into work.initiative_project (id, project_code, objective, sponsor_id)
     values ($1, $2, $3, $4)`,
    [
      id,
      optionalString(request.payload, 'project_code'),
      requireString(request.payload, 'objective'),
      requireString(request.payload, 'sponsor_id'),
    ],
  );
  return [id];
};

export const createWorkPackage: ActionMaterializer = async (tx, request) => {
  const projectId = requireString(request.payload, 'project_id');
  const id = await createControlledObject(tx, {
    objectType: 'work_package',
    authorityDomain: 'project',
    lifecycleState: 'planned',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });

  const { next } = await tx.one<{ next: number }>(
    `select coalesce(max(sequence_no), 0) + 1 as next from work.work_package
      where project_id = (select id from work.initiative_project where id = $1 for update)`,
    [projectId],
  );
  await tx.query(
    `insert into work.work_package
       (id, project_id, sequence_no, scope_statement, acceptance_criterion,
        planned_value_minor, currency)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      projectId,
      next,
      requireString(request.payload, 'scope_statement'),
      requireString(request.payload, 'acceptance_criterion'),
      request.payload?.['planned_value_minor'] ?? null,
      optionalString(request.payload, 'currency'),
    ],
  );
  return [id];
};

export const issueWorkOrder: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'work_order',
    authorityDomain: 'project',
    lifecycleState: 'draft',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
    classification: 'restricted',
  });
  await tx.query(
    `insert into work.work_order
       (id, project_id, engagement_id, order_number, scope_summary, ceiling_minor, currency,
        issued_on)
     values ($1,$2,$3,$4,$5,$6,$7, current_date)`,
    [
      id,
      requireString(request.payload, 'project_id'),
      requireString(request.payload, 'engagement_id'),
      requireString(request.payload, 'order_number'),
      requireString(request.payload, 'scope_summary'),
      requireMinor(request.payload, 'ceiling_minor'),
      requireCurrency(request.payload),
    ],
  );

  const packages = request.payload?.['work_package_ids'];
  if (Array.isArray(packages)) {
    for (const packageId of packages) {
      await tx.query(
        'insert into work.work_order_scope (work_order_id, work_package_id) values ($1,$2)',
        [id, packageId],
      );
    }
  }
  return [id];
};

export const submitWorkExecution: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'work_execution',
    authorityDomain: 'project',
    lifecycleState: 'draft',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into work.work_execution
       (id, work_order_id, performed_by, submitted_by, recorded_by, period_start, period_end,
        effort_hours, summary, claimed_value_minor, currency)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id,
      requireString(request.payload, 'work_order_id'),
      requireString(request.payload, 'performed_by'),
      requireString(request.payload, 'submitted_by'),
      request.actorId,
      requireString(request.payload, 'period_start'),
      requireString(request.payload, 'period_end'),
      request.payload?.['effort_hours'] ?? null,
      requireString(request.payload, 'summary'),
      requireMinor(request.payload, 'claimed_value_minor'),
      requireCurrency(request.payload),
    ],
  );
  return [id];
};
