import type { MlLineageMemberRole } from '@kf/ml-registry/contracts';

export interface AggregateReference {
  readonly kind: string;
  readonly authorityId: string;
  readonly revisionId: string;
  readonly sha256: string;
  readonly classificationId: string;
  readonly policyId: string;
}

export interface MetricEvent {
  readonly sequence: string;
  readonly recordedAt: string;
  readonly status: 'provisional';
  readonly metricId: string;
  readonly unitId: string | null;
  readonly value:
    | { readonly kind: 'number'; readonly number: number }
    | { readonly kind: 'safe_enum'; readonly enumId: string }
    | { readonly kind: 'timestamp'; readonly timestamp: string };
  readonly eventDigest: string;
}

export interface Promotion {
  readonly aliasId: string;
  readonly candidate: AggregateReference;
  readonly policy: AggregateReference;
  readonly riskTier: string;
  readonly technicalAuthorityDecision: AggregateReference;
  readonly qualityAuthorityDecision: AggregateReference;
  readonly promotedAt: string;
  readonly signingKeyId: string;
  readonly receiptDigest: string;
  readonly signature: string;
  readonly status: 'recorded' | 'revoked';
  readonly revocation: null | {
    readonly reasonCode: string;
    readonly revokedAt: string;
  };
}

export interface RunProjection {
  readonly schemaVersion: 'kf.ml.run-projection.v1';
  readonly run: AggregateReference;
  readonly lineage: {
    readonly lineageDigest: string;
    readonly recordedAt: string;
    readonly code: AggregateReference;
    readonly recipe: AggregateReference;
    readonly environment: AggregateReference;
    readonly metricPolicy: AggregateReference;
    readonly members: {
      readonly items: readonly {
        readonly role: MlLineageMemberRole;
        readonly ordinal: number;
        readonly reference: AggregateReference;
      }[];
      readonly page: {
        readonly limit: number;
        readonly afterMember: string | null;
        readonly nextAfterMember: string | null;
      };
    };
  };
  readonly metrics: {
    readonly events: readonly MetricEvent[];
    readonly page: {
      readonly limit: number;
      readonly afterSequence: string;
      readonly nextAfterSequence: string | null;
    };
  };
  readonly segments: {
    readonly items: readonly {
      readonly reference: AggregateReference;
      readonly ordinal: number;
      readonly firstSequence: string;
      readonly lastSequence: string;
      readonly eventCount: string;
      readonly metadataDigest: string;
    }[];
    readonly page: {
      readonly limit: number;
      readonly afterOrdinal: number;
      readonly nextAfterOrdinal: number | null;
    };
  };
  readonly seal: null | {
    readonly lineageDigest: string;
    readonly segmentManifestDigest: string;
    readonly eventCount: string;
    readonly sealedAt: string;
    readonly signingKeyId: string;
    readonly sealDigest: string;
    readonly recordedAt: string;
  };
  readonly promotions: {
    readonly receipts: readonly Promotion[];
    readonly page: {
      readonly limit: number;
      readonly afterReceiptDigest: string | null;
      readonly nextAfterReceiptDigest: string | null;
    };
  };
}
