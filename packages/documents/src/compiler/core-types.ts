import type { JsonValue } from '@kf/canonicalization';

export type DocumentClassification = 'public' | 'internal' | 'confidential' | 'restricted';
interface SourceHolderBase {
  readonly subjectId: string;
  readonly contentDigest: string;
}

export interface FabricNativeSourceHolder extends SourceHolderBase {
  readonly kind: 'fabric_native';
  readonly artifactVersionId: string;
}

export interface GitSourceHolder extends SourceHolderBase {
  readonly kind: 'git';
  readonly repository: string;
  readonly commitSha: string;
  readonly path: string;
  readonly submoduleCommitSha: string | null;
}

export interface ExternalSourceHolder extends SourceHolderBase {
  readonly kind: 'external';
  readonly authority: string;
  readonly revision: string;
}

export type SourceHolder = FabricNativeSourceHolder | GitSourceHolder | ExternalSourceHolder;

export type AuthoredFragmentState = 'draft' | 'active' | 'retired';

export interface AuthoredFragmentRevisionInput {
  readonly id: string;
  readonly fragmentId: string;
  readonly previousRevisionId: string | null;
  readonly mediaType: string;
  readonly classification: DocumentClassification;
  readonly state: AuthoredFragmentState;
  readonly holder: SourceHolder;
}

export interface AuthoredFragmentRevision extends AuthoredFragmentRevisionInput {
  readonly revisionDigest: string;
}

export type CompositionInput =
  | {
      readonly ordinal: number;
      readonly role: 'fragment';
      readonly fragmentRevisionId: string;
    }
  | {
      readonly ordinal: number;
      readonly role: 'composition';
      readonly compositionRevisionId: string;
    }
  | {
      readonly ordinal: number;
      readonly role: 'resource';
      readonly resourceVersionId: string;
      readonly contentDigest: string;
      readonly classification: DocumentClassification;
    }
  | {
      readonly ordinal: number;
      readonly role: 'binding';
      readonly bindingId: string;
    }
  | {
      readonly ordinal: number;
      readonly role: 'generated_view';
      readonly compiledViewId: string;
      readonly contentDigest: string;
      readonly classification: DocumentClassification;
    };

export interface CompositionRevisionInput {
  readonly id: string;
  readonly compositionId: string;
  readonly previousRevisionId: string | null;
  /** Classification of the composition's authoritative core.object envelope. */
  readonly classification: DocumentClassification;
  readonly inputs: readonly CompositionInput[];
}

export interface CompositionRevision extends CompositionRevisionInput {
  readonly revisionDigest: string;
}

export type BindingSource =
  | {
      readonly kind: 'object_revision';
      readonly objectId: string;
      readonly objectRevision: number;
    }
  | {
      readonly kind: 'snapshot';
      readonly objectId: string;
      readonly snapshotId: string;
    };

export type BindingValueType =
  'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

export interface TypedBindingInput {
  readonly id: string;
  readonly source: BindingSource;
  /** Classification of the exact core.object revision or snapshot source. */
  readonly sourceClassification: DocumentClassification;
  readonly selector: string;
  readonly expectedType: BindingValueType;
  readonly renderer: string;
  readonly value: JsonValue;
}

export interface TypedBinding extends TypedBindingInput {
  readonly valueDigest: string;
  readonly bindingDigest: string;
}

export type CompilationProtocol = 'kf-document-v1';

export interface CompilationTargetProfile {
  readonly target: string;
  readonly profileDigest: string;
}

export interface InMemoryCompilerIdentity {
  readonly kind: 'in_memory';
  readonly name: string;
  readonly version: string;
  readonly protocol: CompilationProtocol;
  readonly executableDigest: string;
}

export type CompilerQualificationState = 'not_run' | 'incomplete' | 'unratified' | 'qualified';

export interface CompilerQualification {
  readonly state: CompilerQualificationState;
  readonly receiptDigest: string | null;
  readonly ratified: boolean;
}

export interface LiminalCompilerIdentity {
  readonly kind: 'liminal';
  readonly name: string;
  readonly version: string;
  readonly protocol: CompilationProtocol;
  readonly commitSha: string;
  readonly cargoLockDigest: string;
  readonly executableDigest: string;
  /** Canonical digest of ordered sandbox path and exact byte-digest pairs. */
  readonly runtimeClosureDigest: string;
  readonly qualification: CompilerQualification;
}

export type CompilerIdentity = InMemoryCompilerIdentity | LiminalCompilerIdentity;

export interface CompilationBasisInput {
  readonly protocol: CompilationProtocol;
  readonly rootCompositionRevisionId: string;
  readonly fragmentRevisions: readonly AuthoredFragmentRevision[];
  readonly compositionRevisions: readonly CompositionRevision[];
  readonly bindings: readonly TypedBinding[];
  readonly targetProfiles: readonly CompilationTargetProfile[];
  readonly ontologyDigest: string;
  readonly policyDigest: string;
  readonly compiler: CompilerIdentity;
}

export interface CompilationBasis extends CompilationBasisInput {
  /** Derived maximum across every reachable source; never accepted from the caller. */
  readonly effectiveClassification: DocumentClassification;
  readonly basisDigest: string;
}
