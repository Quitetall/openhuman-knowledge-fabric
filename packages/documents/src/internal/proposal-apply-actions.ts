import type { ActionEffect, PreconditionCheck } from '@kf/actions';
import { requireString } from '@kf/record-atoms';
import { createAuthoredFragmentRevision } from '../compiler.js';
import { TECHNICAL_AUTHORITY_ROLE } from './action-types.js';
import { refuseDocument, requireDigest } from './action-payload.js';
import { assertCompositionClassification } from './composition-classification.js';
import { compositionInputs } from './composition-inputs.js';
import {
  insertCompositionRevision,
  objectClassification,
  touchDocumentObject,
} from './composition-store.js';
import { assertDocumentRole, refuseDocumentAuthority } from './document-authority.js';
import { appendRevisionHolder, assertRevisionHolder } from './holder-authority.js';
import { sourceHolderFromRow } from './holder-store.js';
import { proposalRow, soleProposalOperation } from './proposal-store.js';
import { latestCompositionRevision, latestFragmentRevision } from './revision-readers.js';
import {
  DOCUMENT_TARGET,
  assertClassificationMayAdvance,
  requireDocumentClassification,
  requireDocumentTarget,
} from './target-classification.js';

interface ProposalApplyActions {
  readonly assertApplyProposal: PreconditionCheck;
  readonly applyDocumentProposal: ActionEffect;
}

export function createProposalApplyActions(): ProposalApplyActions {
  const assertApplyProposal: PreconditionCheck = async (tx, request, objects) => {
    await assertDocumentRole(tx, request, objects, TECHNICAL_AUTHORITY_ROLE);
    const object = requireDocumentTarget(objects, DOCUMENT_TARGET, request.actionType);
    const person = await tx.maybeOne<{ id: string }>(
      'select id from org.person where id = $1 and organization = $2',
      [request.actorId, request.organizationId],
    );
    if (person === undefined) {
      refuseDocumentAuthority(
        'KF-DOC-AUTH-004',
        'Proposal Overlay application requires a human organization member',
        { actorId: request.actorId },
      );
    }
    const proposalId = requireString(request.payload, 'proposal_id');
    const proposal = await proposalRow(tx, proposalId);
    if (
      proposal.object_id !== object.id ||
      proposal.proposal_digest !== requireDigest(request.payload, 'proposal_digest')
    ) {
      refuseDocument('KF-DOC-PROPOSAL-007', 'proposal identity or target does not match', {
        proposalId,
        objectId: object.id,
      });
    }
    const alreadyApplied = await tx.maybeOne<{ id: string }>(
      `select id from core.action
        where action_type = 'apply_document_proposal'
          and parameters ->> 'proposal_id' = $1
        limit 1`,
      [proposal.id],
    );
    if (alreadyApplied !== undefined) {
      refuseDocument('KF-DOC-PROPOSAL-008', 'Proposal Overlay has already been applied', {
        proposalId,
      });
    }
    const operation = soleProposalOperation(proposal);
    const operationPayload = operation as unknown as Readonly<Record<string, unknown>>;
    if (object.object_type === 'authored_fragment') {
      const latest = await latestFragmentRevision(tx, object.id);
      if (
        proposal.subject_kind !== 'fragment' ||
        proposal.proposal_kind !== 'source_patch' ||
        proposal.base_fragment_revision_id === null ||
        latest?.revision_id !== proposal.base_fragment_revision_id ||
        latest.revision_state !== 'active' ||
        operation['operation'] !== 'replace_fragment_source'
      ) {
        refuseDocument(
          'KF-DOC-PROPOSAL-009',
          'fragment proposal is stale or is not a supported source patch',
          { proposalId },
        );
      }
      requireString(operationPayload, 'media_type');
      const classification = requireDocumentClassification(operationPayload);
      await assertClassificationMayAdvance(tx, object.id, classification);
      await assertRevisionHolder(tx, operationPayload, object.id);
    } else {
      const latest = await latestCompositionRevision(tx, object.id);
      if (
        proposal.subject_kind !== 'composition' ||
        proposal.proposal_kind !== 'semantic_operations' ||
        proposal.base_composition_revision_id === null ||
        latest?.revision_id !== proposal.base_composition_revision_id ||
        operation['operation'] !== 'replace_composition_inputs'
      ) {
        refuseDocument(
          'KF-DOC-PROPOSAL-011',
          'composition proposal is stale or is not a supported typed composition operation',
          { proposalId },
        );
      }
      const classification = requireDocumentClassification(operationPayload);
      const inputs = await compositionInputs(tx, operationPayload);
      await assertClassificationMayAdvance(tx, object.id, classification);
      await assertCompositionClassification(tx, classification, inputs);
      await assertRevisionHolder(tx, operationPayload, object.id);
    }
    requireString(request.payload, 'revision_id');
  };

  const applyDocumentProposal: ActionEffect = async (tx, request, objects, ctx) => {
    const object = requireDocumentTarget(objects, DOCUMENT_TARGET, request.actionType);
    const proposal = await proposalRow(tx, requireString(request.payload, 'proposal_id'));
    const operation = soleProposalOperation(proposal);
    const operationPayload = operation as unknown as Readonly<Record<string, unknown>>;
    const classification = requireDocumentClassification(operationPayload);
    if (object.object_type === 'authored_fragment') {
      const holderRow = await appendRevisionHolder(
        tx,
        request,
        object.id,
        ctx.actionId,
        operationPayload,
      );
      const revision = createAuthoredFragmentRevision({
        id: requireString(request.payload, 'revision_id'),
        fragmentId: holderRow.subject_id,
        previousRevisionId: proposal.base_fragment_revision_id!,
        mediaType: requireString(operationPayload, 'media_type'),
        classification,
        state: 'draft',
        holder: sourceHolderFromRow(holderRow),
      });
      await tx.query(
        `insert into content.authored_fragment_revision
         (id, fragment_id, previous_revision_id, holder_id, media_type, classification,
          revision_state, content_digest, revision_digest, created_by, created_by_action)
         values ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10)`,
        [
          revision.id,
          revision.fragmentId,
          revision.previousRevisionId,
          holderRow.holder_id,
          revision.mediaType,
          revision.classification,
          revision.holder.contentDigest,
          revision.revisionDigest,
          request.actorId,
          ctx.actionId,
        ],
      );
      await touchDocumentObject(tx, request, object.id, classification);
    } else {
      await appendRevisionHolder(tx, request, object.id, ctx.actionId, operationPayload);
      await touchDocumentObject(tx, request, object.id, classification);
      await insertCompositionRevision(tx, {
        id: requireString(request.payload, 'revision_id'),
        compositionId: object.id,
        previousRevisionId: proposal.base_composition_revision_id!,
        classification: await objectClassification(tx, object.id),
        inputs: await compositionInputs(tx, operationPayload),
        actorId: request.actorId,
        actionId: ctx.actionId,
      });
    }
  };

  return { assertApplyProposal, applyDocumentProposal };
}
