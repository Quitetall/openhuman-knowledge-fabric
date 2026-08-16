import type {
  MlLineageMemberRole,
  MlPromotionRiskTier,
  PromotionRevocationReason,
} from '@kf/ml-registry';
import type { AggregateProjection, decodeMetricValue } from '../projection.js';

interface SqlRow {
  readonly [column: string]: unknown;
}

type ReferenceColumnName =
  'kind' | 'authority_id' | 'revision_id' | 'sha256' | 'classification_id' | 'policy_id';

type ReferenceRow<Prefix extends string> = {
  readonly [Column in `${Prefix}_${ReferenceColumnName}`]: unknown;
};

export type RunLineageRow = SqlRow &
  ReferenceRow<'run' | 'code' | 'recipe' | 'environment' | 'metric_policy'> & {
    readonly lineage_id: unknown;
    readonly lineage_sha256: unknown;
    readonly lineage_recorded_at: unknown;
  };

export type LineageMemberRow = SqlRow &
  ReferenceRow<'member'> & {
    readonly member_role: unknown;
    readonly ordinal: unknown;
  };

export interface MetricEventRow extends SqlRow {
  readonly sequence_no: unknown;
  readonly recorded_at: unknown;
  readonly status: unknown;
  readonly metric_id: unknown;
  readonly value_kind: unknown;
  readonly unit_id: unknown;
  readonly numeric_value: unknown;
  readonly enum_value: unknown;
  readonly timestamp_value: unknown;
  readonly event_sha256: unknown;
}

export type MetricSegmentRow = SqlRow &
  ReferenceRow<'segment'> & {
    readonly ordinal: unknown;
    readonly first_sequence: unknown;
    readonly last_sequence: unknown;
    readonly event_count: unknown;
    readonly metadata_sha256: unknown;
  };

export interface RunSealRow extends SqlRow {
  readonly lineage_sha256: unknown;
  readonly segment_manifest_sha256: unknown;
  readonly event_count: unknown;
  readonly sealed_at: unknown;
  readonly signing_key_id: unknown;
  readonly seal_sha256: unknown;
  readonly recorded_at: unknown;
}

export type PromotionRow = SqlRow &
  ReferenceRow<'candidate' | 'policy' | 'technical' | 'quality'> & {
    readonly alias_id: unknown;
    readonly risk_tier: unknown;
    readonly promoted_at: unknown;
    readonly signing_key_id: unknown;
    readonly receipt_sha256: unknown;
    readonly signature: unknown;
    readonly revoked_at: unknown;
    readonly reason_code: unknown;
  };

export interface RunLineageData {
  readonly lineageId: string;
  readonly lineageDigest: string;
  readonly recordedAt: string;
  readonly run: AggregateProjection;
  readonly code: AggregateProjection;
  readonly recipe: AggregateProjection;
  readonly environment: AggregateProjection;
  readonly metricPolicy: AggregateProjection;
}

export interface LineageMemberData {
  readonly role: MlLineageMemberRole;
  readonly ordinal: number;
  readonly reference: AggregateProjection;
}

export interface MetricEventData {
  readonly sequence: string;
  readonly recordedAt: string;
  readonly status: 'provisional';
  readonly metricId: string;
  readonly unitId: string | null;
  readonly value: ReturnType<typeof decodeMetricValue>;
  readonly eventDigest: string;
}

export interface MetricSegmentData {
  readonly reference: AggregateProjection;
  readonly ordinal: number;
  readonly firstSequence: string;
  readonly lastSequence: string;
  readonly eventCount: string;
  readonly metadataDigest: string;
}

export interface RunSealData {
  readonly lineageDigest: string;
  readonly segmentManifestDigest: string;
  readonly eventCount: string;
  readonly sealedAt: string;
  readonly signingKeyId: string;
  readonly sealDigest: string;
  readonly recordedAt: string;
}

export interface PromotionData {
  readonly aliasId: string;
  readonly candidate: AggregateProjection;
  readonly policy: AggregateProjection;
  readonly riskTier: MlPromotionRiskTier;
  readonly technicalAuthorityDecision: AggregateProjection;
  readonly qualityAuthorityDecision: AggregateProjection;
  readonly promotedAt: string;
  readonly signingKeyId: string;
  readonly receiptDigest: string;
  readonly signature: string;
  readonly revocation: {
    readonly reasonCode: PromotionRevocationReason;
    readonly revokedAt: string;
  } | null;
}

export interface RunProjectionData {
  readonly lineage: RunLineageData;
  readonly visibleMembers: readonly LineageMemberData[];
  readonly hasMoreMembers: boolean;
  readonly visibleEvents: readonly MetricEventData[];
  readonly hasMoreEvents: boolean;
  readonly lastVisibleSequence: string;
  readonly visibleSegments: readonly MetricSegmentData[];
  readonly hasMoreSegments: boolean;
  readonly seal: RunSealData | null;
  readonly visiblePromotions: readonly PromotionData[];
  readonly hasMorePromotions: boolean;
}
