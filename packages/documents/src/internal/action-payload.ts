import { ActionRejected } from '@kf/actions';
import { requireString } from '@kf/record-atoms';

export function refuseDocument(
  rule: string,
  message: string,
  detail: Readonly<Record<string, unknown>> = {},
): never {
  throw new ActionRejected('precondition_failed', `${rule}: ${message}`, { rule, ...detail });
}

export function requireRecord(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
): Readonly<Record<string, unknown>> {
  const value = payload?.[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${key} is required and must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

export function requireArray(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
): readonly unknown[] {
  const value = payload?.[key];
  if (!Array.isArray(value)) throw new Error(`${key} is required and must be an array`);
  return value;
}

export function requireDigest(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string {
  const value = requireString(payload, key);
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${key} must be a lowercase hexadecimal SHA-256 digest`);
  }
  return value;
}

export function requireCommit(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string {
  const value = requireString(payload, key);
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${key} must be a full lowercase hexadecimal Git commit`);
  }
  return value;
}
