import type {
  DocumentProposalClassification,
  DocumentProposalContextKind,
  DocumentProposalIncludedContextProvenance,
  DocumentProposalModelProvenance,
  DocumentProposalOperation,
  DocumentProposalProviderPolicyDecision,
} from '@kf/documents';
import type { ProjectionResult } from '@kf/projections';

export type AiClassification = DocumentProposalClassification;
export type AiContextKind = DocumentProposalContextKind;

export interface AiContextItem {
  readonly subjectId: string;
  readonly revisionId: string;
  readonly classification: AiClassification;
  readonly kind: AiContextKind;
  readonly content: string;
  readonly tokenCount: number;
  readonly provenanceDigest: string;
}

export interface AiProposalRequest {
  readonly requestId: string;
  readonly basisId: string;
  readonly instruction: string;
  readonly classification: AiClassification;
  readonly tokenizer: string;
  readonly tokenBudget: number;
  readonly context: readonly AiContextItem[];
  readonly omittedSubjectIds: readonly string[];
}

export interface AiContextPlannerScope {
  readonly organizationId: string;
  readonly maxClassification: AiClassification;
  readonly actorId: string;
  readonly actingRoleId: string;
}

export type AiContextChannel = 'lexical' | 'typed_relation' | 'derived_vector';

export interface AiContextCandidate extends AiContextItem {
  /**
   * The corpus member (`core.object`) this candidate is content of. A subject may be finer than
   * a record — a document fragment — so membership of the `agent_context` projection is judged
   * on this, never on `subjectId`. Not sent to the provider.
   */
  readonly objectId: string;
  readonly sourceDigest: string;
  readonly updatedAt: string;
  readonly verified: boolean;
  readonly lexicalScore?: number;
  readonly vectorScore?: number;
  readonly relationDepth?: number;
}

export interface AiPlannedContextCandidate extends AiContextCandidate {
  readonly channels: readonly AiContextChannel[];
  readonly score: number;
}

export interface AiContextPlannerRepository {
  authorizedLexicalCandidates(
    scope: AiContextPlannerScope,
    query: string,
  ): Promise<readonly AiContextCandidate[]>;
  authorizedTypedRelationCandidates(
    scope: AiContextPlannerScope,
    seeds: readonly string[],
  ): Promise<readonly AiContextCandidate[]>;
  authorizedDerivedVectorCandidates?(
    scope: AiContextPlannerScope,
    query: string,
  ): Promise<readonly AiContextCandidate[]>;
  authorizeSelectedCandidates(
    scope: AiContextPlannerScope,
    candidates: readonly AiContextCandidate[],
  ): Promise<readonly AiContextCandidate[]>;
}

export type AiOmissionReason =
  | 'classification_ceiling'
  | 'duplicate_subject'
  | 'invalid_candidate'
  | 'not_authorized'
  | 'outside_projection'
  | 'token_budget';

export interface AiOmittedContextRecord {
  readonly subjectId: string;
  readonly revisionId: string | null;
  readonly reason: AiOmissionReason;
  readonly channels: readonly AiContextChannel[];
  readonly detail: string;
}

export interface AiContextPlannerInput {
  readonly scope: AiContextPlannerScope;
  readonly requestId: string;
  readonly basisId: string;
  readonly instruction: string;
  readonly classification: AiClassification;
  readonly tokenizer: string;
  readonly tokenBudget: number;
  readonly query: string;
  readonly seedSubjectIds: readonly string[];
  /**
   * The principal's `agent_context` Result (KF-SAS-RQ-115). Agent context is a projection, so the
   * planner may use only content of its included members: every other candidate is omitted as
   * `outside_projection`. A Result that is not this principal's intact `agent_context` is refused.
   */
  readonly projection: ProjectionResult;
}

/** Which projection a plan's context was drawn from — recorded, so it can be checked later. */
export interface AiContextProjectionRecord {
  readonly definitionId: 'agent_context';
  readonly definitionVersion: number;
  readonly corpusDigest: string;
  readonly projectionDigest: string;
}

export interface AiContextPlan {
  readonly request: AiProposalRequest;
  readonly selected: readonly AiPlannedContextCandidate[];
  readonly omitted: readonly AiOmittedContextRecord[];
  readonly projection: AiContextProjectionRecord;
}

export interface AiProposalOperation {
  readonly subjectId: string;
  readonly precondition: string;
  readonly operation: DocumentProposalOperation;
}

export interface AiProviderResponse {
  readonly summary: string;
  readonly operations: readonly AiProposalOperation[];
}

export interface AiProvider {
  readonly providerId: string;
  readonly modelId: string;
  readonly locality: 'local' | 'remote';
  propose(request: AiProposalRequest): Promise<AiProviderResponse>;
}

export interface RemoteProviderPolicy {
  readonly providerId: string;
  readonly modelId: string;
  readonly classificationCeiling: AiClassification;
  readonly retentionDays: number;
  readonly trainingUse: 'disabled' | 'contractually_disabled';
  readonly transportPolicy: 'tls_1_3' | 'private_endpoint';
}

export interface AiRoutingPolicy {
  readonly policyId: string;
  readonly localClassificationCeiling: AiClassification;
  readonly remoteAllowlist: readonly RemoteProviderPolicy[];
}

export type AiProviderPolicyDecision = DocumentProposalProviderPolicyDecision;
export type AiIncludedContextProvenance = DocumentProposalIncludedContextProvenance;
export type AiProposalProvenance = DocumentProposalModelProvenance;

export interface AiProposalResult {
  readonly status: 'proposal';
  readonly proposal: AiProviderResponse;
  readonly provenance: AiProposalProvenance;
}

export interface AiEvaluationResult {
  readonly suiteId: string;
  readonly basisId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly policyId: string;
  readonly tokenizer: string;
  readonly evaluatedAt: string;
  readonly retrievalAccuracy: number;
  readonly referenceResolution: number;
  readonly structureTable: number;
  readonly graphOperations: number;
  readonly hallucination: number;
  readonly provenanceRetention: number;
  readonly leakage: number;
  readonly tokensPerSemanticFact: number;
}

export interface RecordDocumentProposalPayloadBase {
  readonly proposal_id: string;
  readonly basis_id: string;
  readonly proposed_by_kind: 'model';
  readonly model_provider: string;
  readonly model_profile: string;
  readonly model_request_id: string;
  readonly operations: readonly [DocumentProposalOperation];
  readonly model_provenance: AiProposalProvenance;
}

export type RecordDocumentProposalActionPayload =
  | (RecordDocumentProposalPayloadBase & {
      readonly proposal_kind: 'source_patch';
      readonly base_fragment_revision_id: string;
    })
  | (RecordDocumentProposalPayloadBase & {
      readonly proposal_kind: 'semantic_operations';
      readonly base_composition_revision_id: string;
    });

export interface LamuAdapterOptions {
  readonly modelId: string;
  readonly invoke: (request: AiProposalRequest) => Promise<AiProviderResponse>;
}
