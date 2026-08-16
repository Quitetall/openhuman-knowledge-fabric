/**
 * Privacy-minimal ML registry records.
 *
 * Public seam stays here. Cohesive implementation atoms remain private under internal/.
 * Aggregate references carry only typed, organization-scoped opaque integrity/governance
 * fields; subject, session, sample, label, free-text, and locator data have no representation.
 */

export {
  MlRegistryRejected,
  type AggregateReference,
  type RunLineageInput,
  type CompleteRunLineage,
  type MetricWriteAuthorizationClaimInput,
  type MetricWriteAuthorizationClaim,
  type MetricDefinition,
  type MetricValue,
  type MetricEventInput,
  type ProvisionalMetricEvent,
  type MetricSegmentInput,
  type MetricSegment,
  type RunSealInput,
  type SignedRunSeal,
  type LegacySignedRunSeal,
  type RunSealFinding,
  type RunSealVerification,
  type PrivateSigningKey,
  type PromotionReceiptInput,
  type SignedPromotionReceipt,
  type PromotionRevocationInput,
  type SignedPromotionRevocation,
  type PromotionVerificationFinding,
  type PromotionVerification,
  type GovernedAliasResolution,
} from './internal/contracts.js';
export {
  ML_AGGREGATE_KINDS,
  ML_CANONICAL_TIMESTAMP,
  ML_GOVERNED_ALIAS_TOKEN,
  ML_LINEAGE_MEMBER_ROLES,
  ML_METRIC_VALUE_KINDS,
  ML_OPAQUE_REFERENCE_TOKEN,
  ML_PROMOTION_AUTHORITY_KINDS,
  ML_PROMOTION_REVOCATION_REASONS,
  ML_PROMOTION_RISK_TIERS,
  ML_SHA256,
  isAggregateKind,
  isCanonicalTimestamp,
  isGovernedAliasToken,
  isLineageMemberRole,
  isMetricValueKind,
  isOpaqueReferenceToken,
  isPromotionAuthorityKind,
  isPromotionRevocationReason,
  isPromotionRiskTier,
  isSha256,
  type AggregateKind,
  type MetricValueKind,
  type MlLineageMemberRole,
  type MlPromotionAuthorityKind,
  type MlPromotionRiskTier,
  type PromotionRevocationReason,
} from './public-contracts.js';
export { createMetricWriteAuthorizationClaim, createRunLineage } from './internal/lineage.js';
export { MetricEventJournal } from './internal/metric-events.js';
export { createMetricSegment } from './internal/metric-segments.js';
export { signRunSeal, verifyRunSeal } from './internal/run-seal.js';
export {
  submitExternallySignedRunSeal,
  type ExternallySignedRunSealSubmission,
  type RunSealSubmissionDatabase,
  type RunSealSubmissionReceipt,
} from './internal/run-seal-submission.js';
export { signPromotionReceipt, verifyPromotionReceipt } from './internal/promotion-receipts.js';
export {
  signPromotionRevocation,
  verifyPromotionRevocation,
} from './internal/promotion-revocations.js';
export { resolveGovernedAlias } from './internal/alias-resolution.js';

export const PACKAGE = {
  name: '@kf/ml-registry',
  role: 'privacy-minimal ML lineage, metrics, sealing, and promotion authority',
  owns: ['ml'],
} as const;
