import { ActionRejected, type ActionRequest, type ObjectRow } from '@kf/actions';
import {
  isCanonicalTimestamp,
  isAggregateKind,
  isGovernedAliasToken,
  isMetricValueKind,
  isOpaqueReferenceToken,
  isPromotionAuthorityKind,
  isPromotionRiskTier,
  isSha256,
  type MetricValue,
} from '@kf/ml-registry';

import type { MlPromotionAuthorityKind, MlPromotionRiskTier } from './contracts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const AUTHORIZATION_KEYS = [
  'authorizedActorId',
  'authorizedRoleId',
  'runLineageId',
  'metricDefinitionId',
  'metricPolicyRefId',
] as const;

const EVENT_KEYS = [
  'runLineageId',
  'metricDefinitionId',
  'idempotencyKey',
  'sequence',
  'recordedAt',
  'value',
  'eventDigest',
] as const;

const PROMOTION_REQUIRED_KEYS = [
  'aliasId',
  'authorityKind',
  'candidateRefId',
  'policyRefId',
  'riskTier',
  'runSealId',
] as const;
const PROMOTION_OPTIONAL_KEYS = ['validUntil'] as const;
const AGGREGATE_REFERENCE_KEYS = [
  'referenceId',
  'kind',
  'authorityId',
  'revisionId',
  'sha256',
  'classificationId',
  'policyId',
] as const;
const RUN_LINEAGE_KEYS = [
  'lineageId',
  'runRefId',
  'codeRefId',
  'recipeRefId',
  'environmentRefId',
  'metricPolicyRefId',
  'inputRefIds',
  'outputRefIds',
  'parentModelRefIds',
  'lineageDigest',
] as const;
const METRIC_DEFINITION_KEYS = [
  'definitionId',
  'definitionRefId',
  'metricId',
  'valueKind',
  'unitId',
  'allowedEnumIds',
] as const;
const METRIC_SEGMENT_KEYS = [
  'segmentId',
  'segmentRefId',
  'runLineageId',
  'schemaVersion',
  'ordinal',
  'firstSequence',
  'lastSequence',
  'eventCount',
  'eventDigests',
  'eventManifestDigest',
  'metadataDigest',
] as const;

export function rejected(message: string): never {
  throw new ActionRejected('precondition_failed', message);
}

export function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value) || value !== value.toLowerCase()) {
    rejected(`${field} must be a canonical lowercase UUID`);
  }
  return value;
}

export function requireDigest(value: unknown, field: string): string {
  if (!isSha256(value)) {
    rejected(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function requireSafeId(value: unknown, field: string): string {
  if (!isOpaqueReferenceToken(value)) {
    rejected(`${field} must be a safe opaque identifier`);
  }
  return value;
}

export function requireGovernedId(value: unknown, field: string): string {
  if (!isGovernedAliasToken(value)) rejected(`${field} must be a safe lowercase identifier`);
  return value;
}

export function requireTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string') rejected(`${field} must be a canonical RFC 3339 timestamp`);
  if (!isCanonicalTimestamp(value)) {
    rejected(`${field} must be a canonical four-digit-year RFC 3339 millisecond timestamp`);
  }
  return value;
}

export function requireAliasId(value: unknown, field: string): string {
  if (!isGovernedAliasToken(value)) {
    rejected(`${field} must be a safe lowercase ML alias identifier`);
  }
  return value;
}

export function requireRiskTier(value: unknown, field: string): MlPromotionRiskTier {
  if (!isPromotionRiskTier(value)) {
    rejected(`${field} must be research, regulated, or high_risk`);
  }
  return value;
}

export function requireAuthorityKind(value: unknown, field: string): MlPromotionAuthorityKind {
  if (!isPromotionAuthorityKind(value)) {
    rejected(`${field} must be technical or quality`);
  }
  return value;
}

function requireExactPayload(request: ActionRequest, keys: readonly string[]): void {
  const payload = request.payload;
  if (payload === undefined) rejected(`${request.actionType} requires a payload`);
  const actual = Object.keys(payload).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    rejected(`${request.actionType} payload must contain exactly ${expected.join(', ')}`);
  }
}

export function payloadStringArray(
  request: ActionRequest,
  key: string,
  options: {
    readonly requireOne?: boolean;
    readonly digest?: boolean;
    readonly uuid?: boolean;
  } = {},
): readonly string[] {
  const value = request.payload?.[key];
  if (!Array.isArray(value) || (options.requireOne === true && value.length === 0)) {
    rejected(`${request.actionType} requires payload.${key} to be an array`);
  }
  const checked = value.map((entry, index) => {
    if (options.digest === true) return requireDigest(entry, `payload.${key}[${index}]`);
    if (options.uuid === true) return requireUuid(entry, `payload.${key}[${index}]`);
    return requireGovernedId(entry, `payload.${key}[${index}]`);
  });
  if (new Set(checked).size !== checked.length) {
    rejected(`${request.actionType} requires unique payload.${key} values`);
  }
  return checked;
}

export function payloadNullableString(request: ActionRequest, key: string): string | null {
  const value = request.payload?.[key];
  if (value !== null && typeof value !== 'string') {
    rejected(`${request.actionType} requires payload.${key} to be a string or null`);
  }
  return value;
}

function requireClosedPayload(
  request: ActionRequest,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): void {
  const payload = request.payload;
  if (payload === undefined) rejected(`${request.actionType} requires a payload`);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const actual = Object.keys(payload);
  if (
    requiredKeys.some((key) => !Object.hasOwn(payload, key)) ||
    actual.some((key) => !allowed.has(key))
  ) {
    rejected(
      `${request.actionType} payload must contain ${requiredKeys.join(', ')} and only optional ${optionalKeys.join(', ')}`,
    );
  }
}

export function payloadString(request: ActionRequest, key: string): string {
  const value = request.payload?.[key];
  if (typeof value !== 'string') rejected(`${request.actionType} requires payload.${key}`);
  return value;
}

export function payloadPositiveInteger(request: ActionRequest, key: string): number {
  const value = request.payload?.[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    rejected(`${request.actionType} requires a positive safe integer payload.${key}`);
  }
  return value;
}

function payloadMetricValue(request: ActionRequest): MetricValue {
  const value = request.payload?.['value'];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    rejected(`${request.actionType} requires one typed payload.value`);
  }
  const record = value as Record<string, unknown>;
  if (!isMetricValueKind(record['kind'])) {
    return rejected('payload.value.kind must be number, safe_enum, or timestamp');
  }
  if (record['kind'] === 'number') {
    if (
      Object.keys(record).sort().join(',') !== 'kind,number' ||
      typeof record['number'] !== 'number' ||
      !Number.isFinite(record['number'])
    ) {
      rejected('numeric metric value must contain exactly kind and one finite number');
    }
    return { kind: 'number', number: record['number'] };
  }
  if (record['kind'] === 'safe_enum') {
    if (Object.keys(record).sort().join(',') !== 'enumId,kind') {
      rejected('safe-enum metric value must contain exactly kind and enumId');
    }
    return { kind: 'safe_enum', enumId: requireSafeId(record['enumId'], 'payload.value.enumId') };
  }
  if (record['kind'] === 'timestamp') {
    if (Object.keys(record).sort().join(',') !== 'kind,timestamp') {
      rejected('timestamp metric value must contain exactly kind and timestamp');
    }
    return {
      kind: 'timestamp',
      timestamp: requireTimestamp(record['timestamp'], 'payload.value.timestamp'),
    };
  }
  return rejected('payload.value.kind must be number, safe_enum, or timestamp');
}

export function requireOrganizationTarget(
  request: ActionRequest,
  objects: readonly ObjectRow[],
): void {
  if (
    request.targetIds.length !== 1 ||
    request.targetIds[0] !== request.organizationId ||
    objects.length !== 1 ||
    objects[0]?.id !== request.organizationId ||
    objects[0]?.object_type !== 'organization' ||
    objects[0]?.organization_id !== request.organizationId
  ) {
    rejected(`${request.actionType} must target exactly its visible owning organization object`);
  }
}

export function validateAuthorizationPayload(request: ActionRequest): void {
  requireExactPayload(request, AUTHORIZATION_KEYS);
  requireUuid(payloadString(request, 'authorizedActorId'), 'payload.authorizedActorId');
  requireUuid(payloadString(request, 'authorizedRoleId'), 'payload.authorizedRoleId');
  requireUuid(payloadString(request, 'runLineageId'), 'payload.runLineageId');
  requireUuid(payloadString(request, 'metricDefinitionId'), 'payload.metricDefinitionId');
  requireUuid(payloadString(request, 'metricPolicyRefId'), 'payload.metricPolicyRefId');
}

export function validateEventPayload(request: ActionRequest): MetricValue {
  requireExactPayload(request, EVENT_KEYS);
  requireUuid(payloadString(request, 'runLineageId'), 'payload.runLineageId');
  requireUuid(payloadString(request, 'metricDefinitionId'), 'payload.metricDefinitionId');
  requireSafeId(payloadString(request, 'idempotencyKey'), 'payload.idempotencyKey');
  payloadPositiveInteger(request, 'sequence');
  requireTimestamp(payloadString(request, 'recordedAt'), 'payload.recordedAt');
  requireDigest(payloadString(request, 'eventDigest'), 'payload.eventDigest');
  return payloadMetricValue(request);
}

export function validatePromotionPayload(request: ActionRequest): void {
  requireClosedPayload(request, PROMOTION_REQUIRED_KEYS, PROMOTION_OPTIONAL_KEYS);
  requireAliasId(payloadString(request, 'aliasId'), 'payload.aliasId');
  requireUuid(payloadString(request, 'candidateRefId'), 'payload.candidateRefId');
  requireUuid(payloadString(request, 'runSealId'), 'payload.runSealId');
  requireUuid(payloadString(request, 'policyRefId'), 'payload.policyRefId');
  requireRiskTier(payloadString(request, 'riskTier'), 'payload.riskTier');
  requireAuthorityKind(payloadString(request, 'authorityKind'), 'payload.authorityKind');
  if (Object.hasOwn(request.payload ?? {}, 'validUntil')) {
    requireTimestamp(request.payload?.['validUntil'], 'payload.validUntil');
  }
}

export function validateAggregateReferencePayload(request: ActionRequest): void {
  requireExactPayload(request, AGGREGATE_REFERENCE_KEYS);
  requireUuid(payloadString(request, 'referenceId'), 'payload.referenceId');
  const kind = payloadString(request, 'kind');
  if (!isAggregateKind(kind)) rejected('payload.kind must be a supported ML aggregate kind');
  requireSafeId(payloadString(request, 'authorityId'), 'payload.authorityId');
  requireSafeId(payloadString(request, 'revisionId'), 'payload.revisionId');
  requireDigest(payloadString(request, 'sha256'), 'payload.sha256');
  requireGovernedId(payloadString(request, 'classificationId'), 'payload.classificationId');
  requireGovernedId(payloadString(request, 'policyId'), 'payload.policyId');
}

export function validateRunLineagePayload(request: ActionRequest): void {
  requireExactPayload(request, RUN_LINEAGE_KEYS);
  for (const key of [
    'lineageId',
    'runRefId',
    'codeRefId',
    'recipeRefId',
    'environmentRefId',
    'metricPolicyRefId',
  ]) {
    requireUuid(payloadString(request, key), `payload.${key}`);
  }
  payloadStringArray(request, 'inputRefIds', { requireOne: true, uuid: true });
  payloadStringArray(request, 'outputRefIds', { requireOne: true, uuid: true });
  payloadStringArray(request, 'parentModelRefIds', { uuid: true });
  requireDigest(payloadString(request, 'lineageDigest'), 'payload.lineageDigest');
}

export function validateMetricDefinitionPayload(request: ActionRequest): void {
  requireExactPayload(request, METRIC_DEFINITION_KEYS);
  requireUuid(payloadString(request, 'definitionId'), 'payload.definitionId');
  requireUuid(payloadString(request, 'definitionRefId'), 'payload.definitionRefId');
  requireGovernedId(payloadString(request, 'metricId'), 'payload.metricId');
  const valueKind = payloadString(request, 'valueKind');
  if (!isMetricValueKind(valueKind)) rejected('payload.valueKind is not supported');
  const unitId = payloadNullableString(request, 'unitId');
  if (unitId !== null) requireGovernedId(unitId, 'payload.unitId');
  const allowed = payloadStringArray(request, 'allowedEnumIds');
  if (
    (valueKind === 'number' && (unitId === null || allowed.length !== 0)) ||
    (valueKind === 'safe_enum' && (unitId !== null || allowed.length === 0)) ||
    (valueKind === 'timestamp' && (unitId !== null || allowed.length !== 0))
  ) {
    rejected('payload metric definition does not match its value kind');
  }
}

export function validateMetricSegmentPayload(request: ActionRequest): void {
  requireExactPayload(request, METRIC_SEGMENT_KEYS);
  requireUuid(payloadString(request, 'segmentId'), 'payload.segmentId');
  requireUuid(payloadString(request, 'segmentRefId'), 'payload.segmentRefId');
  requireUuid(payloadString(request, 'runLineageId'), 'payload.runLineageId');
  const schemaVersion = request.payload?.['schemaVersion'];
  if (schemaVersion !== 2) rejected('payload.schemaVersion must be 2');
  const ordinal = payloadPositiveInteger(request, 'ordinal');
  const first = payloadPositiveInteger(request, 'firstSequence');
  const last = payloadPositiveInteger(request, 'lastSequence');
  const count = payloadPositiveInteger(request, 'eventCount');
  const events = payloadStringArray(request, 'eventDigests', { digest: true, requireOne: true });
  if (last < first || count !== last - first + 1 || count !== events.length || ordinal < 1) {
    rejected('payload metric segment must bind one complete contiguous event range');
  }
  requireDigest(payloadString(request, 'eventManifestDigest'), 'payload.eventManifestDigest');
  requireDigest(payloadString(request, 'metadataDigest'), 'payload.metadataDigest');
}

export function requirePromotionCreationTarget(
  request: ActionRequest,
  objects: readonly ObjectRow[],
): void {
  if (
    request.targetIds.length !== 0 ||
    objects.length !== 1 ||
    objects[0]?.object_type !== 'ml_promotion_decision' ||
    objects[0]?.lifecycle_state !== 'recorded' ||
    objects[0]?.organization_id !== request.organizationId ||
    objects[0]?.created_by !== request.actorId
  ) {
    rejected('authorize_ml_promotion must create exactly one new decision object');
  }
}
