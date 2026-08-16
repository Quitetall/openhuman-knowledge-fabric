import type { AggregateKind, AggregateReference } from './contracts.js';
import { MlRegistryRejected } from './contracts.js';
import {
  ML_AGGREGATE_KINDS,
  ML_GOVERNED_ALIAS_TOKEN,
  ML_OPAQUE_REFERENCE_TOKEN,
  ML_SHA256,
  isAggregateKind,
  isCanonicalTimestamp,
} from '../public-contracts.js';

const AGGREGATE_KEYS = [
  'organizationId',
  'kind',
  'authorityId',
  'revisionId',
  'sha256',
  'classificationId',
  'policyId',
] as const;

export const AGGREGATE_KINDS: readonly AggregateKind[] = ML_AGGREGATE_KINDS;
export const OPAQUE_ID = ML_OPAQUE_REFERENCE_TOKEN;
export const GOVERNANCE_ID = ML_GOVERNED_ALIAS_TOKEN;
export const SHA256 = ML_SHA256;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function reject(message: string): never {
  throw new MlRegistryRejected(message);
}

export function assertExactKeys(value: object, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    reject(`${field} must contain exactly ${wanted.join(', ')}`);
  }
}

export function checkedId(value: unknown, field: string, pattern = OPAQUE_ID): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    reject(`${field} is not a safe opaque identifier`);
  }
  return value;
}

export function checkedOrganizationId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value) || value !== value.toLowerCase()) {
    reject(`${field} must be a canonical lowercase UUID`);
  }
  return value;
}

export function checkedAggregate(
  value: unknown,
  field: string,
  expectedKinds: readonly AggregateKind[] = AGGREGATE_KINDS,
): AggregateReference {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    reject(`${field} must be an aggregate reference`);
  }
  assertExactKeys(value, AGGREGATE_KEYS, field);
  const ref = value as Record<(typeof AGGREGATE_KEYS)[number], unknown>;
  const sha256 = ref.sha256;
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) {
    reject(`${field}.sha256 must be a lowercase SHA-256 digest`);
  }
  if (
    typeof ref.kind !== 'string' ||
    !isAggregateKind(ref.kind) ||
    !expectedKinds.includes(ref.kind as AggregateKind)
  ) {
    reject(`${field}.kind must be ${expectedKinds.join(' or ')}`);
  }
  return Object.freeze({
    organizationId: checkedOrganizationId(ref.organizationId, `${field}.organizationId`),
    kind: ref.kind as AggregateKind,
    authorityId: checkedId(ref.authorityId, `${field}.authorityId`),
    revisionId: checkedId(ref.revisionId, `${field}.revisionId`),
    sha256,
    classificationId: checkedId(ref.classificationId, `${field}.classificationId`, GOVERNANCE_ID),
    policyId: checkedId(ref.policyId, `${field}.policyId`, GOVERNANCE_ID),
  });
}

export function checkedAggregates(
  values: readonly AggregateReference[],
  field: string,
  requireOne: boolean,
  expectedKinds: readonly AggregateKind[] = AGGREGATE_KINDS,
): readonly AggregateReference[] {
  if (!Array.isArray(values) || (requireOne && values.length === 0)) {
    reject(`${field} must contain ${requireOne ? 'at least one' : 'zero or more'} aggregate`);
  }
  return Object.freeze(
    values.map((value, index) => checkedAggregate(value, `${field}[${index}]`, expectedKinds)),
  );
}

export function requireOneOrganization(
  organizationId: string,
  references: readonly AggregateReference[],
  field: string,
): void {
  if (references.some((reference) => reference.organizationId !== organizationId)) {
    reject(`${field} must belong to organization ${organizationId}`);
  }
}

export function checkedTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string') reject(`${field} must be a canonical RFC 3339 timestamp`);
  if (!isCanonicalTimestamp(value)) {
    reject(`${field} must be a canonical four-digit-year RFC 3339 millisecond timestamp`);
  }
  return value;
}

export function checkedPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    reject(`${field} must be a positive safe integer`);
  }
  return value;
}

export function checkedSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    reject(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function checkedEd25519Signature(value: unknown, field: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(value)) {
    reject(`${field} must be canonical base64 for a 64-byte Ed25519 signature`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== value) {
    reject(`${field} must be canonical base64 for a 64-byte Ed25519 signature`);
  }
  return bytes;
}
