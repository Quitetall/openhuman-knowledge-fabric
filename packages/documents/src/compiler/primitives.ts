import { canonicalize, type JsonValue } from '@kf/canonicalization';
import { DocumentCompilerError } from './errors.js';
import type { DocumentClassification } from './core-types.js';

export const SHA256 = /^[0-9a-f]{64}$/;
export const GIT_COMMIT = /^[0-9a-f]{40}$/;
export const VERIFIED_COMPILATION_RUN = Symbol('kf.verified-compilation-run');
export const CLASSIFICATION_RANK: Readonly<Record<DocumentClassification, number>> = Object.freeze({
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
});
export function fail(code: string, message: string): never {
  throw new DocumentCompilerError(code, message);
}

export function markVerifiedCompilationRun<T extends object>(run: T): T {
  Object.defineProperty(run, VERIFIED_COMPILATION_RUN, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(run);
}

export function nonEmpty(value: string, field: string): string {
  if (value.trim() === '') fail('invalid_field', `${field} must not be empty`);
  return value;
}

export function classification(value: string, field: string): DocumentClassification {
  if (Object.hasOwn(CLASSIFICATION_RANK, value)) return value as DocumentClassification;
  return fail('invalid_classification', `${field} is not a supported document classification`);
}

export function maximumClassification(
  values: readonly DocumentClassification[],
): DocumentClassification {
  if (values.length === 0) {
    fail('missing_classification', 'a compilation basis has no authoritative classification');
  }
  return values.reduce((maximum, candidate) =>
    CLASSIFICATION_RANK[candidate] > CLASSIFICATION_RANK[maximum] ? candidate : maximum,
  );
}

export function sha256(value: string, field: string): string {
  if (!SHA256.test(value)) {
    fail('invalid_digest', `${field} must be a lowercase hexadecimal SHA-256 digest`);
  }
  return value;
}

export function exactKeys(value: object, allowed: readonly string[], field: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    fail('unexpected_field', `${field} has unexpected fields: ${unexpected.join(', ')}`);
  }
}

export function exactRequiredKeys(value: object, keys: readonly string[], field: string): void {
  exactKeys(value, keys, field);
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) {
    fail('unexpected_field', `${field} is missing fields: ${missing.join(', ')}`);
  }
}

export function canonicalJsonValue(value: unknown, field: string): JsonValue {
  try {
    return JSON.parse(canonicalize(value)) as JsonValue;
  } catch (error: unknown) {
    fail(
      'malformed_response',
      `${field} is not valid canonical JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function utcInstant(value: string, field: string): string {
  const matched = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{3})?Z$/.exec(value);
  const epochMilliseconds = matched === null ? Number.NaN : Date.parse(value);
  if (!Number.isFinite(epochMilliseconds)) {
    fail('invalid_timestamp', `${field} must be an RFC 3339 UTC instant`);
  }
  const normalized = new Date(epochMilliseconds).toISOString();
  const expected = matched?.[2] === undefined ? normalized.replace(/\.000Z$/, 'Z') : normalized;
  if (expected !== value) {
    fail('invalid_timestamp', `${field} must be an RFC 3339 UTC instant`);
  }
  return value;
}
