import type { ActionEffect, PreconditionCheck } from '@kf/actions';
import { optionalString, requireString } from '@kf/record-atoms';
import { createProposalOverlay } from '../compiler.js';
import { refuseDocument } from './action-payload.js';
import { touchDocumentObject } from './composition-store.js';
import { assertDocumentAuthor } from './document-authority.js';
import { proposalModelProvenance, proposalOperations } from './proposal-store.js';
import {
  CLASSIFICATION_RANK,
  DOCUMENT_TARGET,
  requireDocumentTarget,
} from './target-classification.js';

interface ProposalRecordActions {
  readonly assertRecordProposal: PreconditionCheck;
  readonly recordDocumentProposal: ActionEffect;
}

export function createProposalRecordActions(): ProposalRecordActions {
  const assertRecordProposal: PreconditionCheck = async (tx, request, objects) => {
    await assertDocumentAuthor(tx, request, objects);
    const object = requireDocumentTarget(objects, DOCUMENT_TARGET, request.actionType);
    const basisId = requireString(request.payload, 'basis_id');
    const basis = await tx.maybeOne<{ basis_digest: string; finalized_at: Date | null }>(
      'select basis_digest, finalized_at from content.compilation_basis where id = $1',
      [basisId],
    );
    if (basis?.finalized_at === null || basis === undefined) {
      refuseDocument('KF-DOC-PROPOSAL-002', 'proposal requires a visible finalized Basis', {
        basisId,
      });
    }
    const proposalKind = requireString(request.payload, 'proposal_kind');
    if (proposalKind !== 'source_patch' && proposalKind !== 'semantic_operations') {
      throw new Error('proposal_kind must be source_patch or semantic_operations');
    }
    if (
      (object.object_type === 'authored_fragment' && proposalKind !== 'source_patch') ||
      (object.object_type === 'document_composition' && proposalKind !== 'semantic_operations')
    ) {
      refuseDocument('KF-DOC-PROPOSAL-012', 'proposal kind does not match its document subject', {
        proposalKind,
        objectType: object.object_type,
      });
    }
    const proposedByKind = requireString(request.payload, 'proposed_by_kind');
    const operations = proposalOperations(request.payload);
    const operation = operations[0];
    const modelProvenance = proposalModelProvenance(request.payload);
    if (proposedByKind === 'human') {
      const declaredActor = optionalString(request.payload, 'actor_id');
      if (declaredActor !== null && declaredActor !== request.actorId) {
        refuseDocument('KF-DOC-PROPOSAL-003', 'a human proposal may only name the action actor');
      }
      if (modelProvenance !== null) {
        refuseDocument('KF-DOC-PROPOSAL-013', 'a human proposal cannot carry model provenance');
      }
    } else if (proposedByKind === 'model') {
      const provider = requireString(request.payload, 'model_provider');
      const profile = requireString(request.payload, 'model_profile');
      const requestId = requireString(request.payload, 'model_request_id');
      if (
        modelProvenance === null ||
        modelProvenance.basis_id !== basisId ||
        modelProvenance.provider.provider_id !== provider ||
        modelProvenance.provider.model_id !== profile ||
        modelProvenance.request_id !== requestId
      ) {
        refuseDocument(
          'KF-DOC-PROPOSAL-014',
          'model proposal identity does not match exact provenance',
        );
      }
    } else {
      throw new Error('proposed_by_kind must be human or model');
    }
    if (
      (proposalKind === 'source_patch' && operation.operation !== 'replace_fragment_source') ||
      (proposalKind === 'semantic_operations' &&
        operation.operation !== 'replace_composition_inputs')
    ) {
      refuseDocument('KF-DOC-PROPOSAL-015', 'proposal kind does not match exact operation');
    }
    const baseRevisionId =
      object.object_type === 'authored_fragment'
        ? requireString(request.payload, 'base_fragment_revision_id')
        : requireString(request.payload, 'base_composition_revision_id');
    if (
      modelProvenance !== null &&
      (!modelProvenance.context.included_items.some(
        (item) => item.subject_id === object.id && item.revision_id === baseRevisionId,
      ) ||
        CLASSIFICATION_RANK[operation.classification] >
          CLASSIFICATION_RANK[modelProvenance.classification])
    ) {
      refuseDocument(
        'KF-DOC-PROPOSAL-016',
        'model proposal target or classification exceeds recorded context',
      );
    }
    const membership =
      object.object_type === 'authored_fragment'
        ? await tx.maybeOne<{ subject_id: string }>(
            `select r.fragment_id as subject_id
               from content.authored_fragment_revision r
               join content.compilation_basis_fragment bf on bf.fragment_revision_id = r.id
              where r.id = $1 and bf.basis_id = $2`,
            [baseRevisionId, basisId],
          )
        : await tx.maybeOne<{ subject_id: string }>(
            `select r.composition_id as subject_id
               from content.composition_revision r
               join content.compilation_basis_composition bc on bc.composition_revision_id = r.id
              where r.id = $1 and bc.basis_id = $2`,
            [baseRevisionId, basisId],
          );
    if (membership?.subject_id !== object.id) {
      refuseDocument(
        'KF-DOC-PROPOSAL-004',
        'proposal base revision is not the targeted subject in the named Basis',
        { basisId, objectId: object.id },
      );
    }
  };

  const recordDocumentProposal: ActionEffect = async (tx, request, objects, ctx) => {
    const object = requireDocumentTarget(objects, DOCUMENT_TARGET, request.actionType);
    const basisId = requireString(request.payload, 'basis_id');
    const basis = await tx.one<{ basis_digest: string }>(
      'select basis_digest from content.compilation_basis where id = $1',
      [basisId],
    );
    const proposedByKind = requireString(request.payload, 'proposed_by_kind');
    const proposedBy =
      proposedByKind === 'human'
        ? ({ kind: 'human', actorId: request.actorId } as const)
        : ({
            kind: 'model',
            provider: requireString(request.payload, 'model_provider'),
            modelProfile: requireString(request.payload, 'model_profile'),
            requestId: requireString(request.payload, 'model_request_id'),
          } as const);
    const proposal = createProposalOverlay({
      id: requireString(request.payload, 'proposal_id'),
      subjectId: object.id,
      baseRevisionId:
        object.object_type === 'authored_fragment'
          ? requireString(request.payload, 'base_fragment_revision_id')
          : requireString(request.payload, 'base_composition_revision_id'),
      basisId,
      basisDigest: basis.basis_digest,
      kind: requireString(request.payload, 'proposal_kind') as
        'source_patch' | 'semantic_operations',
      proposedBy,
      modelProvenance: proposalModelProvenance(request.payload),
      operations: proposalOperations(request.payload),
      createdAt: ctx.effectiveAt.toISOString(),
    });
    await tx.query(
      `insert into content.proposal_overlay
         (id, subject_id, base_fragment_revision_id, base_composition_revision_id,
          basis_id, proposal_kind, proposed_by_kind, actor_id, model_provider,
          model_profile, model_request_id, model_provenance, operations, proposal_digest,
          created_at, created_by_action)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        proposal.id,
        proposal.subjectId,
        object.object_type === 'authored_fragment' ? proposal.baseRevisionId : null,
        object.object_type === 'document_composition' ? proposal.baseRevisionId : null,
        basisId,
        proposal.kind,
        proposal.proposedBy.kind,
        proposal.proposedBy.kind === 'human' ? proposal.proposedBy.actorId : null,
        proposal.proposedBy.kind === 'model' ? proposal.proposedBy.provider : null,
        proposal.proposedBy.kind === 'model' ? proposal.proposedBy.modelProfile : null,
        proposal.proposedBy.kind === 'model' ? proposal.proposedBy.requestId : null,
        proposal.modelProvenance === null ? null : JSON.stringify(proposal.modelProvenance),
        JSON.stringify(proposal.operations),
        proposal.proposalDigest,
        proposal.createdAt,
        ctx.actionId,
      ],
    );
    await touchDocumentObject(tx, request, object.id);
  };

  return { assertRecordProposal, recordDocumentProposal };
}
