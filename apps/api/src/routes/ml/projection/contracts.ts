import type { AggregateKind } from '@kf/ml-registry';

export interface AggregateProjection {
  readonly kind: AggregateKind;
  readonly authorityId: string;
  readonly revisionId: string;
  readonly sha256: string;
  readonly classificationId: string;
  readonly policyId: string;
}

export interface ReferenceColumns {
  readonly kind: unknown;
  readonly authorityId: unknown;
  readonly revisionId: unknown;
  readonly sha256: unknown;
  readonly classificationId: unknown;
  readonly policyId: unknown;
}

export interface CanonicalReferenceColumns extends ReferenceColumns {
  readonly organizationId: unknown;
}

export interface MetricValueColumns {
  readonly valueKind: unknown;
  readonly numericValue: unknown;
  readonly enumValue: unknown;
  readonly timestampValue: unknown;
}
