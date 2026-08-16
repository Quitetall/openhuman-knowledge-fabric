import { isLineageMemberRole } from '@kf/ml-registry/contracts';
import type { AggregateReference, MetricEvent, Promotion, RunProjection } from './run-projection';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasStrings(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => typeof value[field] === 'string');
}

function isReference(value: unknown): value is AggregateReference {
  const ref = record(value);
  return (
    ref !== undefined &&
    hasStrings(ref, ['kind', 'authorityId', 'revisionId', 'sha256', 'classificationId', 'policyId'])
  );
}

function isMetricEvent(value: unknown): value is MetricEvent {
  const event = record(value);
  const typed = record(event?.['value']);
  if (event === undefined || typed === undefined) return false;
  const validValue =
    (typed['kind'] === 'number' &&
      typeof typed['number'] === 'number' &&
      Number.isFinite(typed['number'])) ||
    (typed['kind'] === 'safe_enum' && typeof typed['enumId'] === 'string') ||
    (typed['kind'] === 'timestamp' && typeof typed['timestamp'] === 'string');
  return (
    hasStrings(event, ['sequence', 'recordedAt', 'status', 'metricId', 'eventDigest']) &&
    event['status'] === 'provisional' &&
    (event['unitId'] === null || typeof event['unitId'] === 'string') &&
    validValue
  );
}

function isPromotion(value: unknown): value is Promotion {
  const promotion = record(value);
  if (promotion === undefined) return false;
  const revocation = promotion['revocation'];
  return (
    hasStrings(promotion, [
      'aliasId',
      'riskTier',
      'promotedAt',
      'signingKeyId',
      'receiptDigest',
      'signature',
    ]) &&
    ['recorded', 'revoked'].includes(String(promotion['status'])) &&
    isReference(promotion['candidate']) &&
    isReference(promotion['policy']) &&
    isReference(promotion['technicalAuthorityDecision']) &&
    isReference(promotion['qualityAuthorityDecision']) &&
    (revocation === null ||
      (record(revocation) !== undefined &&
        hasStrings(record(revocation)!, ['reasonCode', 'revokedAt'])))
  );
}

function isRunProjection(value: unknown): value is RunProjection {
  const body = record(value);
  const lineage = record(body?.['lineage']);
  const members = record(lineage?.['members']);
  const memberPage = record(members?.['page']);
  const metrics = record(body?.['metrics']);
  const page = record(metrics?.['page']);
  const segments = record(body?.['segments']);
  const segmentPage = record(segments?.['page']);
  const promotions = record(body?.['promotions']);
  const promotionPage = record(promotions?.['page']);
  if (
    body === undefined ||
    lineage === undefined ||
    members === undefined ||
    memberPage === undefined ||
    metrics === undefined ||
    page === undefined ||
    segments === undefined ||
    segmentPage === undefined ||
    promotions === undefined ||
    promotionPage === undefined
  ) {
    return false;
  }
  const seal = body['seal'];
  return (
    body['schemaVersion'] === 'kf.ml.run-projection.v1' &&
    isReference(body['run']) &&
    hasStrings(lineage, ['lineageDigest', 'recordedAt']) &&
    isReference(lineage['code']) &&
    isReference(lineage['recipe']) &&
    isReference(lineage['environment']) &&
    isReference(lineage['metricPolicy']) &&
    Array.isArray(members['items']) &&
    members['items'].every((member) => {
      const item = record(member);
      return (
        item !== undefined &&
        isLineageMemberRole(item['role']) &&
        typeof item['ordinal'] === 'number' &&
        Number.isInteger(item['ordinal']) &&
        item['ordinal'] >= 1 &&
        isReference(item['reference'])
      );
    }) &&
    typeof memberPage['limit'] === 'number' &&
    Number.isInteger(memberPage['limit']) &&
    memberPage['limit'] >= 1 &&
    memberPage['limit'] <= 500 &&
    (memberPage['afterMember'] === null || typeof memberPage['afterMember'] === 'string') &&
    (memberPage['nextAfterMember'] === null || typeof memberPage['nextAfterMember'] === 'string') &&
    Array.isArray(metrics['events']) &&
    metrics['events'].every(isMetricEvent) &&
    typeof page['limit'] === 'number' &&
    Number.isInteger(page['limit']) &&
    page['limit'] >= 1 &&
    page['limit'] <= 500 &&
    typeof page['afterSequence'] === 'string' &&
    (page['nextAfterSequence'] === null || typeof page['nextAfterSequence'] === 'string') &&
    Array.isArray(segments['items']) &&
    segments['items'].every((segment) => {
      const row = record(segment);
      return (
        row !== undefined &&
        isReference(row['reference']) &&
        typeof row['ordinal'] === 'number' &&
        Number.isInteger(row['ordinal']) &&
        hasStrings(row, ['firstSequence', 'lastSequence', 'eventCount', 'metadataDigest'])
      );
    }) &&
    typeof segmentPage['limit'] === 'number' &&
    Number.isInteger(segmentPage['limit']) &&
    segmentPage['limit'] >= 1 &&
    segmentPage['limit'] <= 500 &&
    typeof segmentPage['afterOrdinal'] === 'number' &&
    Number.isInteger(segmentPage['afterOrdinal']) &&
    (segmentPage['nextAfterOrdinal'] === null ||
      (typeof segmentPage['nextAfterOrdinal'] === 'number' &&
        Number.isInteger(segmentPage['nextAfterOrdinal']))) &&
    (seal === null ||
      (record(seal) !== undefined &&
        hasStrings(record(seal)!, [
          'lineageDigest',
          'segmentManifestDigest',
          'eventCount',
          'sealedAt',
          'signingKeyId',
          'sealDigest',
          'recordedAt',
        ]))) &&
    Array.isArray(promotions['receipts']) &&
    promotions['receipts'].every(isPromotion) &&
    typeof promotionPage['limit'] === 'number' &&
    Number.isInteger(promotionPage['limit']) &&
    promotionPage['limit'] >= 1 &&
    promotionPage['limit'] <= 500 &&
    (promotionPage['afterReceiptDigest'] === null ||
      typeof promotionPage['afterReceiptDigest'] === 'string') &&
    (promotionPage['nextAfterReceiptDigest'] === null ||
      typeof promotionPage['nextAfterReceiptDigest'] === 'string')
  );
}

export function parseRunProjection(value: unknown): RunProjection {
  if (!isRunProjection(value)) throw new Error('ML run projection did not match v1 contract');
  return value;
}
