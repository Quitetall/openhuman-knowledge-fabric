import { describe, expect, it } from 'vitest';
import {
  ML_AGGREGATE_KINDS,
  ML_GOVERNED_ALIAS_TOKEN,
  ML_METRIC_VALUE_KINDS,
  ML_OPAQUE_REFERENCE_TOKEN,
  ML_PROMOTION_REVOCATION_REASONS,
  ML_PROMOTION_RISK_TIERS,
  ML_SHA256,
} from '@kf/ml-registry';
import {
  GOVERNED_ALIAS_TOKEN,
  OPAQUE_REFERENCE_TOKEN,
  SHA256,
  parseMetricEventBody,
  parseProjectionPages,
} from './validation.js';
import {
  decodeAggregateKind,
  decodeMetricValueKind,
  decodeRevocationReason,
  decodeRiskTier,
} from './projection/scalars.js';

describe('ML route validation shared contracts', () => {
  it('aliases route regexes to the registry public contract', () => {
    expect(OPAQUE_REFERENCE_TOKEN).toBe(ML_OPAQUE_REFERENCE_TOKEN);
    expect(GOVERNED_ALIAS_TOKEN).toBe(ML_GOVERNED_ALIAS_TOKEN);
    expect(SHA256).toBe(ML_SHA256);
  });

  it('decodes shared projection vocabularies without local drift', () => {
    expect(ML_AGGREGATE_KINDS.map((kind) => decodeAggregateKind(kind, 'kind'))).toEqual(
      ML_AGGREGATE_KINDS,
    );
    expect(ML_METRIC_VALUE_KINDS.map((kind) => decodeMetricValueKind(kind, 'kind'))).toEqual(
      ML_METRIC_VALUE_KINDS,
    );
    expect(ML_PROMOTION_RISK_TIERS.map((tier) => decodeRiskTier(tier, 'riskTier'))).toEqual(
      ML_PROMOTION_RISK_TIERS,
    );
    expect(
      ML_PROMOTION_REVOCATION_REASONS.map((reason) => decodeRevocationReason(reason, 'reasonCode')),
    ).toEqual(ML_PROMOTION_REVOCATION_REASONS);
  });

  it('preserves metric event body and pagination rejection language', () => {
    expect(
      parseMetricEventBody({
        idempotencyKey: 'worker-01:000001',
        sequence: 1,
        recordedAt: '2026-08-14T12:01:00.000Z',
        value: { kind: 'safe_enum', enumId: 'pass' },
      }),
    ).toMatchObject({ value: { kind: 'safe_enum', enumId: 'pass' } });
    expect(
      parseMetricEventBody({
        idempotencyKey: 'worker-01:000001',
        sequence: 1,
        recordedAt: '2026-08-14T12:01:00.000Z',
        value: { kind: 'safe_enum', enumId: 'operator said probably fine' },
      }),
    ).toBeUndefined();
    expect(() => parseProjectionPages({ afterMember: 'subject:1' })).toThrow(
      /afterMember must be a lineage role and positive ordinal/,
    );
  });
});
