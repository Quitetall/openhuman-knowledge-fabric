import type { KeyObject } from 'node:crypto';
import type {
  AggregateKind,
  MetricValueKind,
  MlPromotionRiskTier,
  PromotionRevocationReason,
} from '../public-contracts.js';

export type {
  AggregateKind,
  MetricValueKind,
  MlPromotionRiskTier,
  PromotionRevocationReason,
} from '../public-contracts.js';

export class MlRegistryRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MlRegistryRejected';
  }
}

export interface AggregateReference {
  readonly organizationId: string;
  readonly kind: AggregateKind;
  readonly authorityId: string;
  readonly revisionId: string;
  readonly sha256: string;
  readonly classificationId: string;
  readonly policyId: string;
}

export interface RunLineageInput {
  readonly run: AggregateReference;
  readonly code: AggregateReference;
  readonly recipe: AggregateReference;
  readonly environment: AggregateReference;
  readonly metricPolicy: AggregateReference;
  readonly inputs: readonly AggregateReference[];
  readonly outputs: readonly AggregateReference[];
  readonly parentModels: readonly AggregateReference[];
}

export interface CompleteRunLineage extends RunLineageInput {
  readonly schemaVersion: 'kf.ml.run-lineage.v1';
}

export interface MetricWriteAuthorizationClaimInput {
  readonly actionId: string;
  readonly organizationId: string;
  readonly actorId: string;
  readonly actingRoleId: string;
  readonly runLineageId: string;
  readonly metricDefinitionId: string;
  readonly metricPolicyRefId: string;
  readonly authorizedAt: string;
}

export interface MetricWriteAuthorizationClaim extends MetricWriteAuthorizationClaimInput {
  readonly schemaVersion: 'kf.ml.metric-write-authorization.v2';
  readonly authorizationDigest: string;
}

export interface MetricDefinition {
  readonly reference: AggregateReference;
  readonly metricId: string;
  readonly valueKind: MetricValueKind;
  readonly unitId: string | null;
  readonly allowedValues: readonly string[];
}

export type MetricValue =
  | { readonly kind: 'number'; readonly number: number }
  | { readonly kind: 'safe_enum'; readonly enumId: string }
  | { readonly kind: 'timestamp'; readonly timestamp: string };

export interface MetricEventInput {
  readonly idempotencyKey: string;
  readonly run: AggregateReference;
  readonly sequence: number;
  readonly recordedAt: string;
  readonly value: MetricValue;
}

export interface ProvisionalMetricEvent extends MetricEventInput {
  readonly schemaVersion: 'kf.ml.metric-event.v1';
  readonly status: 'provisional';
  readonly metricDefinition: AggregateReference;
  readonly metricId: string;
  readonly eventDigest: string;
}

export interface MetricSegmentInput {
  readonly segment: AggregateReference;
  readonly run: AggregateReference;
  readonly ordinal: number;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly eventCount: number;
  /** Event digests in ascending sequence order, one digest per covered sequence. */
  readonly eventDigests: readonly string[];
}

export interface MetricSegment extends MetricSegmentInput {
  readonly schemaVersion: 'kf.ml.metric-segment.v2';
  readonly eventManifestDigest: string;
  readonly metadataDigest: string;
}

export interface RunSealInput {
  readonly lineage: CompleteRunLineage;
  readonly segments: readonly MetricSegment[];
  readonly sealedAt: string;
}

export interface SignedRunSeal {
  readonly schemaVersion: 'kf.ml.run-seal.v2';
  readonly run: AggregateReference;
  readonly lineageDigest: string;
  readonly segmentDigests: readonly string[];
  readonly eventManifestDigest: string;
  readonly eventCount: number;
  readonly sealedAt: string;
  readonly signingKeyId: string;
  readonly sealDigest: string;
  readonly signature: string;
}

/** Immutable pre-v2 record retained for historical verification only. */
export interface LegacySignedRunSeal {
  readonly schemaVersion: 'kf.ml.run-seal.v1';
  readonly run: AggregateReference;
  readonly lineageDigest: string;
  readonly segmentDigests: readonly string[];
  readonly eventCount: number;
  readonly sealedAt: string;
  readonly signingKeyId: string;
  readonly sealDigest: string;
  readonly signature: string;
}

export type RunSealFinding =
  'malformed_seal' | 'seal_digest_mismatch' | 'unknown_signing_key' | 'bad_signature';

export interface RunSealVerification {
  readonly valid: boolean;
  readonly findings: readonly RunSealFinding[];
}

export interface PrivateSigningKey {
  readonly id: string;
  readonly privateKey: KeyObject;
}

export interface PromotionReceiptInput {
  readonly organizationId: string;
  readonly aliasId: string;
  readonly candidate: AggregateReference;
  readonly runSealDigest: string;
  readonly policy: AggregateReference;
  readonly evidence: readonly AggregateReference[];
  /** Descriptive only until KF has an immutable organization-owned risk binding. */
  readonly riskTier: MlPromotionRiskTier;
  readonly technicalAuthorityDecision: AggregateReference;
  readonly qualityAuthorityDecision: AggregateReference;
  readonly promotedAt: string;
}

export interface SignedPromotionReceipt extends PromotionReceiptInput {
  readonly schemaVersion: 'kf.ml.promotion-receipt.v1';
  readonly issuer: 'knowledge-fabric';
  readonly evidenceSetDigest: string;
  readonly signingKeyId: string;
  readonly receiptDigest: string;
  readonly signature: string;
}

export interface PromotionRevocationInput {
  readonly organizationId: string;
  readonly aliasId: string;
  readonly receiptDigest: string;
  readonly reasonCode: PromotionRevocationReason;
  readonly revokedAt: string;
}

export interface SignedPromotionRevocation extends PromotionRevocationInput {
  readonly schemaVersion: 'kf.ml.promotion-revocation.v1';
  readonly issuer: 'knowledge-fabric';
  readonly signingKeyId: string;
  readonly revocationDigest: string;
  readonly signature: string;
}

export type PromotionVerificationFinding =
  'malformed_record' | 'digest_mismatch' | 'unknown_signing_key' | 'bad_signature';

export interface PromotionVerification {
  readonly valid: boolean;
  readonly findings: readonly PromotionVerificationFinding[];
}

export type GovernedAliasResolution =
  | {
      readonly status: 'active';
      readonly organizationId: string;
      readonly aliasId: string;
      readonly candidate: AggregateReference;
      readonly receiptDigest: string;
      readonly findings: readonly string[];
    }
  | {
      readonly status: 'revoked';
      readonly organizationId: string;
      readonly aliasId: string;
      readonly receiptDigest: string;
      readonly findings: readonly string[];
    }
  | {
      readonly status: 'unassigned' | 'invalid';
      readonly organizationId: string;
      readonly aliasId: string;
      readonly findings: readonly string[];
    };
