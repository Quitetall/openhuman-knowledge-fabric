export type DocumentProposalClassification = 'public' | 'internal' | 'confidential' | 'restricted';

export type DocumentProposalContextKind = 'document' | 'metric_summary' | 'record';

export type DocumentProposalProviderPolicyDecision =
  | {
      readonly locality: 'local';
      readonly classification_ceiling: DocumentProposalClassification;
    }
  | {
      readonly locality: 'remote';
      readonly classification_ceiling: DocumentProposalClassification;
      readonly retention_days: number;
      readonly training_use: 'disabled' | 'contractually_disabled';
      readonly transport_policy: 'tls_1_3' | 'private_endpoint';
    };

export interface DocumentProposalProviderProvenance {
  readonly provider_id: string;
  readonly model_id: string;
  readonly locality: 'local' | 'remote';
}

export interface DocumentProposalPolicyProvenance {
  readonly policy_id: string;
  readonly decision: DocumentProposalProviderPolicyDecision;
}

export interface DocumentProposalIncludedContextProvenance {
  readonly subject_id: string;
  readonly revision_id: string;
  readonly classification: DocumentProposalClassification;
  readonly kind: DocumentProposalContextKind;
  readonly token_count: number;
  readonly content_digest: string;
  readonly provenance_digest: string;
}

/**
 * The digest format of a model proposal's context claim (KF-SAS-RQ-016). v2 carries its tag inside
 * the preimage and names the agent_context projection the context was drawn from (RQ-115). v1 is
 * the earlier untagged preimage with no projection; stored proposals still carry it and verify
 * under it, and no new proposal may be recorded with it.
 */
export const DOCUMENT_PROPOSAL_CONTEXT_FORMAT = 'kf-ai-proposal-context-v2' as const;

/** Which `agent_context` Result the context was drawn from, as the planner recorded it. */
export interface DocumentProposalContextProjection {
  readonly definition_id: 'agent_context';
  readonly definition_version: number;
  readonly corpus_digest: string;
  readonly projection_digest: string;
}

export interface DocumentProposalContextProvenance {
  /** Absent on a v1 (legacy, untagged) claim; always present on a new one. */
  readonly format?: typeof DOCUMENT_PROPOSAL_CONTEXT_FORMAT;
  /** Present exactly when `format` is. */
  readonly projection?: DocumentProposalContextProjection;
  readonly tokenizer: string;
  readonly token_budget: number;
  readonly instruction_digest: string;
  readonly context_digest: string;
  readonly included_items: readonly DocumentProposalIncludedContextProvenance[];
  readonly omitted_subject_ids: readonly string[];
}

export interface DocumentProposalModelProvenance {
  readonly request_id: string;
  readonly basis_id: string;
  readonly classification: DocumentProposalClassification;
  readonly provider: DocumentProposalProviderProvenance;
  readonly policy: DocumentProposalPolicyProvenance;
  readonly context: DocumentProposalContextProvenance;
}

export interface DocumentProposalGitSourceHolder {
  readonly kind: 'git';
  readonly repository: string;
  readonly commit_sha: string;
  readonly path: string;
  readonly submodule_commit_sha: string | null;
  readonly content_digest: string;
}

export interface DocumentProposalFabricNativeSourceHolder {
  readonly kind: 'fabric_native';
  readonly artifact_version_id: string;
  readonly content_digest: string;
}

export interface DocumentProposalExternalSourceHolder {
  readonly kind: 'external';
  readonly authority: string;
  readonly revision: string;
  readonly content_digest: string;
}

export type DocumentProposalSourceHolder =
  | DocumentProposalFabricNativeSourceHolder
  | DocumentProposalGitSourceHolder
  | DocumentProposalExternalSourceHolder;

export type DocumentProposalCompositionInput =
  | {
      readonly ordinal: number;
      readonly role: 'fragment';
      readonly fragment_revision_id: string;
    }
  | {
      readonly ordinal: number;
      readonly role: 'composition';
      readonly composition_revision_id: string;
    }
  | {
      readonly ordinal: number;
      readonly role: 'resource';
      readonly resource_version_id: string;
      readonly content_digest: string;
    }
  | {
      readonly ordinal: number;
      readonly role: 'binding';
      readonly binding_id: string;
    }
  | {
      readonly ordinal: number;
      readonly role: 'generated_view';
      readonly compiled_view_id: string;
      readonly content_digest: string;
    };

export interface ReplaceFragmentSourceOperation {
  readonly operation: 'replace_fragment_source';
  readonly media_type: string;
  readonly classification: DocumentProposalClassification;
  readonly holder_id: string;
  readonly previous_holder_id: string;
  readonly holder: DocumentProposalSourceHolder;
}

export interface ReplaceCompositionInputsOperation {
  readonly operation: 'replace_composition_inputs';
  readonly classification: DocumentProposalClassification;
  readonly holder_id: string;
  readonly previous_holder_id: string;
  readonly holder: DocumentProposalSourceHolder;
  readonly inputs: readonly DocumentProposalCompositionInput[];
}

export type DocumentProposalOperation =
  ReplaceFragmentSourceOperation | ReplaceCompositionInputsOperation;
