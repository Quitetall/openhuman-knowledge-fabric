import { canonicalize, digest } from '@kf/canonicalization';
import {
  DOCUMENT_PROPOSAL_CONTEXT_FORMAT,
  documentProposalContextDigest,
  validateDocumentProposalModelProvenance,
  validateDocumentProposalOperation,
} from '@kf/documents';
import type {
  AiContextProjectionRecord,
  AiProposalProvenance,
  AiProposalRequest,
  AiProposalResult,
  AiProvider,
  AiProviderPolicyDecision,
  AiProviderResponse,
} from './types.js';
import {
  exactKeys,
  MAX_OPERATION_BYTES,
  MAX_SUMMARY_CHARACTERS,
  record,
  requireNonempty,
  VERIFIED_AI_PROPOSAL,
} from './primitives.js';

export function validateProposal(value: unknown, request: AiProposalRequest): AiProviderResponse {
  const response = record(value, 'proposal response');
  exactKeys(response, ['summary', 'operations'], 'proposal response');
  const summary = requireNonempty(response['summary'], 'proposal summary', MAX_SUMMARY_CHARACTERS);
  if (!Array.isArray(response['operations']) || response['operations'].length !== 1) {
    throw new Error('proposal must contain exactly one operation');
  }
  const rawEnvelope = record(response['operations'][0], 'proposal operation envelope');
  exactKeys(rawEnvelope, ['subjectId', 'precondition', 'operation'], 'proposal operation envelope');
  const subjectId = requireNonempty(rawEnvelope['subjectId'], 'proposal subjectId');
  const precondition = requireNonempty(rawEnvelope['precondition'], 'proposal precondition');
  const context = request.context.find((item) => item.subjectId === subjectId);
  if (context === undefined) throw new Error('proposal subject is not in authorized context');
  if (context.revisionId !== precondition) {
    throw new Error('proposal precondition does not name exact context revision');
  }
  const operation = validateDocumentProposalOperation(rawEnvelope['operation']);
  if (Buffer.byteLength(canonicalize(operation), 'utf8') > MAX_OPERATION_BYTES) {
    throw new Error(`proposal operation exceeds ${String(MAX_OPERATION_BYTES)} bytes`);
  }
  const envelope = Object.freeze({ subjectId, precondition, operation });
  return Object.freeze({ summary, operations: Object.freeze([envelope]) });
}

/**
 * The exact claim recorded with a model proposal. The context digest is the tagged v2 form
 * (KF-SAS-RQ-016) and names the `agent_context` Result the planner drew the context from
 * (KF-SAS-RQ-115), so a verifier can tell which reading of the corpus the model was given.
 */
export function proposalProvenance(
  provider: AiProvider,
  request: AiProposalRequest,
  authorization: { readonly policyId: string; readonly decision: AiProviderPolicyDecision },
  source: AiContextProjectionRecord,
): AiProposalProvenance {
  const includedItems = request.context.map((item) => ({
    subject_id: item.subjectId,
    revision_id: item.revisionId,
    classification: item.classification,
    kind: item.kind,
    token_count: item.tokenCount,
    content_digest: digest(item.content),
    provenance_digest: item.provenanceDigest,
  }));
  const omittedSubjectIds = [...request.omittedSubjectIds];
  const instructionDigest = digest(request.instruction);
  const projection = {
    definition_id: source.definitionId,
    definition_version: source.definitionVersion,
    corpus_digest: source.corpusDigest,
    projection_digest: source.projectionDigest,
  };
  const contextDigest = documentProposalContextDigest({
    projection,
    tokenizer: request.tokenizer,
    token_budget: request.tokenBudget,
    instruction_digest: instructionDigest,
    included_items: includedItems,
    omitted_subject_ids: omittedSubjectIds,
  });
  return validateDocumentProposalModelProvenance({
    request_id: request.requestId,
    basis_id: request.basisId,
    classification: request.classification,
    provider: {
      provider_id: provider.providerId,
      model_id: provider.modelId,
      locality: provider.locality,
    },
    policy: {
      policy_id: authorization.policyId,
      decision: authorization.decision,
    },
    context: {
      format: DOCUMENT_PROPOSAL_CONTEXT_FORMAT,
      projection,
      tokenizer: request.tokenizer,
      token_budget: request.tokenBudget,
      instruction_digest: instructionDigest,
      context_digest: contextDigest,
      included_items: includedItems,
      omitted_subject_ids: omittedSubjectIds,
    },
  });
}

export function markVerifiedResult(result: AiProposalResult): AiProposalResult {
  Object.defineProperty(result, VERIFIED_AI_PROPOSAL, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(result);
}
