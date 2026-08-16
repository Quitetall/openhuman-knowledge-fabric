import type { JsonValue } from '@kf/canonicalization';
import type {
  CompilationBasis,
  CompilationProtocol,
  CompilerIdentity,
  DocumentClassification,
} from './core-types.js';

export type CompilerInput =
  | {
      readonly kind: 'fragment';
      readonly id: string;
      readonly bytesBase64: string;
      readonly contentDigest: string;
    }
  | {
      readonly kind: 'resource';
      readonly id: string;
      readonly bytesBase64: string;
      readonly contentDigest: string;
    }
  | {
      readonly kind: 'compiled_view';
      readonly id: string;
      readonly bytesBase64: string;
      readonly contentDigest: string;
    };

export interface CompilationRequest {
  readonly protocol: CompilationProtocol;
  readonly basis: CompilationBasis;
  readonly basisDigest: string;
  readonly dependencyDigest: string;
  readonly inputs: readonly CompilerInput[];
}

export interface CompilationDiagnostic {
  readonly severity: 'info' | 'warning' | 'error';
  readonly code: string;
  readonly message: string;
}

export interface ConversionLoss {
  readonly code: string;
  readonly path: string | null;
  readonly message: string;
}

export type CompilerProvenanceSourceKind =
  'fragment' | 'composition' | 'resource' | 'binding' | 'compiled_view';

/** One HIR/CIR node's exact immutable source claim. */
export interface CompilerIrProvenance {
  readonly nodeId: string;
  readonly sourceKind: CompilerProvenanceSourceKind;
  readonly sourceId: string;
  readonly sourcePath: string | null;
  readonly sourceDigest: string;
}

export interface CompilerUnresolvedReference {
  readonly sourceNodeId: string | null;
  readonly reference: string;
  readonly reasonCode: string;
  readonly message: string;
}

export interface CompilerOmittedSubgraph {
  readonly rootNodeId: string;
  readonly reasonCode: string;
  readonly message: string;
}

export interface CompilerProjectionCapability {
  readonly target: string;
  readonly capabilities: readonly string[];
}

export interface CompiledView {
  readonly target: string;
  readonly mediaType: string;
  readonly bytesBase64: string;
  readonly contentDigest: string;
  /** Inherited from the verified basis, never supplied by the compiler adapter. */
  readonly effectiveClassification: DocumentClassification;
}

export type CompilerViewOutput = Omit<CompiledView, 'effectiveClassification'>;

export interface CompilerResponse {
  readonly protocol: CompilationProtocol;
  readonly basisDigest: string;
  readonly dependencyDigest: string;
  readonly semanticGraph: JsonValue;
  readonly semanticDigest: string;
  readonly hirProvenance: readonly CompilerIrProvenance[];
  readonly cirProvenance: readonly CompilerIrProvenance[];
  readonly unresolvedReferences: readonly CompilerUnresolvedReference[];
  readonly omittedSubgraphs: readonly CompilerOmittedSubgraph[];
  readonly projectionCapabilities: readonly CompilerProjectionCapability[];
  readonly diagnostics: readonly CompilationDiagnostic[];
  readonly conversionLoss: readonly ConversionLoss[];
  readonly views: readonly CompilerViewOutput[];
}

export interface DocumentCompilerAdapter {
  readonly identity: CompilerIdentity;
  compile(request: CompilationRequest): Promise<CompilerResponse>;
}

export interface CompilationRun {
  readonly id: string;
  readonly basisDigest: string;
  readonly compilerDigest: string;
  readonly dependencyDigest: string;
  readonly status: 'succeeded' | 'failed';
  readonly draftOnly: boolean;
  readonly effectiveClassification: DocumentClassification;
  /** Exact compiler semantic output retained so semanticDigest remains independently verifiable. */
  readonly semanticGraph: JsonValue | null;
  readonly semanticDigest: string | null;
  readonly hirProvenance: readonly CompilerIrProvenance[];
  readonly cirProvenance: readonly CompilerIrProvenance[];
  readonly unresolvedReferences: readonly CompilerUnresolvedReference[];
  readonly omittedSubgraphs: readonly CompilerOmittedSubgraph[];
  readonly projectionCapabilities: readonly CompilerProjectionCapability[];
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly diagnostics: readonly CompilationDiagnostic[];
  readonly conversionLoss: readonly ConversionLoss[];
  readonly views: readonly CompiledView[];
  readonly runDigest: string;
}

export interface CompilationRunPreimageView {
  readonly target: string;
  readonly mediaType: string;
  readonly contentDigest: string;
  readonly effectiveClassification: DocumentClassification;
}

/** Complete canonical receipt claim committed by CompilationRun.runDigest. */
export interface CompilationRunPreimage {
  readonly format: 'kf-document-compilation-run-v2';
  readonly id: string;
  readonly basisDigest: string;
  readonly compilerDigest: string;
  readonly dependencyDigest: string;
  readonly status: 'succeeded' | 'failed';
  readonly draftOnly: boolean;
  readonly effectiveClassification: DocumentClassification;
  readonly semanticGraph: JsonValue | null;
  readonly semanticDigest: string | null;
  readonly hirProvenance: readonly CompilerIrProvenance[];
  readonly cirProvenance: readonly CompilerIrProvenance[];
  readonly unresolvedReferences: readonly CompilerUnresolvedReference[];
  readonly omittedSubgraphs: readonly CompilerOmittedSubgraph[];
  readonly projectionCapabilities: readonly CompilerProjectionCapability[];
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly diagnostics: readonly CompilationDiagnostic[];
  readonly conversionLoss: readonly ConversionLoss[];
  readonly views: readonly CompilationRunPreimageView[];
}
