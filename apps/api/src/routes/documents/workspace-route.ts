import type { FastifyInstance } from 'fastify';
import { setAccessContext, withTransaction } from '@kf/database';
import { readGranted } from './read-grant.js';
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
        // Not granted reads as not there: the workbench of a record you may not read is not yours.
        if (!(await readGranted(tx, identity, request.params.id)))
          return { status: 'unavailable' as const };
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
