import {
  validateDocumentProposalModelProvenance,
  validateDocumentProposalOperation,
} from '@kf/documents';
import { requireNonempty, VERIFIED_AI_PROPOSAL } from './primitives.js';
import { isPlannedRequest } from './planned-request.js';
import { planAiProposalContext } from './planner.js';
import { validatePlannerInput } from './planner-input.js';
import { proposalProvenance, markVerifiedResult, validateProposal } from './proposal.js';
import { validateRequest } from './request.js';
import { authorizeProvider } from './routing.js';
import type {
  AiContextPlan,
  AiContextPlannerInput,
  AiContextPlannerRepository,
  AiProposalRequest,
  AiProposalResult,
  AiProvider,
  AiRoutingPolicy,
  RecordDocumentProposalActionPayload,
  RecordDocumentProposalPayloadBase,
} from './types.js';

/** Dispatch one proposal request after policy filtering; never applies returned operations. */
export async function dispatchAiProposal(
  provider: AiProvider,
  input: AiProposalRequest,
  policy: AiRoutingPolicy,
): Promise<AiProposalResult> {
  const request = validateRequest(input);
  const authorization = authorizeProvider(provider, request, policy);
  const proposal = validateProposal(await provider.propose(request), request);
  return markVerifiedResult({
    status: 'proposal',
    proposal,
    provenance: proposalProvenance(provider, request, authorization),
  });
}

export async function dispatchPlannedAiProposal(
  provider: AiProvider,
  plan: AiContextPlan,
  policy: AiRoutingPolicy,
): Promise<AiProposalResult> {
  if (!isPlannedRequest(plan.request)) {
    throw new Error('planned AI dispatch requires a planner-produced request');
  }
  const request = validateRequest(plan.request);
  const selected = new Set(
    plan.selected.map((candidate) => `${candidate.subjectId}\0${candidate.revisionId}`),
  );
  for (const item of request.context) {
    if (!selected.has(`${item.subjectId}\0${item.revisionId}`)) {
      throw new Error('planned AI request contains context outside selected planner output');
    }
  }
  const authorization = authorizeProvider(provider, request, policy);
  const proposal = validateProposal(await provider.propose(request), request);
  return markVerifiedResult({
    status: 'proposal',
    proposal,
    provenance: proposalProvenance(provider, request, authorization),
  });
}

export async function planAndDispatchAiProposal(
  repository: AiContextPlannerRepository,
  provider: AiProvider,
  input: AiContextPlannerInput,
  policy: AiRoutingPolicy,
): Promise<{ readonly plan: AiContextPlan; readonly result: AiProposalResult }> {
  const valid = validatePlannerInput(input);
  const plan = await planAiProposalContext(repository, valid);
  await verifyFinalAuthorization(repository, valid, plan);
  return Object.freeze({
    plan,
    result: await dispatchPlannedAiProposal(provider, plan, policy),
  });
}

async function verifyFinalAuthorization(
  repository: AiContextPlannerRepository,
  input: AiContextPlannerInput,
  plan: AiContextPlan,
): Promise<void> {
  const expectedKeys = plan.selected.map(candidateKey).sort();
  const authorizedKeys = (
    await repository.authorizeSelectedCandidates(input.scope, plan.selected)
  ).map(candidateKey);
  authorizedKeys.sort();
  if (
    authorizedKeys.length !== expectedKeys.length ||
    authorizedKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error('final AI dispatch authorization drifted before provider invocation');
  }
}

function candidateKey(candidate: {
  readonly subjectId: string;
  readonly revisionId: string;
}): string {
  return `${candidate.subjectId}\0${candidate.revisionId}`;
}

export function recordDocumentProposalPayload(options: {
  readonly proposalId: string;
  readonly result: AiProposalResult;
}): RecordDocumentProposalActionPayload {
  if (
    (options.result as unknown as Readonly<Record<PropertyKey, unknown>>)[VERIFIED_AI_PROPOSAL] !==
    true
  ) {
    throw new Error('record_document_proposal payload requires a verified AI proposal result');
  }
  const proposalId = requireNonempty(options.proposalId, 'proposalId');
  if (options.result.proposal.operations.length !== 1) {
    throw new Error('record_document_proposal requires exactly one operation');
  }
  const envelope = options.result.proposal.operations[0]!;
  const operation = validateDocumentProposalOperation(envelope.operation);
  const provenance = validateDocumentProposalModelProvenance(options.result.provenance);
  const included = provenance.context.included_items.find(
    (item) => item.subject_id === envelope.subjectId && item.revision_id === envelope.precondition,
  );
  if (included === undefined) {
    throw new Error('proposal operation is not bound to its recorded context provenance');
  }
  const common: RecordDocumentProposalPayloadBase = {
    proposal_id: proposalId,
    basis_id: provenance.basis_id,
    proposed_by_kind: 'model',
    model_provider: provenance.provider.provider_id,
    model_profile: provenance.provider.model_id,
    model_request_id: provenance.request_id,
    operations: Object.freeze([operation]),
    model_provenance: provenance,
  };
  return operation.operation === 'replace_fragment_source'
    ? Object.freeze({
        ...common,
        proposal_kind: 'source_patch',
        base_fragment_revision_id: envelope.precondition,
      })
    : Object.freeze({
        ...common,
        proposal_kind: 'semantic_operations',
        base_composition_revision_id: envelope.precondition,
      });
}
