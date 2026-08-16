import type { FastifyInstance } from 'fastify';
import { setAccessContext, withTransaction } from '@kf/database';
import { unidentified } from '../actions.js';
import type { DocumentRoutesOptions } from './contracts.js';
import { documentWorkspace, resolveWorkspaceTarget } from './workspace-repository.js';

export function registerDocumentWorkspaceRoute(
  app: FastifyInstance,
  options: DocumentRoutesOptions,
): void {
  app.get<{ Params: { id: string } }>('/documents/:id/workbench', async (request, reply) => {
    let identity;
    try {
      identity = await options.identify({ headers: request.headers as Record<string, unknown> });
    } catch (error: unknown) {
      return reply.code(401).send(unidentified(error));
    }
    try {
      const workspace = await withTransaction(options.pool, async (tx) => {
        await setAccessContext(tx, {
          organizationId: identity.organizationId,
          maxClassification: identity.maxClassification,
        });
        const target = await resolveWorkspaceTarget(tx, request.params.id);
        return target.status === 'ready' ? documentWorkspace(tx, target.row) : target;
      });
      return reply.send(workspace);
    } catch (error: unknown) {
      request.log.error({ err: error }, 'document workbench projection failed');
      return reply.code(500).send({ error: 'internal_error', requestId: request.id });
    }
  });
}
