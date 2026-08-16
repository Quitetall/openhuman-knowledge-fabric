import {
  ActionRejected,
  type ActionRequest,
  type ObjectRow,
  type PreconditionCheck,
} from '@kf/actions';
import type { Tx } from '@kf/database';
import { DOCUMENT_AUTHOR_ROLES, TECHNICAL_AUTHORITY_ROLE } from './action-types.js';
import { refuseDocument } from './action-payload.js';

export function refuseDocumentAuthority(
  rule: string,
  message: string,
  detail: Readonly<Record<string, unknown>>,
): never {
  throw new ActionRejected('actor_not_authorized', `${rule}: ${message}`, { rule, ...detail });
}

export async function assertDocumentRole(
  tx: Tx,
  request: ActionRequest,
  objects: readonly ObjectRow[],
  allowedRoles: ReadonlySet<string>,
): Promise<void> {
  const assignment = await tx.maybeOne<{ role_id: string; scope_id: string }>(
    `select role_id, scope_id
       from org.role_assignment
      where id = $1 and subject_id = $2
        and valid_from <= now() and (valid_to is null or valid_to > now())`,
    [request.actingRoleId, request.actorId],
  );
  if (assignment === undefined || !allowedRoles.has(assignment.role_id)) {
    refuseDocumentAuthority(
      'KF-DOC-AUTH-001',
      `${request.actionType} requires an allowed document role`,
      { actionType: request.actionType, allowedRoles: [...allowedRoles] },
    );
  }
  const permittedScopes = new Set([request.organizationId, ...objects.map((object) => object.id)]);
  if (!permittedScopes.has(assignment.scope_id)) {
    refuseDocumentAuthority(
      'KF-DOC-AUTH-002',
      'document authority must be scoped to the target or its organization',
      { actionType: request.actionType, scopeId: assignment.scope_id },
    );
  }
}

export type DocumentPolicy = 'ordinary' | 'controlled' | 'regulated';

export function requireDocumentPolicy(request: ActionRequest): DocumentPolicy {
  const policy = request.payload?.['document_policy'];
  if (policy !== 'ordinary' && policy !== 'controlled' && policy !== 'regulated') {
    throw new ActionRejected(
      'precondition_failed',
      'KF-DOC-POLICY-001: document_policy must be ordinary, controlled, or regulated',
      { rule: 'KF-DOC-POLICY-001', actionType: request.actionType },
    );
  }
  return policy;
}

export async function assertQualityAuthorityWhenRequired(
  tx: Tx,
  request: ActionRequest,
  objects: readonly ObjectRow[],
  policy: DocumentPolicy,
): Promise<void> {
  if (policy === 'ordinary') return;
  const qualityRoleAssignmentId = request.payload?.['quality_role_assignment_id'];
  const assignment =
    typeof qualityRoleAssignmentId === 'string'
      ? await tx.maybeOne<{ role_id: string; scope_id: string }>(
          `select role_id, scope_id
             from org.role_assignment
            where id = $1 and subject_id = $2
              and valid_from <= now() and (valid_to is null or valid_to > now())`,
          [qualityRoleAssignmentId, request.actorId],
        )
      : undefined;
  if (assignment?.role_id !== 'quality_authority') {
    refuseDocumentAuthority(
      'KF-DOC-AUTH-003',
      `${policy} document policy also requires an active quality_authority assignment`,
      { actionType: request.actionType },
    );
  }
  const permittedScopes = new Set([request.organizationId, ...objects.map((object) => object.id)]);
  if (!permittedScopes.has(assignment.scope_id)) {
    refuseDocumentAuthority(
      'KF-DOC-AUTH-002',
      'quality authority must be scoped to the target or its organization',
      { actionType: request.actionType, scopeId: assignment.scope_id },
    );
  }
}

export async function subjectDocumentPolicy(tx: Tx, objectId: string): Promise<DocumentPolicy> {
  const row = await tx.one<{ document_policy: DocumentPolicy }>(
    `select s.document_policy
       from content.document_subject s
       join core.object o on o.id = s.object_id
      where o.id = $1`,
    [objectId],
  );
  return row.document_policy;
}

export async function authoritativeDocumentPolicy(
  tx: Tx,
  request: ActionRequest,
  objectId: string,
): Promise<DocumentPolicy> {
  const policy = await subjectDocumentPolicy(tx, objectId);
  const asserted = request.payload?.['document_policy'];
  if (asserted !== undefined && asserted !== policy) {
    refuseDocument(
      'KF-DOC-POLICY-002',
      'document_policy assertion does not match the authoritative document subject',
      { objectId, assertedPolicy: asserted, authoritativePolicy: policy },
    );
  }
  return policy;
}

export const assertDocumentAuthor: PreconditionCheck = async (tx, request, objects) => {
  await assertDocumentRole(tx, request, objects, DOCUMENT_AUTHOR_ROLES);
};

export const assertTechnicalDocumentAuthority: PreconditionCheck = async (tx, request, objects) => {
  await assertDocumentRole(tx, request, objects, TECHNICAL_AUTHORITY_ROLE);
  const object = objects[0];
  if (object !== undefined) {
    await assertQualityAuthorityWhenRequired(
      tx,
      request,
      objects,
      await authoritativeDocumentPolicy(tx, request, object.id),
    );
  }
};
