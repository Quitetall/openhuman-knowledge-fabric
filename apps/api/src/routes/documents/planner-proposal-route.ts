import type { FastifyInstance } from 'fastify';
import type { JsonValue } from '@kf/canonicalization';
import {
  planAndDispatchAiProposal,
  recordDocumentProposalPayload,
  type AiClassification,
  type AiProposalResult,
} from '@kf/agent-tools';
import { ActionRejected } from '@kf/actions';
import { setAccessContext, withTransaction } from '@kf/database';
import { unidentified } from '../actions.js';
import type { DocumentRoutesOptions } from './contracts.js';
import {
  parseDocumentPlannerProposal,
  type DocumentPlannerProposalBody,
} from './planner-proposal-validation.js';
import { DocumentPlannerRepository } from './planner-proposal-repository.js';
import { actionRejectionBody } from '../actions/errors.js';
import { resolveWorkspaceTarget, type WorkspaceTargetRow } from './workspace-repository.js';

export function registerDocumentPlannerProposalRoute(
  app: FastifyInstance,
  options: DocumentRoutesOptions,
): void {
  app.post<{ Params: { id: string }; Body: DocumentPlannerProposalBody }>(
    '/documents/:id/planner/proposal',
    async (request, reply) => {
      let identity;
      try {
        identity = await options.identify({ headers: request.headers as Record<string, unknown> });
      } catch (error: unknown) {
        return reply.code(401).send(unidentified(error));
      }
      if (options.aiProposalProvider === undefined || options.aiRoutingPolicy === undefined) {
        return reply.code(503).send({
          error: 'ai_planner_unavailable',
          message: 'AI planner provider and routing policy must both be configured.',
        });
      }

      try {
        const claim = parseDocumentPlannerProposal(request.body ?? {});
        const result = await withTransaction(options.pool, async (tx) => {
          await setAccessContext(tx, {
            organizationId: identity.organizationId,
            maxClassification: identity.maxClassification,
          });
          const workspace = await resolveWorkspaceTarget(tx, request.params.id);
          if (workspace.status !== 'ready' || !plannerClaimMatchesWorkspace(claim, workspace.row)) {
            return undefined;
          }
          const seedSubjectIds = [...new Set([...claim.seedSubjectIds, workspace.row.subject_id])];
          if (seedSubjectIds.length > 64) {
            throw new TypeError('seedSubjectIds plus target subject exceeds 64 items');
          }
          const repository = new DocumentPlannerRepository(tx, claim.basisId);
          const planned = await planAndDispatchAiProposal(
            repository,
            options.aiProposalProvider!,
            {
              scope: {
                organizationId: identity.organizationId,
                maxClassification: identity.maxClassification as AiClassification,
                actorId: identity.actorId,
                actingRoleId: identity.actingRoleId,
              },
              requestId: String(request.id),
              basisId: claim.basisId,
              instruction: claim.instruction,
              classification: workspace.row.effective_classification as AiClassification,
              tokenizer: claim.tokenizer,
              tokenBudget: claim.tokenBudget,
              query: claim.query,
              seedSubjectIds,
            },
            options.aiRoutingPolicy!,
          );
          assertPlannerResultMatchesWorkspace(planned.result, workspace.row);
          const payload = recordDocumentProposalPayload({
            proposalId: claim.proposalId,
            result: planned.result,
          });
          return options.executeInTransaction(tx, {
            actionType: 'record_document_proposal',
            actorId: identity.actorId,
            actingRoleId: identity.actingRoleId,
            organizationId: identity.organizationId,
            maxClassification: identity.maxClassification,
            targetIds: [workspace.row.target_object_id],
            expectedVersion: claim.targetRowVersion,
            idempotencyKey: claim.idempotencyKey,
            requestId: String(request.id),
            ...(claim.reason === undefined ? {} : { reason: claim.reason }),
            payload: payload as unknown as Readonly<Record<string, JsonValue>>,
          });
        });
        if (result === undefined) {
          return reply.code(409).send({ error: 'stale_document_workspace' });
        }
        return reply.code(result.replayed ? 200 : 201).send({
          proposalId: claim.proposalId,
          actionId: result.actionId,
          replayed: result.replayed,
          auditDigest: result.auditDigest,
        });
      } catch (error: unknown) {
        if (error instanceof TypeError) {
          return reply
            .code(400)
            .send({ error: 'invalid_ai_planner_request', message: error.message });
        }
        if (error instanceof ActionRejected) {
          const refusal = actionRejectionBody(error);
          if (refusal !== undefined) return reply.code(refusal.status).send(refusal.body);
        }
        if (error instanceof Error && error.message.includes('final AI dispatch authorization')) {
          return reply.code(409).send({
            error: 'planner_context_authorization_drift',
            message: error.message,
          });
        }
        if (error instanceof Error && isPolicyError(error.message)) {
          return reply.code(403).send({
            error: 'ai_provider_policy_denied',
            message: error.message,
          });
        }
        if (error instanceof Error && isProposalValidationError(error.message)) {
          return reply.code(422).send({
            error: 'invalid_ai_proposal',
            message: error.message,
          });
        }
        request.log.error({ err: error }, 'AI planner proposal failed');
        return reply.code(500).send({ error: 'internal_error', requestId: request.id });
      }
    },
  );
}

function plannerClaimMatchesWorkspace(
  claim: {
    readonly basisId: string;
    readonly basisDigest: string;
    readonly targetObjectId: string;
    readonly baseRevisionId: string;
    readonly targetRowVersion: number;
  },
  target: WorkspaceTargetRow,
): boolean {
  return (
    claim.basisId === target.basis_id &&
    claim.basisDigest === target.basis_digest &&
    claim.targetObjectId === target.target_object_id &&
    claim.baseRevisionId === target.base_revision_id &&
    String(claim.targetRowVersion) === target.target_row_version
  );
}

function assertPlannerResultMatchesWorkspace(
  result: AiProposalResult,
  target: WorkspaceTargetRow,
): void {
  const envelope = result.proposal.operations[0];
  if (envelope === undefined) throw new Error('proposal must contain exactly one operation');
  if (
    envelope.subjectId !== target.subject_id ||
    envelope.precondition !== target.base_revision_id
  ) {
    throw new Error('proposal operation is not bound to the exact target revision');
  }
  const operation = envelope.operation;
  if (operation.operation !== 'replace_fragment_source') {
    throw new Error('planner route only records authored fragment source proposals');
  }
  if (operation.previous_holder_id !== target.holder_id) {
    throw new Error('proposal operation does not preserve the current source Holder authority');
  }
  if (operation.media_type !== target.media_type) {
    throw new Error('proposal operation must preserve target media_type');
  }
  if (operation.classification !== target.classification) {
    throw new Error('proposal operation must preserve target classification');
  }
}

function isPolicyError(message: string): boolean {
  return (
    message.includes('allowlisted') ||
    message.includes('classification ceiling') ||
    message.includes('provider locality')
  );
}

function isProposalValidationError(message: string): boolean {
  return (
    message.includes('proposal') ||
    message.includes('operation') ||
    message.includes('precondition') ||
    message.includes('Holder') ||
    message.includes('media_type') ||
    message.includes('classification')
  );
}
