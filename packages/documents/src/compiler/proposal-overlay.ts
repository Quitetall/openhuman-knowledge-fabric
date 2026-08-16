import { digest } from '@kf/canonicalization';
import {
  validateDocumentProposalModelProvenance,
  validateDocumentProposalOperation,
  type DocumentProposalModelProvenance,
  type DocumentProposalOperation,
} from '../proposal.js';
import type { ProposalAuthor, ProposalOverlay, ProposalOverlayInput } from './types.js';
import {
  CLASSIFICATION_RANK,
  exactKeys,
  fail,
  nonEmpty,
  sha256,
  utcInstant,
} from './primitives.js';

function proposalAuthor(input: ProposalAuthor): ProposalAuthor {
  if (input.kind === 'human') {
    exactKeys(input, ['kind', 'actorId'], 'human proposal author');
    return Object.freeze({
      kind: input.kind,
      actorId: nonEmpty(input.actorId, 'proposedBy.actorId'),
    });
  }
  if (input.kind === 'model') {
    exactKeys(input, ['kind', 'provider', 'modelProfile', 'requestId'], 'model proposal author');
    return Object.freeze({
      kind: input.kind,
      provider: nonEmpty(input.provider, 'proposedBy.provider'),
      modelProfile: nonEmpty(input.modelProfile, 'proposedBy.modelProfile'),
      requestId: nonEmpty(input.requestId, 'proposedBy.requestId'),
    });
  }
  return fail('unknown_proposal_author', 'proposal author kind is not supported');
}

/** Create a durable derived proposal; applying it is a separate authorized source action. */
export function createProposalOverlay(input: ProposalOverlayInput): ProposalOverlay {
  if (input.operations.length !== 1) {
    fail(
      'invalid_proposal_operation_count',
      'a proposal overlay must contain exactly one operation',
    );
  }
  let operation: DocumentProposalOperation;
  try {
    operation = validateDocumentProposalOperation(input.operations[0]);
  } catch (error: unknown) {
    fail(
      'invalid_proposal_operation',
      `proposal operation is invalid: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
  if (
    (input.kind === 'source_patch' && operation.operation !== 'replace_fragment_source') ||
    (input.kind === 'semantic_operations' && operation.operation !== 'replace_composition_inputs')
  ) {
    fail('proposal_kind_mismatch', 'proposal kind does not match its exact operation');
  }
  const proposedBy = proposalAuthor(input.proposedBy);
  let modelProvenance: DocumentProposalModelProvenance | null = null;
  if (proposedBy.kind === 'human') {
    if (input.modelProvenance !== null) {
      fail('unexpected_model_provenance', 'a human proposal cannot carry model provenance');
    }
  } else {
    if (input.modelProvenance === null) {
      fail('missing_model_provenance', 'a model proposal requires exact model provenance');
    }
    try {
      modelProvenance = validateDocumentProposalModelProvenance(input.modelProvenance);
    } catch (error: unknown) {
      fail(
        'invalid_model_provenance',
        `model proposal provenance is invalid: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    if (
      modelProvenance.provider.provider_id !== proposedBy.provider ||
      modelProvenance.provider.model_id !== proposedBy.modelProfile
    ) {
      fail('model_provider_mismatch', 'proposal author differs from model provider provenance');
    }
    if (modelProvenance.request_id !== proposedBy.requestId) {
      fail('model_request_mismatch', 'proposal author differs from model request provenance');
    }
    if (modelProvenance.basis_id !== input.basisId) {
      fail('model_basis_mismatch', 'proposal Basis differs from model provenance');
    }
    if (
      !modelProvenance.context.included_items.some(
        (item) => item.subject_id === input.subjectId && item.revision_id === input.baseRevisionId,
      )
    ) {
      fail('model_context_mismatch', 'proposal target revision is absent from model context');
    }
    if (
      CLASSIFICATION_RANK[operation.classification] >
      CLASSIFICATION_RANK[modelProvenance.classification]
    ) {
      fail(
        'model_classification_mismatch',
        'proposal operation exceeds model context classification',
      );
    }
  }
  const createdAt = utcInstant(input.createdAt, 'proposal createdAt');
  const claim: ProposalOverlayInput = {
    id: nonEmpty(input.id, 'proposal.id'),
    subjectId: nonEmpty(input.subjectId, 'proposal.subjectId'),
    baseRevisionId: nonEmpty(input.baseRevisionId, 'proposal.baseRevisionId'),
    basisId: nonEmpty(input.basisId, 'proposal.basisId'),
    basisDigest: sha256(input.basisDigest, 'proposal.basisDigest'),
    kind: input.kind,
    proposedBy,
    modelProvenance,
    operations: Object.freeze([operation]),
    createdAt,
  };
  return Object.freeze({ ...claim, proposalDigest: digest(claim) });
}
