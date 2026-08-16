import type { DocumentProposalModelProvenance, DocumentProposalOperation } from '../proposal.js';

export type ProposalAuthor =
  | { readonly kind: 'human'; readonly actorId: string }
  | {
      readonly kind: 'model';
      readonly provider: string;
      readonly modelProfile: string;
      readonly requestId: string;
    };

export interface ProposalOverlayInput {
  readonly id: string;
  readonly subjectId: string;
  readonly baseRevisionId: string;
  readonly basisId: string;
  readonly basisDigest: string;
  readonly kind: 'source_patch' | 'semantic_operations';
  readonly proposedBy: ProposalAuthor;
  readonly modelProvenance: DocumentProposalModelProvenance | null;
  readonly operations: readonly DocumentProposalOperation[];
  readonly createdAt: string;
}

export interface ProposalOverlay extends ProposalOverlayInput {
  readonly proposalDigest: string;
}
