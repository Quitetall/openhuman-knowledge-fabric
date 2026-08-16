import {
  decodeIsoTimestamp,
  decodeMemberRole,
  decodeMetricStatus,
  decodeMetricValue,
  decodeNullableString,
  decodePositiveBigintText,
  decodePositiveInteger,
  decodeReference,
  decodeRevocationReason,
  decodeRiskTier,
  decodeSha256,
  decodeString,
  ProjectionError,
} from '../projection.js';
import { canonicalBase64 } from '../validation.js';
import type {
  LineageMemberData,
  LineageMemberRow,
  MetricEventData,
  MetricEventRow,
  MetricSegmentData,
  MetricSegmentRow,
  PromotionData,
  PromotionRow,
  RunLineageData,
  RunLineageRow,
  RunSealData,
  RunSealRow,
} from './types.js';

export function decodeRunLineageRow(row: RunLineageRow): RunLineageData {
  return {
    lineageId: decodeString(row.lineage_id, 'lineage.id'),
    lineageDigest: decodeSha256(row.lineage_sha256, 'lineage.digest'),
    recordedAt: decodeIsoTimestamp(row.lineage_recorded_at, 'lineage.recordedAt'),
    run: decodeReference(
      {
        kind: row.run_kind,
        authorityId: row.run_authority_id,
        revisionId: row.run_revision_id,
        sha256: row.run_sha256,
        classificationId: row.run_classification_id,
        policyId: row.run_policy_id,
      },
      'lineage.run',
      ['run'],
    ),
    code: decodeReference(
      {
        kind: row.code_kind,
        authorityId: row.code_authority_id,
        revisionId: row.code_revision_id,
        sha256: row.code_sha256,
        classificationId: row.code_classification_id,
        policyId: row.code_policy_id,
      },
      'lineage.code',
      ['code'],
    ),
    recipe: decodeReference(
      {
        kind: row.recipe_kind,
        authorityId: row.recipe_authority_id,
        revisionId: row.recipe_revision_id,
        sha256: row.recipe_sha256,
        classificationId: row.recipe_classification_id,
        policyId: row.recipe_policy_id,
      },
      'lineage.recipe',
      ['recipe'],
    ),
    environment: decodeReference(
      {
        kind: row.environment_kind,
        authorityId: row.environment_authority_id,
        revisionId: row.environment_revision_id,
        sha256: row.environment_sha256,
        classificationId: row.environment_classification_id,
        policyId: row.environment_policy_id,
      },
      'lineage.environment',
      ['environment'],
    ),
    metricPolicy: decodeReference(
      {
        kind: row.metric_policy_kind,
        authorityId: row.metric_policy_authority_id,
        revisionId: row.metric_policy_revision_id,
        sha256: row.metric_policy_sha256,
        classificationId: row.metric_policy_classification_id,
        policyId: row.metric_policy_policy_id,
      },
      'lineage.metricPolicy',
      ['metric_policy'],
    ),
  };
}

export function decodeLineageMemberRow(row: LineageMemberRow): LineageMemberData {
  const role = decodeMemberRole(row.member_role, 'lineage.member.role');
  const reference = decodeReference(
    {
      kind: row.member_kind,
      authorityId: row.member_authority_id,
      revisionId: row.member_revision_id,
      sha256: row.member_sha256,
      classificationId: row.member_classification_id,
      policyId: row.member_policy_id,
    },
    'lineage.member.reference',
    role === 'input' ? ['input'] : role === 'output' ? ['output', 'candidate'] : ['parent_model'],
  );
  return {
    role,
    ordinal: decodePositiveInteger(row.ordinal, 'lineage.member.ordinal'),
    reference,
  };
}

export function decodeMetricEventRow(row: MetricEventRow): MetricEventData {
  return {
    sequence: decodePositiveBigintText(row.sequence_no, 'metricEvent.sequence'),
    recordedAt: decodeIsoTimestamp(row.recorded_at, 'metricEvent.recordedAt'),
    status: decodeMetricStatus(row.status, 'metricEvent.status'),
    metricId: decodeString(row.metric_id, 'metricEvent.metricId'),
    unitId: decodeNullableString(row.unit_id, 'metricEvent.unitId'),
    value: decodeMetricValue(
      {
        valueKind: row.value_kind,
        numericValue: row.numeric_value,
        enumValue: row.enum_value,
        timestampValue: row.timestamp_value,
      },
      'metricEvent.value',
    ),
    eventDigest: decodeSha256(row.event_sha256, 'metricEvent.digest'),
  };
}

export function decodeMetricSegmentRow(row: MetricSegmentRow): MetricSegmentData {
  return {
    reference: decodeReference(
      {
        kind: row.segment_kind,
        authorityId: row.segment_authority_id,
        revisionId: row.segment_revision_id,
        sha256: row.segment_sha256,
        classificationId: row.segment_classification_id,
        policyId: row.segment_policy_id,
      },
      'metricSegment.reference',
      ['segment'],
    ),
    ordinal: decodePositiveInteger(row.ordinal, 'metricSegment.ordinal'),
    firstSequence: decodePositiveBigintText(row.first_sequence, 'metricSegment.firstSequence'),
    lastSequence: decodePositiveBigintText(row.last_sequence, 'metricSegment.lastSequence'),
    eventCount: decodePositiveBigintText(row.event_count, 'metricSegment.eventCount'),
    metadataDigest: decodeSha256(row.metadata_sha256, 'metricSegment.metadataDigest'),
  };
}

export function decodeRunSealRow(row: RunSealRow): RunSealData {
  return {
    lineageDigest: decodeSha256(row.lineage_sha256, 'runSeal.lineageDigest'),
    segmentManifestDigest: decodeSha256(
      row.segment_manifest_sha256,
      'runSeal.segmentManifestDigest',
    ),
    eventCount: decodePositiveBigintText(row.event_count, 'runSeal.eventCount'),
    sealedAt: decodeIsoTimestamp(row.sealed_at, 'runSeal.sealedAt'),
    signingKeyId: decodeString(row.signing_key_id, 'runSeal.signingKeyId'),
    sealDigest: decodeSha256(row.seal_sha256, 'runSeal.sealDigest'),
    recordedAt: decodeIsoTimestamp(row.recorded_at, 'runSeal.recordedAt'),
  };
}

export function decodePromotionRow(row: PromotionRow): PromotionData {
  const signature = decodeString(row.signature, 'promotion.signature');
  if (canonicalBase64(signature, 64) === undefined) {
    throw new ProjectionError('ML projection field promotion.signature is invalid');
  }
  const revokedAt = row.revoked_at;
  const reasonCode = row.reason_code;
  let revocation: PromotionData['revocation'];
  if (revokedAt === null && reasonCode === null) {
    revocation = null;
  } else if (revokedAt !== null && reasonCode !== null) {
    revocation = {
      reasonCode: decodeRevocationReason(reasonCode, 'promotion.revocation.reasonCode'),
      revokedAt: decodeIsoTimestamp(revokedAt, 'promotion.revocation.revokedAt'),
    };
  } else {
    throw new ProjectionError('ML projection field promotion.revocation is invalid');
  }
  return {
    aliasId: decodeString(row.alias_id, 'promotion.aliasId'),
    candidate: decodeReference(
      {
        kind: row.candidate_kind,
        authorityId: row.candidate_authority_id,
        revisionId: row.candidate_revision_id,
        sha256: row.candidate_sha256,
        classificationId: row.candidate_classification_id,
        policyId: row.candidate_policy_id,
      },
      'promotion.candidate',
      ['candidate'],
    ),
    policy: decodeReference(
      {
        kind: row.policy_kind,
        authorityId: row.policy_authority_id,
        revisionId: row.policy_revision_id,
        sha256: row.policy_sha256,
        classificationId: row.policy_classification_id,
        policyId: row.policy_policy_id,
      },
      'promotion.policy',
      ['metric_policy'],
    ),
    riskTier: decodeRiskTier(row.risk_tier, 'promotion.riskTier'),
    technicalAuthorityDecision: decodeReference(
      {
        kind: row.technical_kind,
        authorityId: row.technical_authority_id,
        revisionId: row.technical_revision_id,
        sha256: row.technical_sha256,
        classificationId: row.technical_classification_id,
        policyId: row.technical_policy_id,
      },
      'promotion.technicalAuthorityDecision',
      ['evidence'],
    ),
    qualityAuthorityDecision: decodeReference(
      {
        kind: row.quality_kind,
        authorityId: row.quality_authority_id,
        revisionId: row.quality_revision_id,
        sha256: row.quality_sha256,
        classificationId: row.quality_classification_id,
        policyId: row.quality_policy_id,
      },
      'promotion.qualityAuthorityDecision',
      ['evidence'],
    ),
    promotedAt: decodeIsoTimestamp(row.promoted_at, 'promotion.promotedAt'),
    signingKeyId: decodeString(row.signing_key_id, 'promotion.signingKeyId'),
    receiptDigest: decodeSha256(row.receipt_sha256, 'promotion.receiptDigest'),
    signature,
    revocation,
  };
}
