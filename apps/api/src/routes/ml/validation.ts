import {
  ML_GOVERNED_ALIAS_TOKEN,
  ML_OPAQUE_REFERENCE_TOKEN,
  ML_SHA256,
  isCanonicalTimestamp,
  isGovernedAliasToken,
  isLineageMemberRole,
  isOpaqueReferenceToken,
  isSha256,
  type MetricValue,
  type MlLineageMemberRole,
} from '@kf/ml-registry';
import type { MemberCursor, MlRunQuery, ProjectionPages } from './contracts.js';

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 500;
const MAX_BIGINT = 9_223_372_036_854_775_807n;
const MAX_INTEGER = 2_147_483_647;

export const OPAQUE_REFERENCE_TOKEN = ML_OPAQUE_REFERENCE_TOKEN;
export const GOVERNED_ALIAS_TOKEN = ML_GOVERNED_ALIAS_TOKEN;
export const SHA256 = ML_SHA256;

export interface ParsedMetricEventBody {
  readonly idempotencyKey: string;
  readonly sequence: number;
  readonly recordedAt: string;
  readonly value: MetricValue;
}

const MEMBER_ORDER: Readonly<Record<MlLineageMemberRole, number>> = {
  input: 1,
  output: 2,
  parent_model: 3,
};

function queryValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError('pagination parameters must appear once');
  return value;
}

function parseLimit(value: unknown, name = 'limit'): number {
  const raw = queryValue(value);
  if (raw === undefined) return DEFAULT_PAGE_LIMIT;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new TypeError(`${name} must be a positive integer`);
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit > MAX_PAGE_LIMIT) {
    throw new TypeError(`${name} must be at most ${MAX_PAGE_LIMIT}`);
  }
  return limit;
}

function parseAfterSequence(value: unknown): string {
  const raw = queryValue(value);
  if (raw === undefined) return '0';
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new TypeError('afterSequence must be a non-negative integer');
  }
  if (BigInt(raw) > MAX_BIGINT) throw new TypeError('afterSequence exceeds PostgreSQL bigint');
  return raw;
}

function parseMemberCursor(value: unknown): MemberCursor {
  const raw = queryValue(value);
  if (raw === undefined) return { token: null, roleOrder: 0, ordinal: 0 };
  const match = /^([^:]+):([1-9][0-9]*)$/.exec(raw);
  if (match === null) {
    throw new TypeError('afterMember must be a lineage role and positive ordinal');
  }
  const role = isLineageMemberRole(match[1]) ? match[1] : undefined;
  if (role === undefined) {
    throw new TypeError('afterMember must be a lineage role and positive ordinal');
  }
  const ordinal = Number(match[2]);
  if (!Number.isSafeInteger(ordinal) || ordinal > MAX_INTEGER) {
    throw new TypeError('afterMember ordinal exceeds PostgreSQL integer');
  }
  return { token: raw, roleOrder: MEMBER_ORDER[role], ordinal };
}

function parseOrdinalCursor(value: unknown): number {
  const raw = queryValue(value);
  if (raw === undefined) return 0;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new TypeError('afterOrdinal must be a non-negative integer');
  }
  const ordinal = Number(raw);
  if (!Number.isSafeInteger(ordinal) || ordinal > MAX_INTEGER) {
    throw new TypeError('afterOrdinal exceeds PostgreSQL integer');
  }
  return ordinal;
}

function parseReceiptCursor(value: unknown): string | null {
  const raw = queryValue(value);
  if (raw === undefined) return null;
  if (!isSha256(raw)) throw new TypeError('afterReceiptDigest must be a lowercase SHA-256');
  return raw;
}

export function parseProjectionPages(query: MlRunQuery): ProjectionPages {
  return {
    events: {
      limit: parseLimit(query.limit),
      afterSequence: parseAfterSequence(query.afterSequence),
    },
    members: {
      limit: parseLimit(query.memberLimit, 'memberLimit'),
      after: parseMemberCursor(query.afterMember),
    },
    segments: {
      limit: parseLimit(query.segmentLimit, 'segmentLimit'),
      afterOrdinal: parseOrdinalCursor(query.afterOrdinal),
    },
    promotions: {
      limit: parseLimit(query.promotionLimit, 'promotionLimit'),
      afterReceiptDigest: parseReceiptCursor(query.afterReceiptDigest),
    },
  };
}

export function exactObjectKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalTimestamp(value: unknown): value is string {
  return isCanonicalTimestamp(value);
}

/** Parse untrusted HTTP metric input once before it crosses into registry code. */
export function parseMetricEventBody(value: unknown): ParsedMetricEventBody | undefined {
  if (!exactObjectKeys(value, ['idempotencyKey', 'sequence', 'recordedAt', 'value'])) {
    return undefined;
  }
  if (
    typeof value['idempotencyKey'] !== 'string' ||
    !isOpaqueReferenceToken(value['idempotencyKey']) ||
    typeof value['sequence'] !== 'number' ||
    !Number.isSafeInteger(value['sequence']) ||
    value['sequence'] <= 0 ||
    !canonicalTimestamp(value['recordedAt'])
  ) {
    return undefined;
  }

  const metricValue = value['value'];
  let parsedValue: MetricValue;
  if (exactObjectKeys(metricValue, ['kind', 'number']) && metricValue['kind'] === 'number') {
    if (typeof metricValue['number'] !== 'number' || !Number.isFinite(metricValue['number'])) {
      return undefined;
    }
    parsedValue = { kind: 'number', number: metricValue['number'] };
  } else if (
    exactObjectKeys(metricValue, ['kind', 'enumId']) &&
    metricValue['kind'] === 'safe_enum'
  ) {
    if (typeof metricValue['enumId'] !== 'string' || !isGovernedAliasToken(metricValue['enumId'])) {
      return undefined;
    }
    parsedValue = { kind: 'safe_enum', enumId: metricValue['enumId'] };
  } else if (
    exactObjectKeys(metricValue, ['kind', 'timestamp']) &&
    metricValue['kind'] === 'timestamp' &&
    canonicalTimestamp(metricValue['timestamp'])
  ) {
    parsedValue = { kind: 'timestamp', timestamp: metricValue['timestamp'] };
  } else {
    return undefined;
  }

  return Object.freeze({
    idempotencyKey: value['idempotencyKey'],
    sequence: value['sequence'],
    recordedAt: value['recordedAt'],
    value: Object.freeze(parsedValue),
  });
}

export function canonicalBase64(value: string, expectedBytes: number): Buffer | undefined {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return undefined;
  }
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === expectedBytes && bytes.toString('base64') === value ? bytes : undefined;
}

export function postgresFailure(error: unknown): {
  readonly code?: string;
  readonly message?: string;
} {
  return error !== null && typeof error === 'object'
    ? (error as { readonly code?: string; readonly message?: string })
    : {};
}
