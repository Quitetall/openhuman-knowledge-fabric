import type { Tx } from '@kf/database';
import { createProposalOverlay } from '../compiler.js';
import {
  validateDocumentProposalModelProvenance,
  validateDocumentProposalOperation,
  type DocumentProposalModelProvenance,
  type DocumentProposalOperation,
} from '../proposal.js';
import { refuseDocument, requireArray } from './action-payload.js';

export const proposalOperations = (
  payload: Readonly<Record<string, unknown>> | undefined,
): readonly [DocumentProposalOperation] => {
  const operations = requireArray(payload, 'operations');
  if (operations.length !== 1) {
    throw new Error('operations must contain exactly one typed proposal operation');
  }
  return [validateDocumentProposalOperation(operations[0])];
};

export const proposalModelProvenance = (
  payload: Readonly<Record<string, unknown>> | undefined,
): DocumentProposalModelProvenance | null => {
  const value = payload?.['model_provenance'];
  if (value === undefined || value === null) return null;
  return validateDocumentProposalModelProvenance(value);
};

export interface ProposalRow extends Record<string, unknown> {
  readonly id: string;
  readonly subject_id: string;
  readonly subject_kind: 'fragment' | 'composition';
  readonly object_id: string;
  readonly base_fragment_revision_id: string | null;
  readonly base_composition_revision_id: string | null;
  readonly basis_id: string;
  readonly basis_digest: string;
  readonly proposal_kind: 'source_patch' | 'semantic_operations';
  readonly proposed_by_kind: 'human' | 'model';
  readonly actor_id: string | null;
  readonly model_provider: string | null;
  readonly model_profile: string | null;
  readonly model_request_id: string | null;
  readonly model_provenance: unknown;
  readonly operations: unknown;
  readonly proposal_digest: string;
  readonly created_at: Date;
}

export const proposalRow = async (tx: Tx, proposalId: string): Promise<ProposalRow> => {
  const proposal = await tx.maybeOne<ProposalRow>(
    `select p.id, p.subject_id, s.subject_kind, s.object_id,
            p.base_fragment_revision_id, p.base_composition_revision_id,
            p.basis_id, b.basis_digest, p.proposal_kind, p.proposed_by_kind, p.actor_id,
            p.model_provider, p.model_profile, p.model_request_id, p.model_provenance,
            p.operations, p.proposal_digest, p.created_at
       from content.proposal_overlay p
       join content.document_subject s on s.id = p.subject_id
       join content.compilation_basis b on b.id = p.basis_id
      where p.id = $1`,
    [proposalId],
  );
  if (proposal === undefined) {
    return refuseDocument('KF-DOC-PROPOSAL-001', 'proposal is missing or not visible', {
      proposalId,
    });
  }
  return proposal;
};

export const soleProposalOperation = (proposal: ProposalRow): DocumentProposalOperation => {
  try {
    const proposedBy =
      proposal.proposed_by_kind === 'human'
        ? { kind: 'human' as const, actorId: proposal.actor_id ?? '' }
        : {
            kind: 'model' as const,
            provider: proposal.model_provider ?? '',
            modelProfile: proposal.model_profile ?? '',
            requestId: proposal.model_request_id ?? '',
          };
    const verified = createProposalOverlay({
      id: proposal.id,
      subjectId: proposal.object_id,
      baseRevisionId:
        proposal.base_fragment_revision_id ?? proposal.base_composition_revision_id ?? '',
      basisId: proposal.basis_id,
      basisDigest: proposal.basis_digest,
      kind: proposal.proposal_kind,
      proposedBy,
      modelProvenance:
        proposal.model_provenance === null
          ? null
          : validateDocumentProposalModelProvenance(proposal.model_provenance),
      operations: Array.isArray(proposal.operations)
        ? proposal.operations.map(validateDocumentProposalOperation)
        : [],
      createdAt: proposal.created_at.toISOString(),
    });
    if (verified.proposalDigest !== proposal.proposal_digest) {
      throw new Error('stored proposal digest does not match its exact claim');
    }
    return verified.operations[0]!;
  } catch (error: unknown) {
    return refuseDocument('KF-DOC-PROPOSAL-005', 'stored proposal is malformed', {
      proposalId: proposal.id,
      error: error instanceof Error ? error.message : 'unknown error',
    });
  }
};
