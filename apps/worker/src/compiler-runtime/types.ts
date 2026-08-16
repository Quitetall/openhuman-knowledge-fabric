import type { ObjectStore } from '@kf/artifacts';
import type {
  CompilationBasis,
  CompilationRun,
  DocumentClassification,
  DocumentCompilerAdapter,
  LiminalCompilerIdentity,
} from '@kf/documents';

export type CompilerInputKind = 'fragment' | 'resource' | 'compiled_view';

export interface CompilerInputReference {
  readonly kind: CompilerInputKind;
  readonly id: string;
  readonly storageUri: string;
  readonly storageVersion: string;
  readonly contentDigest: string;
  readonly sizeBytes: number;
}

export interface RecordedCompiledView {
  readonly target: string;
  readonly mediaType: string;
  readonly contentDigest: string;
  readonly sizeBytes: number;
  readonly storageUri: string;
  readonly storageVersion: string;
}

export interface ExistingCompilation {
  readonly runId: string;
  readonly runDigest: string;
  readonly status: 'succeeded' | 'failed';
  readonly views: readonly RecordedCompiledView[];
}

export interface CompilerRuntimeRequest {
  readonly actionId: string;
  readonly actorId: string;
  readonly actingRoleId: string;
  readonly requestId: string | null;
  readonly organizationId: string;
  readonly maxClassification: DocumentClassification;
  readonly basisId: string;
  readonly compilerRegistrationId: string;
  readonly draftOnly: boolean;
  readonly basis: CompilationBasis;
  readonly inputs: readonly CompilerInputReference[];
  readonly existing: ExistingCompilation | null;
}

export interface MaterializedCompiledView extends RecordedCompiledView {
  readonly id: string;
  readonly artifactId: string;
  readonly artifactVersionId: string;
}

export interface CompilerRuntimeRepository {
  load(actionId: string): Promise<CompilerRuntimeRequest>;
  persist(
    request: CompilerRuntimeRequest,
    run: CompilationRun,
    views: readonly MaterializedCompiledView[],
  ): Promise<string>;
}

export interface CompilerRuntimeResult {
  readonly runId: string;
  readonly status: 'succeeded' | 'failed';
  readonly replayed: boolean;
}

export interface RuntimeOptions {
  readonly repository: CompilerRuntimeRepository;
  readonly store: ObjectStore;
  readonly adapterFor: (identity: LiminalCompilerIdentity) => DocumentCompilerAdapter;
  readonly idFactory?: () => string;
  /** Aggregate decoded source bytes, enforced against declared and actual reads. */
  readonly maxSourceBytes?: number;
  /** Exact canonical JSON stdin envelope, including its trailing newline. */
  readonly maxCanonicalInputBytes?: number;
}

export interface CompilationRuntime {
  process(actionId: string): Promise<CompilerRuntimeResult>;
}
