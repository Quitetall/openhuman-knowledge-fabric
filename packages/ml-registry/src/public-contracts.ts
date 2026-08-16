const aggregateKinds = [
  'run',
  'code',
  'recipe',
  'environment',
  'metric_policy',
  'input',
  'output',
  'parent_model',
  'metric_definition',
  'segment',
  'candidate',
  'evidence',
] as const;

const metricValueKinds = ['number', 'safe_enum', 'timestamp'] as const;
const promotionRiskTiers = ['research', 'regulated', 'high_risk'] as const;
const promotionAuthorityKinds = ['technical', 'quality'] as const;
const promotionRevocationReasons = [
  'evidence_invalid',
  'policy_violation',
  'key_compromise',
  'operator_withdrawal',
] as const;
const lineageMemberRoles = ['input', 'output', 'parent_model'] as const;

export const ML_AGGREGATE_KINDS = Object.freeze(aggregateKinds);
export const ML_METRIC_VALUE_KINDS = Object.freeze(metricValueKinds);
export const ML_PROMOTION_RISK_TIERS = Object.freeze(promotionRiskTiers);
export const ML_PROMOTION_AUTHORITY_KINDS = Object.freeze(promotionAuthorityKinds);
export const ML_PROMOTION_REVOCATION_REASONS = Object.freeze(promotionRevocationReasons);
export const ML_LINEAGE_MEMBER_ROLES = Object.freeze(lineageMemberRoles);

export type AggregateKind = (typeof ML_AGGREGATE_KINDS)[number];
export type MetricValueKind = (typeof ML_METRIC_VALUE_KINDS)[number];
export type MlPromotionRiskTier = (typeof ML_PROMOTION_RISK_TIERS)[number];
export type MlPromotionAuthorityKind = (typeof ML_PROMOTION_AUTHORITY_KINDS)[number];
export type PromotionRevocationReason = (typeof ML_PROMOTION_REVOCATION_REASONS)[number];
export type MlLineageMemberRole = (typeof ML_LINEAGE_MEMBER_ROLES)[number];

export const ML_OPAQUE_REFERENCE_TOKEN = Object.freeze(/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u);
export const ML_GOVERNED_ALIAS_TOKEN = Object.freeze(/^[a-z][a-z0-9._:-]{0,127}$/u);
export const ML_SHA256 = Object.freeze(/^[0-9a-f]{64}$/u);
export const ML_CANONICAL_TIMESTAMP = Object.freeze(
  /^(?!0000-)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u,
);

function isOneOf<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && values.includes(value as T[number]);
}

export function isAggregateKind(value: unknown): value is AggregateKind {
  return isOneOf(ML_AGGREGATE_KINDS, value);
}

export function isMetricValueKind(value: unknown): value is MetricValueKind {
  return isOneOf(ML_METRIC_VALUE_KINDS, value);
}

export function isPromotionRiskTier(value: unknown): value is MlPromotionRiskTier {
  return isOneOf(ML_PROMOTION_RISK_TIERS, value);
}

export function isPromotionAuthorityKind(value: unknown): value is MlPromotionAuthorityKind {
  return isOneOf(ML_PROMOTION_AUTHORITY_KINDS, value);
}

export function isPromotionRevocationReason(value: unknown): value is PromotionRevocationReason {
  return isOneOf(ML_PROMOTION_REVOCATION_REASONS, value);
}

export function isLineageMemberRole(value: unknown): value is MlLineageMemberRole {
  return isOneOf(ML_LINEAGE_MEMBER_ROLES, value);
}

export function isOpaqueReferenceToken(value: unknown): value is string {
  return typeof value === 'string' && ML_OPAQUE_REFERENCE_TOKEN.test(value);
}

export function isGovernedAliasToken(value: unknown): value is string {
  return typeof value === 'string' && ML_GOVERNED_ALIAS_TOKEN.test(value);
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && ML_SHA256.test(value);
}

export function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return (
    ML_CANONICAL_TIMESTAMP.test(value) &&
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}
