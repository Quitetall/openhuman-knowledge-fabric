import type { KeyObject } from 'node:crypto';
import type { ActionEffect, PreconditionCheck } from '@kf/actions';

declare const externalAuthorityBrand: unique symbol;
declare const externalRevisionBrand: unique symbol;
declare const workloadIdentityBrand: unique symbol;
declare const policyDecisionBrand: unique symbol;
declare const contentSha256Brand: unique symbol;

export type ExternalAuthorityRef = string & {
  readonly [externalAuthorityBrand]: 'ExternalAuthorityRef';
};
export type ExternalRevisionRef = string & {
  readonly [externalRevisionBrand]: 'ExternalRevisionRef';
};
export type WorkloadIdentityRef = string & {
  readonly [workloadIdentityBrand]: 'WorkloadIdentityRef';
};
export type PolicyDecisionRef = string & {
  readonly [policyDecisionBrand]: 'PolicyDecisionRef';
};
export type ContentSha256 = string & {
  readonly [contentSha256Brand]: 'ContentSha256';
};

export type SecureObjectPurpose =
  'ml_training' | 'ml_evaluation' | 'data_quality_validation' | 'authorized_erasure';

export type AuthorityKeyRevocationReason =
  'key_rotation' | 'key_compromise' | 'authority_retirement' | 'administrative';

export const MAX_READ_CAPABILITY_SECONDS = 300;
export const DEFAULT_AUTHORITY_SIGNER_TIMEOUT_MS = 5_000;
export const MAX_AUTHORITY_SIGNER_TIMEOUT_MS = 60_000;

export const SECURE_OBJECT_ACTION_TYPES = {
  requestRead: 'request_secure_object_access',
  issueRead: 'issue_secure_object_capability',
  revokeRead: 'revoke_secure_object_capability',
  consumeRead: 'consume_secure_object_capability',
  requestErasure: 'request_secure_object_erasure',
  recordErasure: 'record_secure_object_erasure',
  registerAuthorityKey: 'register_secure_object_authority_key',
  revokeAuthorityKey: 'revoke_secure_object_authority_key',
} as const;

export type SecureObjectActionType =
  (typeof SECURE_OBJECT_ACTION_TYPES)[keyof typeof SECURE_OBJECT_ACTION_TYPES];
export type SecureObjectRoleCategory =
  'technical_authority' | 'quality_authority' | 'system_administrator';

export const SECURE_OBJECT_ACTION_ROLES = {
  [SECURE_OBJECT_ACTION_TYPES.requestRead]: ['technical_authority'],
  [SECURE_OBJECT_ACTION_TYPES.issueRead]: ['technical_authority'],
  [SECURE_OBJECT_ACTION_TYPES.revokeRead]: ['technical_authority'],
  [SECURE_OBJECT_ACTION_TYPES.consumeRead]: ['technical_authority'],
  [SECURE_OBJECT_ACTION_TYPES.requestErasure]: ['quality_authority'],
  [SECURE_OBJECT_ACTION_TYPES.recordErasure]: ['quality_authority'],
  [SECURE_OBJECT_ACTION_TYPES.registerAuthorityKey]: ['system_administrator'],
  [SECURE_OBJECT_ACTION_TYPES.revokeAuthorityKey]: ['system_administrator'],
} as const satisfies Readonly<Record<SecureObjectActionType, readonly SecureObjectRoleCategory[]>>;

export type ActionParameter = string | number | null;

export interface SecureObjectActionIntent {
  readonly actionType: SecureObjectActionType;
  readonly targetId: string;
  readonly parameters: Readonly<Record<string, ActionParameter>>;
}

export type SecureObjectFailure =
  | 'invalid_reference'
  | 'invalid_digest'
  | 'invalid_idempotency_key'
  | 'invalid_ttl'
  | 'invalid_timeout'
  | 'invalid_key'
  | 'idempotency_conflict'
  | 'request_unavailable'
  | 'capability_unavailable'
  | 'erasure_unavailable'
  | 'signing_key_unavailable'
  | 'signer_timeout';

export class SecureObjectRejected extends Error {
  constructor(
    readonly failure: SecureObjectFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SecureObjectRejected';
  }
}

export interface ScopedPolicyBinding {
  readonly organizationId: string;
  readonly classificationId: string;
  readonly purpose: SecureObjectPurpose;
  readonly workloadIdentityRef: WorkloadIdentityRef;
  readonly policyDecisionRef: PolicyDecisionRef;
}

export interface PolicyBinding {
  readonly purpose: SecureObjectPurpose;
  readonly workloadIdentityRef: WorkloadIdentityRef;
  readonly policyDecisionRef: PolicyDecisionRef;
}

export interface ExactObjectBinding extends PolicyBinding {
  readonly organizationId: string;
  readonly classificationId: string;
  readonly authorityRef: ExternalAuthorityRef;
  readonly revisionRef: ExternalRevisionRef;
  readonly externalContentSha256: ContentSha256;
}

export interface ReadCapabilityRequest extends ExactObjectBinding {
  readonly id: string;
  readonly requestedAt: Date;
  readonly expiresAt: Date;
}

export interface ReadCapability extends ExactObjectBinding {
  readonly id: string;
  readonly requestId: string;
  readonly access: 'read_exact_revision';
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface ConsumedReadCapability extends ExactObjectBinding {
  readonly capabilityId: string;
  readonly access: 'read_exact_revision';
}

export interface ErasureRequest extends ExactObjectBinding {
  readonly id: string;
  readonly purpose: 'authorized_erasure';
  readonly requestedAt: Date;
}

export interface AuthoritySigningKey {
  readonly id: string;
  readonly organizationId: string;
  readonly authorityRef: ExternalAuthorityRef;
  readonly keyId: string;
  readonly algorithm: 'Ed25519';
  readonly publicKeySha256: ContentSha256;
  readonly rotatesKeyRegistryId: string | null;
  readonly validFrom: Date;
  readonly validUntil: Date | null;
}

export interface ErasureTombstone extends PolicyBinding {
  readonly id: string;
  readonly version: 'kf-secure-object-erasure-tombstone/v1';
  readonly erasureRequestId: string;
  readonly externalContentSha256: ContentSha256;
  readonly erasedAt: Date;
  readonly signerId: string;
  readonly signerActionId: string;
  readonly signingKeyRegistryId: string;
  readonly signingKeyId: string;
  readonly signature: string;
}

export interface RegisterAuthorityKeyInput {
  readonly organizationId: string;
  readonly authorityRef: ExternalAuthorityRef;
  readonly keyId: string;
  readonly publicKey: KeyObject;
  readonly rotatesKeyRegistryId: string | null;
  readonly validUntil: Date | null;
}

export interface SecureObjectActionAtoms {
  readonly name: 'secure-object';
  readonly ownedActions: readonly SecureObjectActionType[];
  readonly effects: Readonly<Record<SecureObjectActionType, ActionEffect>>;
  readonly preconditions: Readonly<Record<SecureObjectActionType, PreconditionCheck>>;
}

export interface SecureObjectAuthoritySigner {
  sign(input: {
    readonly organizationId: string;
    readonly authorityRef: ExternalAuthorityRef;
    readonly signingKeyRegistryId: string;
    readonly canonicalTombstoneBytes: Uint8Array;
    readonly signal: AbortSignal;
  }): Uint8Array | Promise<Uint8Array>;
}
