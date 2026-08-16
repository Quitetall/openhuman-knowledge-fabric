import { compareCanonicalText, digest } from '@kf/canonicalization';
import { DocumentCompilerError } from './errors.js';
import type {
  CompilationBasis,
  CompilationDiagnostic,
  CompilationRun,
  CompiledView,
  CompilerInput,
  CompilerIdentity,
  CompilerIrProvenance,
  CompilerOmittedSubgraph,
  CompilerProjectionCapability,
  CompilerUnresolvedReference,
  ConversionLoss,
  DocumentCompilerAdapter,
} from './types.js';
import { createCompilationBasis, expectedCompilerInputs } from './basis.js';
import { compilerIdentity } from './identity.js';
import { compilationRunPreimage } from './receipts.js';
import {
  expectedProvenanceSources,
  verifiedOmittedSubgraph,
  verifiedProjectionCapabilities,
  verifiedProvenanceSet,
  verifiedUnresolvedReference,
} from './response-provenance.js';
import { verifiedCompilerInputs } from './response-inputs.js';
import { verifiedConversionLoss, verifiedDiagnostic, verifiedViews } from './response-output.js';
import {
  canonicalJsonValue,
  exactKeys,
  fail,
  markVerifiedCompilationRun,
  nonEmpty,
  sha256,
} from './primitives.js';

function isDraftOnly(identity: CompilerIdentity): boolean {
  return (
    identity.kind !== 'liminal' ||
    identity.qualification.state !== 'qualified' ||
    !identity.qualification.ratified ||
    identity.qualification.receiptDigest === null
  );
}

function compilationDependencyDigest(basis: CompilationBasis): string {
  return digest({
    basisDigest: basis.basisDigest,
    inputs: [...expectedCompilerInputs(basis)]
      .map(([key, contentDigest]) => ({ key, contentDigest }))
      .sort((left, right) => compareCanonicalText(left.key, right.key)),
  });
}

function failedRun(
  id: string,
  basis: CompilationBasis,
  dependencyDigest: string,
  error: unknown,
): CompilationRun {
  const diagnostic: CompilationDiagnostic = Object.freeze({
    severity: 'error',
    code: error instanceof DocumentCompilerError ? error.code : 'compiler_failed',
    message: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
  });
  const failureCode = diagnostic.code;
  const failureMessage = diagnostic.message;
  const claim = {
    id,
    basisDigest: basis.basisDigest,
    compilerDigest: digest(basis.compiler),
    dependencyDigest,
    status: 'failed' as const,
    draftOnly: isDraftOnly(basis.compiler),
    effectiveClassification: basis.effectiveClassification,
    semanticGraph: null,
    semanticDigest: null,
    hirProvenance: Object.freeze([] as CompilerIrProvenance[]),
    cirProvenance: Object.freeze([] as CompilerIrProvenance[]),
    unresolvedReferences: Object.freeze([] as CompilerUnresolvedReference[]),
    omittedSubgraphs: Object.freeze([] as CompilerOmittedSubgraph[]),
    projectionCapabilities: Object.freeze([] as CompilerProjectionCapability[]),
    failureCode,
    failureMessage,
    diagnostics: Object.freeze([diagnostic]),
    conversionLoss: Object.freeze([] as ConversionLoss[]),
    views: Object.freeze([] as CompiledView[]),
  };
  return markVerifiedCompilationRun({ ...claim, runDigest: digest(compilationRunPreimage(claim)) });
}

/** Record a bounded pre-invocation failure without materializing or base64-expanding inputs. */
export function createFailedCompilationRun(options: {
  readonly id: string;
  readonly basis: CompilationBasis;
  readonly code: string;
  readonly message: string;
}): CompilationRun {
  const id = nonEmpty(options.id, 'run.id');
  const basis = createCompilationBasis(options.basis);
  if (basis.basisDigest !== options.basis.basisDigest) {
    fail('basis_digest_mismatch', 'basis digest does not match its canonical contents');
  }
  return failedRun(
    id,
    basis,
    compilationDependencyDigest(basis),
    new DocumentCompilerError(
      nonEmpty(options.code, 'failure.code'),
      nonEmpty(options.message, 'failure.message'),
    ),
  );
}

/** Invoke one pure adapter and fail closed before exposing any derived view. */
export async function runCompilation(options: {
  readonly id: string;
  readonly basis: CompilationBasis;
  readonly inputs: readonly CompilerInput[];
  readonly adapter: DocumentCompilerAdapter;
}): Promise<CompilationRun> {
  const id = nonEmpty(options.id, 'run.id');
  const basis = createCompilationBasis(options.basis);
  if (basis.basisDigest !== options.basis.basisDigest) {
    fail('basis_digest_mismatch', 'basis digest does not match its canonical contents');
  }
  const compiler = compilerIdentity(options.adapter.identity);
  const compilerDigest = digest(compiler);
  const dependencyDigest = compilationDependencyDigest(basis);

  try {
    if (compilerDigest !== digest(basis.compiler)) {
      fail(
        'compiler_identity_mismatch',
        'adapter identity does not match the compiler pinned by the basis',
      );
    }
    const inputs = verifiedCompilerInputs(basis, options.inputs);
    const response = await options.adapter.compile(
      Object.freeze({
        protocol: basis.protocol,
        basis,
        basisDigest: basis.basisDigest,
        dependencyDigest,
        inputs,
      }),
    );
    exactKeys(
      response,
      [
        'protocol',
        'basisDigest',
        'dependencyDigest',
        'semanticGraph',
        'semanticDigest',
        'hirProvenance',
        'cirProvenance',
        'unresolvedReferences',
        'omittedSubgraphs',
        'projectionCapabilities',
        'diagnostics',
        'conversionLoss',
        'views',
      ],
      'compiler response',
    );
    if (response.protocol !== basis.protocol) {
      fail('protocol_mismatch', 'compiler response protocol does not match the request');
    }
    if (response.basisDigest !== basis.basisDigest) {
      fail('basis_digest_mismatch', 'compiler response cites a different basis');
    }
    if (response.dependencyDigest !== dependencyDigest) {
      fail('dependency_digest_mismatch', 'compiler response cites different dependencies');
    }
    const semanticGraph = canonicalJsonValue(response.semanticGraph, 'response.semanticGraph');
    sha256(response.semanticDigest, 'response.semanticDigest');
    if (digest(semanticGraph) !== response.semanticDigest) {
      fail('semantic_digest_mismatch', 'semantic graph does not match its digest');
    }
    const provenanceSources = expectedProvenanceSources(basis);
    const requiredProvenanceSources = expectedCompilerInputs(basis);
    const hirProvenance = verifiedProvenanceSet(
      response.hirProvenance,
      'hir',
      provenanceSources,
      requiredProvenanceSources,
    );
    const cirProvenance = verifiedProvenanceSet(
      response.cirProvenance,
      'cir',
      provenanceSources,
      requiredProvenanceSources,
    );
    const unresolvedReferences = Object.freeze(
      response.unresolvedReferences.map(verifiedUnresolvedReference),
    );
    const omittedSubgraphs = Object.freeze(response.omittedSubgraphs.map(verifiedOmittedSubgraph));
    const projectionCapabilities = verifiedProjectionCapabilities(
      response.projectionCapabilities,
      basis,
    );
    const diagnostics = Object.freeze(response.diagnostics.map(verifiedDiagnostic));
    const conversionLoss = Object.freeze(response.conversionLoss.map(verifiedConversionLoss));
    if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      fail('compiler_diagnostic_error', 'compiler returned one or more error diagnostics');
    }
    const views = verifiedViews(response, basis);
    const claim = {
      id,
      basisDigest: basis.basisDigest,
      compilerDigest,
      dependencyDigest,
      status: 'succeeded' as const,
      draftOnly: isDraftOnly(basis.compiler),
      effectiveClassification: basis.effectiveClassification,
      semanticGraph,
      semanticDigest: response.semanticDigest,
      hirProvenance,
      cirProvenance,
      unresolvedReferences,
      omittedSubgraphs,
      projectionCapabilities,
      failureCode: null,
      failureMessage: null,
      diagnostics,
      conversionLoss,
      views,
    };
    return markVerifiedCompilationRun({
      ...claim,
      runDigest: digest(compilationRunPreimage(claim)),
    });
  } catch (error: unknown) {
    return failedRun(id, basis, dependencyDigest, error);
  }
}
