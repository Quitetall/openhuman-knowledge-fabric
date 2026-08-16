import { ActionRejected, type ActionRequest, type ObjectRow } from '@kf/actions';
import type { Tx } from '@kf/database';
import {
  SECURE_OBJECT_ACTION_ROLES,
  type AuthorityKeyRevocationReason,
  type ErasureRequest,
  type ReadCapability,
  type ReadCapabilityRequest,
  SecureObjectRejected,
  type SecureObjectActionType,
  type SecureObjectPurpose,
} from './contracts.js';
import { exactObject, type ExactObjectRow } from './rows.js';

export function payloadString(request: ActionRequest, key: string): string {
  const value = request.payload?.[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ActionRejected(
      'precondition_failed',
      `${request.actionType} requires payload.${key}`,
    );
  }
  return value;
}

export function payloadNullableString(request: ActionRequest, key: string): string | null {
  const value = request.payload?.[key];
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new ActionRejected(
      'precondition_failed',
      `${request.actionType} requires payload.${key} to be a string or null`,
    );
  }
  return value;
}

export function payloadInteger(request: ActionRequest, key: string): number {
  const value = request.payload?.[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ActionRejected(
      'precondition_failed',
      `${request.actionType} requires integer payload.${key}`,
    );
  }
  return value;
}

export function payloadPurpose(request: ActionRequest): SecureObjectPurpose {
  const value = payloadString(request, 'purpose');
  if (
    value !== 'ml_training' &&
    value !== 'ml_evaluation' &&
    value !== 'data_quality_validation' &&
    value !== 'authorized_erasure'
  ) {
    throw new ActionRejected('precondition_failed', 'payload.purpose is not a safe purpose');
  }
  return value;
}

export function payloadKeyRevocationReason(request: ActionRequest): AuthorityKeyRevocationReason {
  const value = payloadString(request, 'reasonCode');
  if (
    value !== 'key_rotation' &&
    value !== 'key_compromise' &&
    value !== 'authority_retirement' &&
    value !== 'administrative'
  ) {
    throw new ActionRejected('precondition_failed', 'payload.reasonCode is not recognized');
  }
  return value;
}

export function requireOrganizationTarget(
  request: ActionRequest,
  objects: readonly ObjectRow[],
): void {
  if (
    request.targetIds.length !== 1 ||
    request.targetIds[0] !== request.organizationId ||
    objects.length !== 1 ||
    objects[0]?.id !== request.organizationId ||
    objects[0]?.object_type !== 'organization' ||
    objects[0]?.organization_id !== request.organizationId
  ) {
    throw new ActionRejected(
      'precondition_failed',
      `${request.actionType} must target exactly its visible owning organization object`,
    );
  }
}

export async function requireSecureObjectRoleCategory(
  tx: Tx,
  request: ActionRequest,
): Promise<void> {
  const allowed = SECURE_OBJECT_ACTION_ROLES[request.actionType as SecureObjectActionType];
  if (allowed === undefined) {
    throw new ActionRejected(
      'precondition_failed',
      `${request.actionType} has no secure-object role policy`,
    );
  }
  const effectiveAt = request.effectiveAt ?? new Date();
  const role = await tx.maybeOne<{ role_id: string }>(
    `select role_id from org.role_assignment
      where id = $1
        and subject_id = $2
        and scope_id = $3
        and role_id = any($4::text[])
        and valid_from <= $5
        and (valid_to is null or valid_to > $5)`,
    [request.actingRoleId, request.actorId, request.organizationId, [...allowed], effectiveAt],
  );
  if (role === undefined) {
    throw new ActionRejected(
      'precondition_failed',
      `${request.actionType} requires ${allowed.join(' or ')} scoped to the owning organization`,
    );
  }
}

export async function loadReadRequest(tx: Tx, requestId: string): Promise<ReadCapabilityRequest> {
  const row = await tx.maybeOne<ExactObjectRow>(
    `select id, organization_id, classification_id, external_authority_ref,
            external_revision_ref, external_content_sha256, purpose,
            workload_identity_ref, policy_decision_ref, requested_at, expires_at,
            requested_at as issued_at, id as request_id
       from secure_object.capability_request where id = $1`,
    [requestId],
  );
  if (row === undefined) {
    throw new SecureObjectRejected('request_unavailable', 'secure-object request is unavailable');
  }
  return {
    id: row.id,
    ...exactObject(row),
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
  };
}

export async function loadReadCapability(tx: Tx, capabilityId: string): Promise<ReadCapability> {
  const row = await tx.maybeOne<ExactObjectRow>(
    `select i.id, i.request_id, r.organization_id, r.classification_id,
            r.external_authority_ref, r.external_revision_ref, i.external_content_sha256,
            i.purpose, i.workload_identity_ref, i.policy_decision_ref, r.requested_at,
            i.issued_at, r.expires_at
       from secure_object.capability_issue i
       join secure_object.capability_request r on r.id = i.request_id
      where i.id = $1`,
    [capabilityId],
  );
  if (row === undefined) {
    throw new SecureObjectRejected(
      'capability_unavailable',
      'secure-object capability is unavailable',
    );
  }
  return {
    id: row.id,
    requestId: row.request_id,
    ...exactObject(row),
    access: 'read_exact_revision',
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
  };
}

export async function loadErasureRequest(tx: Tx, requestId: string): Promise<ErasureRequest> {
  const row = await tx.maybeOne<ExactObjectRow>(
    `select id, organization_id, classification_id, external_authority_ref,
            external_revision_ref, external_content_sha256, purpose,
            workload_identity_ref, policy_decision_ref, requested_at,
            requested_at as issued_at, requested_at as expires_at, id as request_id
       from secure_object.erasure_request where id = $1`,
    [requestId],
  );
  if (row === undefined || row.purpose !== 'authorized_erasure') {
    throw new SecureObjectRejected('erasure_unavailable', 'erasure request is unavailable');
  }
  return {
    id: row.id,
    ...exactObject(row),
    purpose: 'authorized_erasure',
    requestedAt: row.requested_at,
  };
}
