import {
  type AuthoritySigningKey,
  type ExactObjectBinding,
  type SecureObjectPurpose,
} from './contracts.js';
import {
  contentSha256,
  externalAuthorityRef,
  externalRevisionRef,
  policyDecisionRef,
  workloadIdentityRef,
} from './validation.js';

export interface ExactObjectRow {
  readonly [key: string]: unknown;
  readonly id: string;
  readonly organization_id: string;
  readonly classification_id: string;
  readonly external_authority_ref: string;
  readonly external_revision_ref: string;
  readonly external_content_sha256: string;
  readonly purpose: SecureObjectPurpose;
  readonly workload_identity_ref: string;
  readonly policy_decision_ref: string;
  readonly requested_at: Date;
  readonly issued_at: Date;
  readonly expires_at: Date;
  readonly request_id: string;
}

export interface AuthorityKeyRow {
  readonly [key: string]: unknown;
  readonly id: string;
  readonly organization_id: string;
  readonly external_authority_ref: string;
  readonly key_id: string;
  readonly algorithm: 'Ed25519';
  readonly public_key_spki_der_base64: string;
  readonly public_key_sha256: string;
  readonly rotates_key_registry_id: string | null;
  readonly valid_from: Date;
  readonly valid_until: Date | null;
}

export function exactObject(row: ExactObjectRow): ExactObjectBinding {
  return {
    organizationId: row.organization_id,
    classificationId: row.classification_id,
    authorityRef: externalAuthorityRef(row.external_authority_ref),
    revisionRef: externalRevisionRef(row.external_revision_ref),
    externalContentSha256: contentSha256(row.external_content_sha256),
    purpose: row.purpose,
    workloadIdentityRef: workloadIdentityRef(row.workload_identity_ref),
    policyDecisionRef: policyDecisionRef(row.policy_decision_ref),
  };
}

export function authorityKey(row: AuthorityKeyRow): AuthoritySigningKey {
  return {
    id: row.id,
    organizationId: row.organization_id,
    authorityRef: externalAuthorityRef(row.external_authority_ref),
    keyId: row.key_id,
    algorithm: row.algorithm,
    publicKeySha256: contentSha256(row.public_key_sha256),
    rotatesKeyRegistryId: row.rotates_key_registry_id,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
  };
}
