import {
  createCompilationBasis,
  type CompilationBasis,
  type CompilationBasisInput,
  type DocumentClassification,
} from '@kf/documents';
import { canonicalize, type JsonValue } from '@kf/canonicalization';
import type {
  CompilerInputReference,
  CompilerRuntimeRequest,
  ExistingCompilation,
  RecordedCompiledView,
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const BASIS_KEYS = [
  'protocol',
  'rootCompositionRevisionId',
  'fragmentRevisions',
  'compositionRevisions',
  'bindings',
  'targetProfiles',
  'ontologyDigest',
  'policyDigest',
  'compiler',
  'effectiveClassification',
  'basisDigest',
] as const;

export function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`${field} must be a UUID`);
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireStorageVersion(value: unknown, field: string): string {
  const version = requireText(value, field);
  if (version === 'null') throw new Error(`${field} must name an immutable object version`);
  return version;
}

function requireDigest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  const unexpected = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `${field} has invalid keys (missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'})`,
    );
  }
}

function requireSize(value: unknown, field: string): number {
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return number;
}

function classification(value: unknown): DocumentClassification {
  if (
    value === 'public' ||
    value === 'internal' ||
    value === 'confidential' ||
    value === 'restricted'
  ) {
    return value;
  }
  throw new Error('maxClassification is invalid');
}

function inputReference(value: unknown, index: number): CompilerInputReference {
  const row = requireObject(value, `inputs[${index}]`);
  requireExactKeys(
    row,
    ['kind', 'id', 'storageUri', 'storageVersion', 'contentDigest', 'sizeBytes'],
    `inputs[${index}]`,
  );
  if (row['kind'] !== 'fragment' && row['kind'] !== 'resource' && row['kind'] !== 'compiled_view') {
    throw new Error(`inputs[${index}].kind is invalid`);
  }
  return Object.freeze({
    kind: row['kind'],
    id: requireText(row['id'], `inputs[${index}].id`),
    storageUri: requireText(row['storageUri'], `inputs[${index}].storageUri`),
    storageVersion: requireStorageVersion(row['storageVersion'], `inputs[${index}].storageVersion`),
    contentDigest: requireDigest(row['contentDigest'], `inputs[${index}].contentDigest`),
    sizeBytes: requireSize(row['sizeBytes'], `inputs[${index}].sizeBytes`),
  });
}

function recordedView(value: unknown, index: number): RecordedCompiledView {
  const row = requireObject(value, `existing.views[${index}]`);
  requireExactKeys(
    row,
    ['target', 'mediaType', 'contentDigest', 'sizeBytes', 'storageUri', 'storageVersion'],
    `existing.views[${index}]`,
  );
  return Object.freeze({
    target: requireText(row['target'], `existing.views[${index}].target`),
    mediaType: requireText(row['mediaType'], `existing.views[${index}].mediaType`),
    contentDigest: requireDigest(row['contentDigest'], `existing.views[${index}].contentDigest`),
    sizeBytes: requireSize(row['sizeBytes'], `existing.views[${index}].sizeBytes`),
    storageUri: requireText(row['storageUri'], `existing.views[${index}].storageUri`),
    storageVersion: requireStorageVersion(
      row['storageVersion'],
      `existing.views[${index}].storageVersion`,
    ),
  });
}

function existingCompilation(value: unknown): ExistingCompilation | null {
  if (value === null) return null;
  const row = requireObject(value, 'existing');
  requireExactKeys(row, ['runId', 'runDigest', 'status', 'views'], 'existing');
  if (row['status'] !== 'succeeded' && row['status'] !== 'failed') {
    throw new Error('existing.status is invalid');
  }
  const views = requireArray(row['views'], 'existing.views').map(recordedView);
  if (row['status'] === 'failed' && views.length !== 0) {
    throw new Error('failed existing compilation cannot have views');
  }
  return Object.freeze({
    runId: requireUuid(row['runId'], 'existing.runId'),
    runDigest: requireDigest(row['runDigest'], 'existing.runDigest'),
    status: row['status'],
    views: Object.freeze(views),
  });
}

function canonicalBasis(value: unknown): CompilationBasis {
  const supplied = requireObject(value, 'basis');
  requireExactKeys(supplied, BASIS_KEYS, 'basis');
  const canonical = createCompilationBasis(supplied as unknown as CompilationBasisInput);
  if (
    supplied['basisDigest'] !== canonical.basisDigest ||
    supplied['effectiveClassification'] !== canonical.effectiveClassification ||
    canonicalize(supplied as unknown as JsonValue) !==
      canonicalize(canonical as unknown as JsonValue)
  ) {
    throw new Error('basis does not exactly match its canonical contents');
  }
  return canonical;
}

/** Validate SECURITY DEFINER output before it can select a compiler or storage location. */
export function parseCompilerRuntimeRequest(value: unknown): CompilerRuntimeRequest {
  const row = requireObject(value, 'compiler runtime request');
  requireExactKeys(
    row,
    [
      'actionId',
      'actorId',
      'actingRoleId',
      'requestId',
      'organizationId',
      'maxClassification',
      'basisId',
      'compilerRegistrationId',
      'draftOnly',
      'basis',
      'inputs',
      'existing',
    ],
    'compiler runtime request',
  );
  if (row['requestId'] !== null && typeof row['requestId'] !== 'string') {
    throw new Error('requestId must be a string or null');
  }
  const basis = canonicalBasis(row['basis']);
  if (basis.compiler.kind !== 'liminal') {
    throw new Error('runtime requires a Liminal compiler identity');
  }
  const derivedDraftOnly =
    basis.compiler.qualification.state !== 'qualified' ||
    !basis.compiler.qualification.ratified ||
    basis.compiler.qualification.receiptDigest === null;
  if (typeof row['draftOnly'] !== 'boolean' || row['draftOnly'] !== derivedDraftOnly) {
    throw new Error('draftOnly must equal the registry-derived compiler qualification');
  }
  return Object.freeze({
    actionId: requireUuid(row['actionId'], 'actionId'),
    actorId: requireUuid(row['actorId'], 'actorId'),
    actingRoleId: requireUuid(row['actingRoleId'], 'actingRoleId'),
    requestId: row['requestId'],
    organizationId: requireUuid(row['organizationId'], 'organizationId'),
    maxClassification: classification(row['maxClassification']),
    basisId: requireUuid(row['basisId'], 'basisId'),
    compilerRegistrationId: requireUuid(row['compilerRegistrationId'], 'compilerRegistrationId'),
    draftOnly: row['draftOnly'],
    basis,
    inputs: Object.freeze(requireArray(row['inputs'], 'inputs').map(inputReference)),
    existing: existingCompilation(row['existing']),
  });
}
