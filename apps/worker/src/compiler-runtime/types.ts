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
  /**
   * Record the run. With views, the implementation locks each view's key
   * (`content.lock_stored_key`) in the recording transaction and then calls `confirmStored`,
   * which re-reads the bytes at their recorded versions: the storage sweep takes the same lock to
   * collect an unreferenced compiled view, so a view it collected while this run compiled is
   * found missing here and not recorded (SAS §100.64).
   */
  persist(
    request: CompilerRuntimeRequest,
    run: CompilationRun,
    views: readonly MaterializedCompiledView[],
    confirmStored?: () => Promise<void>,
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
