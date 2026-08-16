import { ActionRejected, type ActionRequest } from '@kf/actions';
import type { Tx } from '@kf/database';

import { payloadString, rejected, requireAuthorityKind } from './validation.js';

export async function requirePromotionAuthority(tx: Tx, request: ActionRequest): Promise<void> {
  const authorityKind = requireAuthorityKind(
    payloadString(request, 'authorityKind'),
    'payload.authorityKind',
  );
  const requiredRole = `${authorityKind}_authority`;
  const effectiveAt = request.effectiveAt ?? new Date();
  const role = await tx.maybeOne<{ ok: boolean }>(
    `select exists (
       select 1
         from org.role_assignment assignment
         join org.person person on person.id = assignment.subject_id
         join core.object person_object on person_object.id = person.id
         join core.object role_object on role_object.id = assignment.id
        where assignment.id = $1
          and assignment.subject_id = $2
          and assignment.scope_id = $3
          and assignment.role_id = $4
          and person.organization = $3
          and person_object.object_type = 'person'
          and person_object.lifecycle_state = 'active'
          and person_object.organization_id = $3
          and role_object.object_type = 'role_assignment'
          and role_object.lifecycle_state = 'active'
          and role_object.organization_id = $3
          and assignment.valid_from <= $5
          and (assignment.valid_to is null or assignment.valid_to > $5)
     ) as ok`,
    [request.actingRoleId, request.actorId, request.organizationId, requiredRole, effectiveAt],
  );
  if (role?.ok !== true) {
    rejected(`authorize_ml_promotion requires ${requiredRole} scoped to the organization`);
  }
}

export async function requireTechnicalAuthority(tx: Tx, request: ActionRequest): Promise<void> {
  const effectiveAt = request.effectiveAt ?? new Date();
  const role = await tx.maybeOne<{ ok: boolean }>(
    `select exists (
       select 1 from org.role_assignment
        where id = $1 and subject_id = $2 and scope_id = $3
          and role_id = 'technical_authority'
          and valid_from <= $4 and (valid_to is null or valid_to > $4)
     ) as ok`,
    [request.actingRoleId, request.actorId, request.organizationId, effectiveAt],
  );
  if (role?.ok !== true) {
    rejected('authorize_ml_metric_stream requires technical_authority scoped to the organization');
  }
}

/** Provenance registration is non-promotional and may be emitted by the exact ML performer. */
export async function requireMlRegistryRecorder(tx: Tx, request: ActionRequest): Promise<void> {
  const effectiveAt = request.effectiveAt ?? new Date();
  const role = await tx.maybeOne<{ ok: boolean }>(
    `select exists (
       select 1 from org.role_assignment assignment
       join core.object assignment_object on assignment_object.id = assignment.id
       join core.object person_object on person_object.id = assignment.subject_id
      where assignment.id = $1
        and assignment.subject_id = $2
        and assignment.scope_id = $3
        and assignment.role_id in ('performer', 'technical_authority')
        and assignment.valid_from <= $4
        and (assignment.valid_to is null or assignment.valid_to > $4)
        and assignment_object.lifecycle_state = 'active'
        and person_object.lifecycle_state = 'active'
    ) as ok`,
    [request.actingRoleId, request.actorId, request.organizationId, effectiveAt],
  );
  if (role?.ok !== true) {
    rejected(`${request.actionType} requires performer or technical_authority in the organization`);
  }
}

export async function requireMetricStreamAuthorization(
  tx: Tx,
  request: ActionRequest,
): Promise<void> {
  const row = await tx.maybeOne<{ ok: boolean }>(
    `select ml.metric_stream_authorized($1, $2, $3, $4, $5) as ok`,
    [
      request.organizationId,
      request.actorId,
      request.actingRoleId,
      payloadString(request, 'runLineageId'),
      payloadString(request, 'metricDefinitionId'),
    ],
  );
  if (row?.ok !== true) {
    throw new ActionRejected(
      'object_not_visible',
      'the ML metric stream is unavailable to this actor and role',
    );
  }
}
