import type { DocumentProposalClassification } from './contracts.js';

const SHA256 = /^[0-9a-f]{64}$/;
const CLASSIFICATIONS = new Set<DocumentProposalClassification>([
  'public',
  'internal',
  'confidential',
  'restricted',
]);
const CLASSIFICATION_RANK: Readonly<Record<DocumentProposalClassification, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

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

export function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must not be empty`);
  }
  return value;
}

export function sha256(value: unknown, field: string): string {
  const candidate = nonEmpty(value, field);
  if (!SHA256.test(candidate)) {
    throw new Error(`${field} must be a lowercase hexadecimal SHA-256 digest`);
  }
  return candidate;
}

export function classification(value: unknown): DocumentProposalClassification {
  if (typeof value !== 'string' || !CLASSIFICATIONS.has(value as DocumentProposalClassification)) {
    throw new Error('classification is not supported');
  }
  return value as DocumentProposalClassification;
}

export function atOrBelow(
  value: DocumentProposalClassification,
  ceiling: DocumentProposalClassification,
): boolean {
  return CLASSIFICATION_RANK[value] <= CLASSIFICATION_RANK[ceiling];
}

export function positiveOrdinal(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value as number;
}

export function nonnegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a nonnegative safe integer`);
  }
  return value as number;
}
