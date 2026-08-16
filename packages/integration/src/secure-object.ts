/**
 * Policy records for exact revisions owned by an external Secure Object Authority.
 *
 * No function resolves a reference, returns a locator, accepts free text, transports
 * protected bytes, or accepts private-key material for persistence. Actor/action identity
 * comes only from KF transaction context. External signers receive canonical tombstone bytes.
 */

export {
  DEFAULT_AUTHORITY_SIGNER_TIMEOUT_MS,
  MAX_AUTHORITY_SIGNER_TIMEOUT_MS,
  MAX_READ_CAPABILITY_SECONDS,
  SECURE_OBJECT_ACTION_ROLES,
  SECURE_OBJECT_ACTION_TYPES,
  SecureObjectRejected,
  type ActionParameter,
  type AuthorityKeyRevocationReason,
  type AuthoritySigningKey,
  type ConsumedReadCapability,
  type ContentSha256,
  type ErasureRequest,
  type ErasureTombstone,
  type ExactObjectBinding,
  type ExternalAuthorityRef,
  type ExternalRevisionRef,
  type PolicyBinding,
  type PolicyDecisionRef,
  type ReadCapability,
  type ReadCapabilityRequest,
  type RegisterAuthorityKeyInput,
  type ScopedPolicyBinding,
  type SecureObjectActionAtoms,
  type SecureObjectActionIntent,
  type SecureObjectActionType,
  type SecureObjectAuthoritySigner,
  type SecureObjectSigningRequest,
  type SignedErasureTombstonePayload,
  type SecureObjectFailure,
  type SecureObjectPurpose,
  type SecureObjectRoleCategory,
  type WorkloadIdentityRef,
} from './secure-object/contracts.js';

export {
  authoritySignerTimeout,
  contentSha256,
  externalAuthorityRef,
  externalRevisionRef,
  policyDecisionRef,
  workloadIdentityRef,
} from './secure-object/validation.js';

export {
  actionForAuthoritySigningKeyRegistration,
  actionForAuthoritySigningKeyRevocation,
  actionForErasureRequest,
  actionForErasureTombstone,
  actionForReadCapabilityConsumption,
  actionForReadCapabilityIssue,
  actionForReadCapabilityRequest,
  actionForReadCapabilityRevocation,
  authoritySigningKeyMaterial,
} from './secure-object/action-intents.js';

export { verifyErasureTombstone } from './secure-object/tombstones.js';
export { createSecureObjectActionAtoms } from './secure-object/action-atoms.js';
