import { canonicalize, digest, digestBytes } from '@kf/canonicalization';
import type { CompilationRun, CompilationRunPreimage } from './types.js';
import { classification, exactRequiredKeys, fail, sha256 } from './primitives.js';

export type CompilationRunClaim = Omit<CompilationRun, 'runDigest'>;

const COMPILATION_RUN_PREIMAGE_KEYS = [
  'format',
  'id',
  'basisDigest',
  'compilerDigest',
  'dependencyDigest',
  'status',
  'draftOnly',
  'effectiveClassification',
  'semanticGraph',
  'semanticDigest',
  'hirProvenance',
  'cirProvenance',
  'unresolvedReferences',
  'omittedSubgraphs',
  'projectionCapabilities',
  'failureCode',
  'failureMessage',
  'diagnostics',
  'conversionLoss',
  'views',
] as const;

export function compilationRunPreimage(run: CompilationRunClaim): CompilationRunPreimage {
  return {
    format: 'kf-document-compilation-run-v2',
    id: run.id,
    basisDigest: run.basisDigest,
    compilerDigest: run.compilerDigest,
    dependencyDigest: run.dependencyDigest,
    status: run.status,
    draftOnly: run.draftOnly,
    effectiveClassification: run.effectiveClassification,
    semanticGraph: run.semanticGraph,
    semanticDigest: run.semanticDigest,
    hirProvenance: run.hirProvenance,
    cirProvenance: run.cirProvenance,
    unresolvedReferences: run.unresolvedReferences,
    omittedSubgraphs: run.omittedSubgraphs,
    projectionCapabilities: run.projectionCapabilities,
    failureCode: run.failureCode,
    failureMessage: run.failureMessage,
    diagnostics: run.diagnostics,
    conversionLoss: run.conversionLoss,
    views: run.views.map((view) => ({
      target: view.target,
      mediaType: view.mediaType,
      contentDigest: view.contentDigest,
      effectiveClassification: view.effectiveClassification,
    })),
  };
}

/** Exact JCS bytes whose SHA-256 is CompilationRun.runDigest. */
export function canonicalCompilationRunPreimage(run: CompilationRun): string {
  return canonicalize(compilationRunPreimage(run));
}

/** Exact semantic-graph JCS bytes whose SHA-256 is semanticDigest. */
export function canonicalCompilationSemanticPreimage(run: CompilationRun): string | null {
  return run.semanticGraph === null ? null : canonicalize(run.semanticGraph);
}

function preimageRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('malformed_run_preimage', 'compilation run preimage must be an object');
  }
  return value as Record<string, unknown>;
}

function preimageArray(row: Record<string, unknown>, key: string): readonly unknown[] {
  const value = row[key];
  if (!Array.isArray(value)) fail('malformed_run_preimage', `${key} must be an array`);
  return value;
}

/**
 * Verify an untrusted persisted receipt independently from compiler-process memory.
 * Canonical bytes, outer run digest, and semantic graph digest must all agree.
 */
export function verifyCompilationRunPreimage(
  canonicalPreimage: string,
  runDigest: string,
): CompilationRunPreimage {
  sha256(runDigest, 'runDigest');
  let decoded: unknown;
  try {
    decoded = JSON.parse(canonicalPreimage);
  } catch (error: unknown) {
    fail(
      'malformed_run_preimage',
      `compilation run preimage is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const row = preimageRecord(decoded);
  exactRequiredKeys(row, COMPILATION_RUN_PREIMAGE_KEYS, 'compilation run preimage');
  if (canonicalize(row) !== canonicalPreimage) {
    fail('noncanonical_run_preimage', 'compilation run preimage is not RFC 8785 canonical JSON');
  }
  if (digestBytes(Buffer.from(canonicalPreimage, 'utf8')) !== runDigest) {
    fail('run_digest_mismatch', 'compilation run digest does not match its canonical preimage');
  }
  if (row['format'] !== 'kf-document-compilation-run-v2') {
    fail('malformed_run_preimage', 'compilation run preimage format is unsupported');
  }
  for (const key of ['id'] as const) {
    if (typeof row[key] !== 'string' || row[key].trim() === '') {
      fail('malformed_run_preimage', `${key} must be a non-empty string`);
    }
  }
  for (const key of ['basisDigest', 'compilerDigest', 'dependencyDigest'] as const) {
    if (typeof row[key] !== 'string') fail('malformed_run_preimage', `${key} must be a string`);
    sha256(row[key], key);
  }
  if (row['status'] !== 'succeeded' && row['status'] !== 'failed') {
    fail('malformed_run_preimage', 'status must be succeeded or failed');
  }
  if (typeof row['draftOnly'] !== 'boolean') {
    fail('malformed_run_preimage', 'draftOnly must be boolean');
  }
  if (typeof row['effectiveClassification'] !== 'string') {
    fail('malformed_run_preimage', 'effectiveClassification must be a string');
  }
  classification(row['effectiveClassification'], 'effectiveClassification');
  for (const key of [
    'hirProvenance',
    'cirProvenance',
    'unresolvedReferences',
    'omittedSubgraphs',
    'projectionCapabilities',
    'diagnostics',
    'conversionLoss',
    'views',
  ] as const) {
    preimageArray(row, key);
  }
  if (row['status'] === 'succeeded') {
    if (row['semanticGraph'] === null || typeof row['semanticDigest'] !== 'string') {
      fail('malformed_run_preimage', 'succeeded run requires semantic graph and digest');
    }
    sha256(row['semanticDigest'], 'semanticDigest');
    if (digest(row['semanticGraph']) !== row['semanticDigest']) {
      fail('semantic_digest_mismatch', 'semantic graph does not match persisted semantic digest');
    }
    if (row['failureCode'] !== null || row['failureMessage'] !== null) {
      fail('malformed_run_preimage', 'succeeded run cannot contain failure fields');
    }
  } else {
    if (row['semanticGraph'] !== null || row['semanticDigest'] !== null) {
      fail('malformed_run_preimage', 'failed run cannot contain semantic output');
    }
    if (
      typeof row['failureCode'] !== 'string' ||
      row['failureCode'].trim() === '' ||
      typeof row['failureMessage'] !== 'string' ||
      row['failureMessage'].trim() === ''
    ) {
      fail('malformed_run_preimage', 'failed run requires failure code and message');
    }
  }
  for (const [index, rawView] of preimageArray(row, 'views').entries()) {
    const view = preimageRecord(rawView);
    exactRequiredKeys(
      view,
      ['target', 'mediaType', 'contentDigest', 'effectiveClassification'],
      `compilation run preimage view ${String(index)}`,
    );
    if (
      typeof view['target'] !== 'string' ||
      view['target'].trim() === '' ||
      typeof view['mediaType'] !== 'string' ||
      view['mediaType'].trim() === '' ||
      typeof view['contentDigest'] !== 'string' ||
      typeof view['effectiveClassification'] !== 'string'
    ) {
      fail('malformed_run_preimage', `compilation run preimage view ${String(index)} is malformed`);
    }
    sha256(view['contentDigest'], `views[${String(index)}].contentDigest`);
    classification(
      view['effectiveClassification'],
      `views[${String(index)}].effectiveClassification`,
    );
  }
  return Object.freeze(row) as unknown as CompilationRunPreimage;
}
