import type { CheckpointFormat, AuditSequence } from './contracts.js';

const PG_BIGINT_MAX_DECIMAL = '9223372036854775807';
const JS_SAFE_INTEGER_MAX_DECIMAL = '9007199254740991';
const CANONICAL_POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const SIGNING_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** One filename-safe identifier shared by signing and permanent verification-key loading. */
export function checkpointSigningKeyId(value: string): string {
  if (!SIGNING_KEY_ID.test(value)) {
    throw new Error('checkpoint signing key id must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}');
  }
  return value;
}

/** Normalize a sequence supplied at an API edge without ever rounding it. */
export function auditSequence(value: string | bigint | number): AuditSequence {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError('audit sequence number must be a positive safe integer');
    }
    text = String(value);
  } else {
    text = value.toString();
  }
  if (
    !CANONICAL_POSITIVE_DECIMAL.test(text) ||
    text.length > PG_BIGINT_MAX_DECIMAL.length ||
    (text.length === PG_BIGINT_MAX_DECIMAL.length && text > PG_BIGINT_MAX_DECIMAL)
  ) {
    throw new RangeError('audit sequence must be a canonical positive PostgreSQL bigint decimal');
  }
  return text;
}

export function legacyWireNumber(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError('legacy checkpoint sequence must be a positive safe integer');
    }
    return value;
  }
  const exact = auditSequence(value);
  if (
    exact.length > JS_SAFE_INTEGER_MAX_DECIMAL.length ||
    (exact.length === JS_SAFE_INTEGER_MAX_DECIMAL.length && exact > JS_SAFE_INTEGER_MAX_DECIMAL)
  ) {
    throw new RangeError('legacy checkpoint sequence exceeds JavaScript safe integer domain');
  }
  return Number(exact);
}

export function isCheckpointFormat(value: string): value is CheckpointFormat {
  return (
    value === 'kf.audit-checkpoint.v1' ||
    value === 'kf.audit-checkpoint.v2' ||
    value === 'kf.audit-checkpoint.v3'
  );
}
