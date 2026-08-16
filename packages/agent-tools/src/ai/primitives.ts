import type { AiClassification, AiContextKind } from './types.js';

export const RANK: Readonly<Record<AiClassification, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};
export const CONTEXT_KINDS = new Set<AiContextKind>(['document', 'metric_summary', 'record']);
export const SHA256 = /^[0-9a-f]{64}$/;
export const MAX_INSTRUCTION_CHARACTERS = 16_384;
export const MAX_CONTEXT_ITEMS = 256;
export const MAX_CONTEXT_CHARACTERS = 2 * 1024 * 1024;
export const MAX_SUMMARY_CHARACTERS = 8_192;
export const MAX_OPERATION_BYTES = 64 * 1024;
export const VERIFIED_AI_PROPOSAL = Symbol('kf.verified-ai-proposal');

export function record(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

export function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  field: string,
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`${field} has unexpected fields: ${unexpected.sort().join(', ')}`);
  }
}

export function requireNonempty(value: unknown, name: string, maximum?: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must not be empty`);
  }
  if (maximum !== undefined && value.length > maximum) {
    throw new Error(`${name} exceeds ${String(maximum)} characters`);
  }
  return value;
}

export function requireClassification(value: unknown, name: string): AiClassification {
  if (typeof value !== 'string' || !Object.hasOwn(RANK, value)) {
    throw new Error(`${name} is not a supported classification`);
  }
  return value as AiClassification;
}

export function requireSha256(value: unknown, name: string): string {
  const candidate = requireNonempty(value, name);
  if (!SHA256.test(candidate)) {
    throw new Error(`${name} must be a lowercase hexadecimal SHA-256 digest`);
  }
  return candidate;
}

export function requirePositiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value as number;
}

export function atOrBelow(value: AiClassification, ceiling: AiClassification): boolean {
  return RANK[value] <= RANK[ceiling];
}
