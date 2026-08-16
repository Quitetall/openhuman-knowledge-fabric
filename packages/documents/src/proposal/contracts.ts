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

export interface DocumentProposalContextProvenance {
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
