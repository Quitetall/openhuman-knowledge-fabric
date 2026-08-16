import type { FastifyInstance } from 'fastify';
import { ActionRejected } from '@kf/actions';
import { setAccessContext, withTransaction } from '@kf/database';
import { unidentified } from '../actions.js';
import type { DocumentRoutesOptions } from './contracts.js';
import {
  parseDocumentProposal,
  parseDocumentProposalClaim,
  proposalMatchesWorkspace,
  type DocumentProposalBody,
} from './proposal-validation.js';
import { resolveWorkspaceTarget } from './workspace-repository.js';

function operationPayload(operation: ReturnType<typeof parseDocumentProposal>['operation']) {
  if (operation.operation === 'replace_composition_inputs') {
    return {
      operation: operation.operation,
      classification: operation.classification,
      holder_id: operation.holder_id,
      previous_holder_id: operation.previous_holder_id,
      holder: { ...operation.holder },
      inputs: operation.inputs.map((input) => ({ ...input })),
    };
  }
  return {
    operation: operation.operation,
    media_type: operation.media_type,
    classification: operation.classification,
    holder_id: operation.holder_id,
    previous_holder_id: operation.previous_holder_id,
    holder: { ...operation.holder },
  };
}

export function registerDocumentProposalRoute(
  app: FastifyInstance,
  options: DocumentRoutesOptions,
): void {
  app.post<{ Params: { id: string }; Body: DocumentProposalBody }>(
    '/documents/:id/proposals',
    async (request, reply) => {
      let identity;
      try {
        identity = await options.identify({ headers: request.headers as Record<string, unknown> });
      } catch (error: unknown) {
        return reply.code(401).send(unidentified(error));
      }
      try {
        const claim = parseDocumentProposalClaim(request.body ?? {});
        const result = await withTransaction(options.pool, async (tx) => {
          await setAccessContext(tx, {
            organizationId: identity.organizationId,
            maxClassification: identity.maxClassification,
          });
          const workspace = await resolveWorkspaceTarget(tx, request.params.id);
          if (workspace.status !== 'ready' || !proposalMatchesWorkspace(claim, workspace.row)) {
            return undefined;
          }
          const proposal = parseDocumentProposal(request.body ?? {});
          if (proposal.operation.previous_holder_id !== workspace.row.holder_id) return undefined;
          if (
            (workspace.row.target_kind === 'authored_fragment' &&
              proposal.proposalKind !== 'source_patch') ||
            (workspace.row.target_kind === 'document_composition' &&
              proposal.proposalKind !== 'semantic_operations')
          ) {
            return undefined;
          }
          return options.executeInTransaction(tx, {
            actionType: 'record_document_proposal',
            actorId: identity.actorId,
            actingRoleId: identity.actingRoleId,
            organizationId: identity.organizationId,
            maxClassification: identity.maxClassification,
            targetIds: [workspace.row.target_object_id],
            expectedVersion: proposal.targetRowVersion,
            idempotencyKey: proposal.idempotencyKey,
            requestId: String(request.id),
            ...(proposal.reason === undefined ? {} : { reason: proposal.reason }),
            payload: {
              proposal_id: proposal.proposalId,
              basis_id: proposal.basisId,
              proposal_kind: proposal.proposalKind,
              proposed_by_kind: 'human',
              ...(workspace.row.target_kind === 'document_composition'
                ? { base_composition_revision_id: proposal.baseRevisionId }
                : { base_fragment_revision_id: proposal.baseRevisionId }),
              operations: [operationPayload(proposal.operation)],
            },
          });
        });
        if (result === undefined) {
          return reply.code(409).send({ error: 'stale_document_workspace' });
        }
        return reply.code(201).send({
          proposalId: claim.proposalId,
          actionId: result.actionId,
          replayed: result.replayed,
          auditDigest: result.auditDigest,
        });
      } catch (error: unknown) {
        if (error instanceof TypeError) {
          return reply
            .code(400)
            .send({ error: 'invalid_document_proposal', message: error.message });
        }
        if (error instanceof ActionRejected) {
          const status =
            error.failure === 'object_not_visible'
              ? 404
              : error.failure === 'version_conflict' || error.failure === 'idempotency_conflict'
                ? 409
                : error.failure === 'actor_not_authorized' || error.failure === 'role_not_held'
                  ? 403
                  : 422;
          return reply.code(status).send({
            error: error.failure,
            message: error.message,
            detail: error.detail,
          });
        }
        request.log.error({ err: error }, 'document proposal submission failed');
        return reply.code(500).send({ error: 'internal_error', requestId: request.id });
      }
    },
  );
}
