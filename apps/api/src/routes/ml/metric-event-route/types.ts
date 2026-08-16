import type { AggregateReference, MetricDefinition, ProvisionalMetricEvent } from '@kf/ml-registry';

interface SqlRow {
  readonly [column: string]: unknown;
}

type ReferenceColumnName =
  'kind' | 'authority_id' | 'revision_id' | 'sha256' | 'classification_id' | 'policy_id';

type ReferenceRow<Prefix extends string> = {
  readonly [Column in `${Prefix}_${ReferenceColumnName}`]: unknown;
};

export type IngestRunRow = SqlRow &
  ReferenceRow<'run'> & {
    readonly lineage_id: unknown;
    readonly run_organization_id: unknown;
  };

export type IngestDefinitionRow = SqlRow &
  ReferenceRow<'definition'> & {
    readonly definition_id: unknown;
    readonly definition_organization_id: unknown;
    readonly metric_id: unknown;
    readonly value_kind: unknown;
    readonly unit_id: unknown;
    readonly allowed_enum_ids: unknown;
  };

export interface IngestReceiptRow extends SqlRow {
  readonly id: unknown;
  readonly sequence_no: unknown;
  readonly recorded_at: unknown;
  readonly status: unknown;
  readonly event_sha256: unknown;
}

export interface IngestRunData {
  readonly lineageId: string;
  readonly reference: AggregateReference;
}

export interface StoredMetricEvent {
  readonly sequence: string;
  readonly recordedAt: string;
  readonly status: 'provisional';
  readonly eventDigest: string;
}

export interface IngestDefinitionData {
  readonly definitionId: string;
  readonly definition: MetricDefinition;
}

export interface StoredMetricResult {
  readonly replayed: boolean;
  readonly metricId: string;
  readonly value: ProvisionalMetricEvent['value'];
  readonly stored: StoredMetricEvent;
}
