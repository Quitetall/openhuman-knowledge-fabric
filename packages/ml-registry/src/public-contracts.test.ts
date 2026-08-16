import { describe, expect, it } from 'vitest';
import {
  ML_AGGREGATE_KINDS,
  ML_CANONICAL_TIMESTAMP,
  ML_GOVERNED_ALIAS_TOKEN,
  ML_LINEAGE_MEMBER_ROLES,
  ML_METRIC_VALUE_KINDS,
  ML_OPAQUE_REFERENCE_TOKEN,
  ML_PROMOTION_AUTHORITY_KINDS,
  ML_PROMOTION_REVOCATION_REASONS,
  ML_PROMOTION_RISK_TIERS,
  ML_SHA256,
  isAggregateKind,
  isCanonicalTimestamp,
  isGovernedAliasToken,
  isLineageMemberRole,
  isMetricValueKind,
  isOpaqueReferenceToken,
  isPromotionAuthorityKind,
  isPromotionRevocationReason,
  isPromotionRiskTier,
  isSha256,
} from './index.js';

describe('ML public runtime contracts', () => {
  it('publishes the governed vocabularies as frozen literal tuples', () => {
    expect(Object.isFrozen(ML_AGGREGATE_KINDS)).toBe(true);
    expect(ML_AGGREGATE_KINDS).toEqual([
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
    ]);
    expect(ML_METRIC_VALUE_KINDS).toEqual(['number', 'safe_enum', 'timestamp']);
    expect(ML_PROMOTION_RISK_TIERS).toEqual(['research', 'regulated', 'high_risk']);
    expect(ML_PROMOTION_AUTHORITY_KINDS).toEqual(['technical', 'quality']);
    expect(ML_PROMOTION_REVOCATION_REASONS).toEqual([
      'evidence_invalid',
      'policy_violation',
      'key_compromise',
      'operator_withdrawal',
    ]);
    expect(ML_LINEAGE_MEMBER_ROLES).toEqual(['input', 'output', 'parent_model']);
  });

  it('keeps shared predicates aligned with the exported regex contracts', () => {
    expect(isOpaqueReferenceToken('Run_01:@+-')).toBe(ML_OPAQUE_REFERENCE_TOKEN.test('Run_01:@+-'));
    expect(isGovernedAliasToken('encoder.production')).toBe(
      ML_GOVERNED_ALIAS_TOKEN.test('encoder.production'),
    );
    expect(isSha256('a'.repeat(64))).toBe(ML_SHA256.test('a'.repeat(64)));
    expect(isCanonicalTimestamp('2026-08-14T12:01:00.000Z')).toBe(
      ML_CANONICAL_TIMESTAMP.test('2026-08-14T12:01:00.000Z'),
    );
    expect(isCanonicalTimestamp('+010000-08-14T12:01:00.000Z')).toBe(false);
  });

  it('recognizes every shared runtime vocabulary and rejects drift values', () => {
    expect(ML_AGGREGATE_KINDS.every(isAggregateKind)).toBe(true);
    expect(ML_METRIC_VALUE_KINDS.every(isMetricValueKind)).toBe(true);
    expect(ML_PROMOTION_RISK_TIERS.every(isPromotionRiskTier)).toBe(true);
    expect(ML_PROMOTION_AUTHORITY_KINDS.every(isPromotionAuthorityKind)).toBe(true);
    expect(ML_PROMOTION_REVOCATION_REASONS.every(isPromotionRevocationReason)).toBe(true);
    expect(ML_LINEAGE_MEMBER_ROLES.every(isLineageMemberRole)).toBe(true);
    expect(isAggregateKind('subject')).toBe(false);
    expect(isPromotionRiskTier('clinical')).toBe(false);
    expect(isPromotionRevocationReason('expired')).toBe(false);
  });
});
