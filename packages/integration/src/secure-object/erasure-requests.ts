import type { Tx } from '@kf/database';
import {
  type ContentSha256,
  type ErasureRequest,
  type ExternalAuthorityRef,
  type ExternalRevisionRef,
  SecureObjectRejected,
  type ScopedPolicyBinding,
} from './contracts.js';
import { exactObject, type ExactObjectRow } from './rows.js';

/** Request erasure of one exact external revision and content digest. */
export async function requestErasure(
  tx: Tx,
  request: ScopedPolicyBinding & {
    readonly purpose: 'authorized_erasure';
    readonly authorityRef: ExternalAuthorityRef;
    readonly revisionRef: ExternalRevisionRef;
    readonly externalContentSha256: ContentSha256;
  },
): Promise<ErasureRequest> {
  await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${request.organizationId}:${request.authorityRef}:${request.revisionRef}`,
  ]);

  const row = await tx.maybeOne<ExactObjectRow>(
    `with context as (select core.current_actor() as actor_id),
     inserted as (
       insert into secure_object.erasure_request
         (organization_id, classification_id, external_authority_ref, external_revision_ref,
          external_content_sha256, purpose, workload_identity_ref, policy_decision_ref)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (organization_id, external_authority_ref, external_revision_ref) do nothing
       returning id, organization_id, classification_id, external_authority_ref,
                 external_revision_ref, external_content_sha256, purpose,
                 workload_identity_ref, policy_decision_ref, requested_at
     )
     select i.*, i.requested_at as issued_at, i.requested_at as expires_at,
            i.id as request_id from inserted i
     union all
     select r.id, r.organization_id, r.classification_id, r.external_authority_ref,
            r.external_revision_ref, r.external_content_sha256, r.purpose,
            r.workload_identity_ref, r.policy_decision_ref, r.requested_at,
            r.requested_at as issued_at, r.requested_at as expires_at, r.id as request_id
       from secure_object.erasure_request r, context c
      where not exists (select 1 from inserted)
        and r.organization_id = $1
        and r.classification_id = $2
        and r.external_authority_ref = $3
        and r.external_revision_ref = $4
        and r.external_content_sha256 = $5
        and r.purpose = $6
        and r.workload_identity_ref = $7
        and r.policy_decision_ref = $8
        and r.actor_id = c.actor_id
      limit 1`,
    [
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
      'erasure_unavailable',
      'exact revision already has an erasure request with different policy semantics',
    );
  }

  return {
    id: row.id,
    ...exactObject(row),
    purpose: 'authorized_erasure',
    requestedAt: row.requested_at,
  };
}
