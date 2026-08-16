export type DocumentWorkbenchStatus = 'ready' | 'unavailable' | 'ambiguous';
export type DocumentWorkbenchTargetKind = 'authored_fragment' | 'document_composition';
export type SourceHolderKind = 'fabric_native' | 'git' | 'external';

export interface WorkspaceTargetRow extends Record<string, unknown> {
  readonly target_object_id: string;
  readonly target_kind: DocumentWorkbenchTargetKind;
  readonly subject_id: string;
  readonly stable_key: string;
  readonly document_policy: 'ordinary' | 'controlled' | 'regulated';
  readonly base_revision_id: string;
  readonly target_row_version: string;
  readonly classification: string;
  readonly holder_id: string;
  readonly holder_kind: SourceHolderKind;
  readonly fabric_artifact_version_id: string | null;
  readonly git_repository: string | null;
  readonly git_commit_sha: string | null;
  readonly git_path: string | null;
  readonly git_submodule_commit_sha: string | null;
  readonly external_authority: string | null;
  readonly external_revision: string | null;
  readonly content_digest: string;
  readonly media_type: string | null;
  readonly basis_id: string;
  readonly basis_digest: string;
  readonly effective_classification: string;
  readonly finalized_at: Date;
  readonly target_profiles: unknown;
}

export type WorkspaceTarget =
  | { readonly status: 'unavailable' | 'ambiguous' }
  | { readonly status: 'ready'; readonly row: WorkspaceTargetRow };

export type WorkspaceHolder =
  | {
      readonly kind: 'fabric_native';
      readonly id: string;
      readonly artifactVersionId: string;
      readonly contentDigest: string;
      readonly mediaType: string | null;
    }
  | {
      readonly kind: 'git';
      readonly id: string;
      readonly repository: string;
      readonly commitSha: string;
      readonly path: string;
      readonly submoduleCommitSha: string | null;
      readonly contentDigest: string;
    }
  | {
      readonly kind: 'external';
      readonly id: string;
      readonly authority: string;
      readonly revision: string;
      readonly contentDigest: string;
    };

export interface WorkbenchTarget {
  readonly kind: DocumentWorkbenchTargetKind;
  readonly objectId: string;
  readonly subjectId: string;
  readonly stableKey: string;
  readonly documentPolicy: 'ordinary' | 'controlled' | 'regulated';
  readonly baseRevisionId: string;
  readonly rowVersion: string;
  readonly classification: string;
  readonly holderId: string;
  readonly holder: WorkspaceHolder;
  readonly contentDigest: string;
  readonly mediaType: string | null;
}

export interface WorkspaceBasis {
  readonly id: string;
  readonly digest: string;
  readonly effectiveClassification: string;
  readonly finalizedAt: string;
  readonly targetProfiles: readonly unknown[];
}

export interface WorkspaceCompilation {
  readonly runId: string;
  readonly status: 'succeeded' | 'failed';
  readonly draftOnly: boolean;
  readonly semanticDigest: string | null;
  readonly diagnostics: readonly unknown[];
  readonly conversionLoss: readonly unknown[];
  readonly recordedAt: string;
}

export interface WorkspaceProjection {
  readonly id: string;
  readonly target: string;
  readonly mediaType: string;
  readonly artifactVersionId: string;
  readonly contentDigest: string;
  readonly effectiveClassification: string;
}

export interface WorkspaceCompositionNode {
  readonly revisionId: string;
  readonly subjectId: string;
  readonly objectId: string;
  readonly title: string;
  readonly stableKey: string;
  readonly revisionDigest: string;
  readonly classification: string;
  readonly createdAt: string;
}

export interface WorkspaceCompositionInput {
  readonly compositionRevisionId: string;
  readonly ordinal: number;
  readonly role: 'fragment' | 'composition' | 'resource' | 'binding' | 'generated_view';
  readonly targetId: string;
  readonly targetTitle: string | null;
  readonly contentDigest: string | null;
}

export interface WorkspaceCompositionGraph {
  readonly rootRevisionId: string;
  readonly nodes: readonly WorkspaceCompositionNode[];
  readonly inputs: readonly WorkspaceCompositionInput[];
}

export interface WorkspaceNavigationLink {
  readonly id: string;
  readonly relationType: string;
  readonly direction: 'outbound' | 'inbound';
  readonly peerObjectId: string;
  readonly peerObjectType: string;
  readonly peerTitle: string;
  readonly recordedAt: string;
}

export interface WorkspaceAdrLink {
  readonly decisionId: string;
  readonly title: string;
  readonly lifecycleState: string;
  readonly latestProgressKind: string | null;
  readonly topicKey: string | null;
}

export interface WorkspaceTopicLink {
  readonly decisionId: string;
  readonly topicKey: string;
  readonly title: string;
  readonly lifecycleState: string;
}

export interface WorkspaceNavigation {
  readonly backlinks: readonly WorkspaceNavigationLink[];
  readonly traceability: readonly WorkspaceNavigationLink[];
  readonly adr: readonly WorkspaceAdrLink[];
  readonly topics: readonly WorkspaceTopicLink[];
}

export type SemanticDiff =
  | { readonly status: 'unavailable' }
  | {
      readonly status: 'available';
      readonly fromRunId: string;
      readonly toRunId: string;
      readonly changes: readonly unknown[];
      readonly truncated: boolean;
    };

export type DocumentWorkspace =
  | { readonly status: 'unavailable' | 'ambiguous' }
  | {
      readonly status: 'ready';
      readonly target: WorkbenchTarget;
      readonly basis: WorkspaceBasis;
      readonly compilation: WorkspaceCompilation | null;
      readonly projections: readonly WorkspaceProjection[];
      readonly composition: WorkspaceCompositionGraph;
      readonly navigation: WorkspaceNavigation;
      readonly semanticDiff: SemanticDiff;
    };
