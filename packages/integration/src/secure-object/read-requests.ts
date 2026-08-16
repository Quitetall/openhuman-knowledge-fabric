import type { Tx } from '@kf/database';
import {
  MAX_READ_CAPABILITY_SECONDS,
  type ContentSha256,
  type ExternalAuthorityRef,
  type ExternalRevisionRef,
  type ReadCapabilityRequest,
  SecureObjectRejected,
  type ScopedPolicyBinding,
} from './contracts.js';
import { exactObject, type ExactObjectRow } from './rows.js';
import { validateIdempotencyKey } from './validation.js';

/**
 * Request one bounded read grant. An identical idempotent replay returns the original row;
 * reusing a key for a different actor or exact-object semantic fails closed.
 */
export async function requestReadCapability(
  tx: Tx,
  request: ScopedPolicyBinding & {
    readonly authorityRef: ExternalAuthorityRef;
    readonly revisionRef: ExternalRevisionRef;
    readonly externalContentSha256: ContentSha256;
    readonly idempotencyKey: string;
    readonly ttlSeconds: number;
  },
): Promise<ReadCapabilityRequest> {
  validateIdempotencyKey(request.idempotencyKey);
  if (
    !Number.isInteger(request.ttlSeconds) ||
    request.ttlSeconds <= 0 ||
    request.ttlSeconds > MAX_READ_CAPABILITY_SECONDS
  ) {
    throw new SecureObjectRejected(
      'invalid_ttl',
      `read capabilities must live for 1-${MAX_READ_CAPABILITY_SECONDS} seconds`,
    );
  }

  await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${request.organizationId}:${request.idempotencyKey}`,
  ]);

  const row = await tx.maybeOne<ExactObjectRow>(
    `with context as (select core.current_actor() as actor_id),
     inserted as (
       insert into secure_object.capability_request
         (organization_id, classification_id, external_authority_ref, external_revision_ref,
          external_content_sha256, purpose, workload_identity_ref, policy_decision_ref,
          idempotency_key, ttl_seconds)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::integer)
       on conflict (organization_id, idempotency_key) do nothing
       returning id, organization_id, classification_id, external_authority_ref,
                 external_revision_ref, external_content_sha256, purpose,
                 workload_identity_ref, policy_decision_ref, requested_at, expires_at
     )
     select i.*, i.requested_at as issued_at, i.id as request_id from inserted i
     union all
     select r.id, r.organization_id, r.classification_id, r.external_authority_ref,
            r.external_revision_ref, r.external_content_sha256, r.purpose,
            r.workload_identity_ref, r.policy_decision_ref, r.requested_at,
            r.expires_at, r.requested_at as issued_at, r.id as request_id
       from secure_object.capability_request r, context c
      where not exists (select 1 from inserted)
        and r.organization_id = $1
        and r.idempotency_key = $9
        and r.classification_id = $2
        and r.external_authority_ref = $3
        and r.external_revision_ref = $4
        and r.external_content_sha256 = $5
        and r.purpose = $6
        and r.workload_identity_ref = $7
        and r.policy_decision_ref = $8
        and r.ttl_seconds = $10::integer
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
      request.idempotencyKey,
      request.ttlSeconds,
    ],
  );
  if (row === undefined) {
    throw new SecureObjectRejected(
      'idempotency_conflict',
      'idempotency key is already bound to different secure-object request semantics',
    );
  }

  return {
    id: row.id,
    ...exactObject(row),
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
  };
}
