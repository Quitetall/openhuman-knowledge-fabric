import type { ProvisionalMetricEvent } from '@kf/ml-registry';
import {
  decodeCanonicalReference,
  decodeIsoTimestamp,
  decodeMetricStatus,
  decodeMetricValueKind,
  decodeNullableString,
  decodePositiveBigintText,
  decodeSha256,
  decodeString,
  decodeStringArray,
  ProjectionError,
} from '../projection.js';
import type {
  IngestDefinitionData,
  IngestDefinitionRow,
  IngestReceiptRow,
  IngestRunData,
  IngestRunRow,
  StoredMetricEvent,
} from './types.js';

export function decodeIngestRunRow(
  row: IngestRunRow,
  organizationId: string,
  authorityId: string,
  revisionId: string,
): IngestRunData {
  const reference = decodeCanonicalReference(
    {
      organizationId: row.run_organization_id,
      kind: row.run_kind,
      authorityId: row.run_authority_id,
      revisionId: row.run_revision_id,
      sha256: row.run_sha256,
      classificationId: row.run_classification_id,
      policyId: row.run_policy_id,
    },
    'metricIngest.run',
    ['run'],
  );
  if (
    reference.organizationId !== organizationId ||
    reference.authorityId !== authorityId ||
    reference.revisionId !== revisionId
  ) {
    throw new ProjectionError('ML metric-ingest run does not match request authority');
  }
  return {
    lineageId: decodeString(row.lineage_id, 'metricIngest.run.lineageId'),
    reference,
  };
}

export function decodeIngestDefinitionRow(
  row: IngestDefinitionRow,
  organizationId: string,
  authorityId: string,
  revisionId: string,
): IngestDefinitionData {
  const reference = decodeCanonicalReference(
    {
      organizationId: row.definition_organization_id,
      kind: row.definition_kind,
      authorityId: row.definition_authority_id,
      revisionId: row.definition_revision_id,
      sha256: row.definition_sha256,
      classificationId: row.definition_classification_id,
      policyId: row.definition_policy_id,
    },
    'metricIngest.definition.reference',
    ['metric_definition'],
  );
  if (
    reference.organizationId !== organizationId ||
    reference.authorityId !== authorityId ||
    reference.revisionId !== revisionId
  ) {
    throw new ProjectionError('ML metric definition does not match request authority');
  }
  return {
    definitionId: decodeString(row.definition_id, 'metricIngest.definition.id'),
    definition: {
      reference,
      metricId: decodeString(row.metric_id, 'metricIngest.definition.metricId'),
      valueKind: decodeMetricValueKind(row.value_kind, 'metricIngest.definition.valueKind'),
      unitId: decodeNullableString(row.unit_id, 'metricIngest.definition.unitId'),
      allowedValues: decodeStringArray(
        row.allowed_enum_ids,
        'metricIngest.definition.allowedValues',
      ),
    },
  };
}

export function decodeStoredMetricEvent(
  row: IngestReceiptRow,
  candidate: ProvisionalMetricEvent,
): StoredMetricEvent {
  decodeString(row.id, 'metricIngest.receipt.id');
  const sequence = decodePositiveBigintText(row.sequence_no, 'metricIngest.receipt.sequence');
  const recordedAt = decodeIsoTimestamp(row.recorded_at, 'metricIngest.receipt.recordedAt');
  const status = decodeMetricStatus(row.status, 'metricIngest.receipt.status');
  const eventDigest = decodeSha256(row.event_sha256, 'metricIngest.receipt.eventDigest');
  if (
    sequence !== String(candidate.sequence) ||
    recordedAt !== candidate.recordedAt ||
    eventDigest !== candidate.eventDigest
  ) {
    throw new ProjectionError('stored metric receipt does not match canonical event');
  }
  return { sequence, recordedAt, status, eventDigest };
}
