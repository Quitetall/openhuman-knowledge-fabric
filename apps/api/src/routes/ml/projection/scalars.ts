import type {
  AggregateKind,
  MlLineageMemberRole,
  MetricValueKind,
  MlPromotionRiskTier,
  PromotionRevocationReason,
} from '@kf/ml-registry';
import {
  isAggregateKind,
  isCanonicalTimestamp,
  isGovernedAliasToken,
  isLineageMemberRole,
  isMetricValueKind,
  isOpaqueReferenceToken,
  isPromotionRevocationReason,
  isPromotionRiskTier,
  isSha256,
} from '@kf/ml-registry';

import { invalid } from './error.js';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

export function decodeString(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(field);
  return value;
}

export function decodeNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return decodeString(value, field);
}

export function decodeSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid(field);
  return value;
}

export function decodePositiveInteger(value: unknown, field: string): number {
  const integer = decodeSafeInteger(value, field);
  if (integer <= 0) invalid(field);
  return integer;
}

export function decodeBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(field);
  return value;
}

export function decodeIsoTimestamp(value: unknown, field: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.valueOf())) invalid(field);
    const timestamp = value.toISOString();
    if (!isCanonicalTimestamp(timestamp)) invalid(field);
    return timestamp;
  }
  if (typeof value !== 'string') invalid(field);
  if (!isCanonicalTimestamp(value)) {
    invalid(field);
  }
  return value;
}

export function decodeSha256(value: unknown, field: string): string {
  const digest = decodeString(value, field);
  if (!isSha256(digest)) invalid(field);
  return digest;
}

export function decodePositiveBigintText(value: unknown, field: string): string {
  const text = decodeString(value, field);
  if (!/^[1-9][0-9]*$/u.test(text) || BigInt(text) > MAX_POSTGRES_BIGINT) invalid(field);
  return text;
}

export function decodeStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) invalid(field);
  return value;
}

export function decodeAggregateKind(value: unknown, field: string): AggregateKind {
  if (isAggregateKind(value)) {
    return value;
  }
  return invalid(field);
}

export function decodeMetricValueKind(value: unknown, field: string): MetricValueKind {
  if (isMetricValueKind(value)) {
    return value;
  }
  return invalid(field);
}

export function decodeRiskTier(value: unknown, field: string): MlPromotionRiskTier {
  if (isPromotionRiskTier(value)) {
    return value;
  }
  return invalid(field);
}

export function decodeMemberRole(value: unknown, field: string): MlLineageMemberRole {
  if (isLineageMemberRole(value)) {
    return value;
  }
  return invalid(field);
}

export function decodeMetricStatus(value: unknown, field: string): 'provisional' {
  if (value !== 'provisional') invalid(field);
  return value;
}

export function decodeRevocationReason(value: unknown, field: string): PromotionRevocationReason {
  if (isPromotionRevocationReason(value)) {
    return value;
  }
  return invalid(field);
}

export function decodeOpaqueId(value: unknown, field: string): string {
  const id = decodeString(value, field);
  if (!isOpaqueReferenceToken(id)) invalid(field);
  return id;
}

export function decodeGovernedId(value: unknown, field: string): string {
  const id = decodeString(value, field);
  if (!isGovernedAliasToken(id)) invalid(field);
  return id;
}

export function decodeOrganizationId(value: unknown, field: string): string {
  const id = decodeString(value, field);
  if (!CANONICAL_UUID.test(id) || id !== id.toLowerCase()) invalid(field);
  return id;
}
