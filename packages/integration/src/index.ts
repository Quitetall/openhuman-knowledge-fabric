/**
 * Federation adapters and dispatcher-governed integration effects.
 *
 * Records external identity, revision and digest; never copies the fact. Integration has
 * no independent authority: controlled writes are only dispatcher effects.
 */

import type { PackageManifest } from '@kf/domain';

export const PACKAGE: PackageManifest = {
  name: '@kf/integration',
  role: 'Federation adapters and dispatcher-governed integration effects',
  owns: [],
};

export {
  FederationRejected,
  StaticSourceReader,
  checkDrift,
  digestOf,
  linkToReference,
  recordReference,
  type DriftFinding,
  type FederatedReference,
  type ReferenceSpec,
  type SourceReader,
} from './federation.js';

export { GitReadFailed, GitSourceReader, type GitSourceOptions } from './git.js';

export {
  ML_ACTION_TYPES,
  actionForAggregateReferenceRegistration,
  actionForMetricDefinitionRegistration,
  actionForMetricEventAppend,
  actionForMetricSegmentRegistration,
  actionForRunLineageRegistration,
  actionForMetricStreamAuthorization,
  actionForPromotionAuthorization,
  createMlActionAtoms,
  metricEventActionIdempotencyKey,
  mlRegistryActionIdempotencyKey,
  type AggregateReferenceRegistrationInput,
  type MetricDefinitionRegistrationInput,
  type MetricEventAppendInput,
  type MetricSegmentRegistrationInput,
  type MetricStreamAuthorizationInput,
  type MlActionAtoms,
  type MlActionIntent,
  type MlActionType,
  type MlPromotionActionIntent,
  type MlPromotionAuthorityKind,
  type MlPromotionRiskTier,
  type PromotionAuthorizationInput,
  type RunLineageRegistrationInput,
} from './ml.js';

export {
  DEFAULT_AUTHORITY_SIGNER_TIMEOUT_MS,
  MAX_AUTHORITY_SIGNER_TIMEOUT_MS,
  MAX_READ_CAPABILITY_SECONDS,
  SECURE_OBJECT_ACTION_TYPES,
  SecureObjectRejected,
  actionForAuthoritySigningKeyRegistration,
  actionForAuthoritySigningKeyRevocation,
  actionForErasureRequest,
  actionForErasureTombstone,
  actionForReadCapabilityConsumption,
  actionForReadCapabilityIssue,
  actionForReadCapabilityRequest,
  actionForReadCapabilityRevocation,
  authoritySigningKeyMaterial,
  contentSha256,
  createSecureObjectActionAtoms,
  externalAuthorityRef,
  externalRevisionRef,
  verifyErasureTombstone,
  policyDecisionRef,
  workloadIdentityRef,
  type AuthorityKeyRevocationReason,
  type AuthoritySigningKey,
  type ContentSha256,
  type ConsumedReadCapability,
  type ErasureRequest,
  type ErasureTombstone,
  type ExternalAuthorityRef,
  type ExternalRevisionRef,
  type ReadCapability,
  type ReadCapabilityRequest,
  type PolicyDecisionRef,
  type SecureObjectPurpose,
  type SecureObjectFailure,
  type SecureObjectActionAtoms,
  type SecureObjectActionIntent,
  type SecureObjectActionType,
  type SecureObjectAuthoritySigner,
  type SecureObjectSigningRequest,
  type SignedErasureTombstonePayload,
  type WorkloadIdentityRef,
} from './secure-object.js';
