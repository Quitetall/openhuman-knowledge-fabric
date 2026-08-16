import type { Tx } from '@kf/database';
import {
  type ConsumedReadCapability,
  type ReadCapability,
  type ReadCapabilityRequest,
  SecureObjectRejected,
} from './contracts.js';
import { exactObject, type ExactObjectRow } from './rows.js';

/** Issue requested read without widening exact binding or extending expiry. */
export async function issueReadCapability(
  tx: Tx,
  issue: { readonly request: ReadCapabilityRequest },
): Promise<ReadCapability> {
  const { request } = issue;
  const row = await tx.maybeOne<ExactObjectRow>(
    `with issued as (
       insert into secure_object.capability_issue
         (request_id, external_content_sha256, purpose, workload_identity_ref,
          policy_decision_ref)
       select r.id, r.external_content_sha256, r.purpose, r.workload_identity_ref,
              r.policy_decision_ref
         from secure_object.capability_request r
        where r.id = $1
          and r.organization_id = $2
          and r.classification_id = $3
          and r.external_authority_ref = $4
          and r.external_revision_ref = $5
          and r.external_content_sha256 = $6
          and r.purpose = $7
          and r.workload_identity_ref = $8
          and r.policy_decision_ref = $9
       on conflict (request_id) do nothing
       returning id, request_id, issued_at
     )
     select i.id, r.organization_id, r.classification_id, r.external_authority_ref,
            r.external_revision_ref, r.external_content_sha256, r.purpose,
            r.workload_identity_ref, r.policy_decision_ref, r.requested_at,
            i.issued_at, r.expires_at, r.id as request_id
       from issued i
       join secure_object.capability_request r on r.id = i.request_id`,
    [
      request.id,
      request.organizationId,
      request.classificationId,
      request.authorityRef,
      request.revisionRef,
      request.externalContentSha256,
      request.purpose,
      request.workloadIdentityRef,
      request.policyDecisionRef,
    ],
  );
  if (row === undefined) {
    throw new SecureObjectRejected(
      'request_unavailable',
      'read request is missing, expired, binding-mismatched, or already issued',
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

/** Revoke an unconsumed grant. Repeating or revoking a consumed grant returns false. */
export async function revokeReadCapability(
  tx: Tx,
  revocation: { readonly capability: ReadCapability },
): Promise<boolean> {
  const { capability } = revocation;
  await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [capability.id]);
  const row = await tx.maybeOne<{ readonly capability_id: string }>(
    `insert into secure_object.capability_revocation
       (capability_id, external_content_sha256, purpose, workload_identity_ref,
        policy_decision_ref)
     select i.id, i.external_content_sha256, i.purpose, i.workload_identity_ref,
            i.policy_decision_ref
       from secure_object.capability_issue i
       join secure_object.capability_request r on r.id = i.request_id
      where i.id = $1
        and r.organization_id = $2
        and r.external_authority_ref = $3
        and r.external_revision_ref = $4
        and i.external_content_sha256 = $5
        and i.purpose = $6
        and i.workload_identity_ref = $7
        and i.policy_decision_ref = $8
        and not exists (
          select 1 from secure_object.capability_consumption c where c.capability_id = i.id
        )
        and not exists (
          select 1 from secure_object.capability_revocation v where v.capability_id = i.id
        )
     on conflict (capability_id) do nothing
     returning capability_id`,
    [
      capability.id,
      capability.organizationId,
      capability.authorityRef,
      capability.revisionRef,
      capability.externalContentSha256,
      capability.purpose,
      capability.workloadIdentityRef,
      capability.policyDecisionRef,
    ],
  );
  return row !== undefined;
}

/** Consume once, before expiry, for exact revision, digest, and policy binding. */
export async function consumeReadCapability(
  tx: Tx,
  use: { readonly capability: ReadCapability },
): Promise<ConsumedReadCapability> {
  const { capability } = use;
  await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [capability.id]);
  const row = await tx.maybeOne<ExactObjectRow>(
    `with consumed as (
       insert into secure_object.capability_consumption
         (capability_id, external_content_sha256, purpose, workload_identity_ref,
          policy_decision_ref)
       select i.id, i.external_content_sha256, i.purpose, i.workload_identity_ref,
              i.policy_decision_ref
         from secure_object.capability_issue i
         join secure_object.capability_request r on r.id = i.request_id
        where i.id = $1
          and r.organization_id = $2
          and r.classification_id = $3
          and r.external_authority_ref = $4
          and r.external_revision_ref = $5
          and i.external_content_sha256 = $6
          and i.purpose = $7
          and i.workload_identity_ref = $8
          and i.policy_decision_ref = $9
          and not exists (
            select 1 from secure_object.capability_consumption c where c.capability_id = i.id
          )
          and not exists (
            select 1 from secure_object.capability_revocation v where v.capability_id = i.id
          )
       on conflict (capability_id) do nothing
       returning capability_id
     )
     select i.id, r.organization_id, r.classification_id, r.external_authority_ref,
            r.external_revision_ref, r.external_content_sha256, r.purpose,
            r.workload_identity_ref, r.policy_decision_ref, r.requested_at,
            i.issued_at, r.expires_at, r.id as request_id
       from consumed c
       join secure_object.capability_issue i on i.id = c.capability_id
       join secure_object.capability_request r on r.id = i.request_id`,
    [
      capability.id,
      capability.organizationId,
      capability.classificationId,
      capability.authorityRef,
      capability.revisionRef,
      capability.externalContentSha256,
      capability.purpose,
      capability.workloadIdentityRef,
      capability.policyDecisionRef,
    ],
  );
  if (row === undefined) {
    throw new SecureObjectRejected(
      'capability_unavailable',
      'read capability is unavailable for this exact revision, digest, and policy binding',
    );
  }

  return {
    capabilityId: row.id,
    ...exactObject(row),
    access: 'read_exact_revision',
  };
}
