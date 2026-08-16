import type { FastifyInstance } from 'fastify';
import { IdentityRejected } from '@kf/authorization';
import { setAccessContext, withTransaction } from '@kf/database';
import { CallerRejected, unidentified } from '../actions.js';
import type { MlRoutesOptions } from '../ml.js';
import { MlSchemaUnavailable, requireMlSchema } from '../../schema-contract.js';
import type { MlRunQuery } from './contracts.js';
import { readRunProjection } from './run-projection.js';
import { OPAQUE_REFERENCE_TOKEN, parseProjectionPages } from './validation.js';

export function registerRunProjectionRoute(app: FastifyInstance, options: MlRoutesOptions): void {
  app.get<{
    Params: { authorityId: string; revisionId: string };
    Querystring: MlRunQuery;
  }>('/ml/runs/:authorityId/revisions/:revisionId', async (request, reply) => {
    let caller;
    try {
      caller = await options.identify({
        headers: request.headers as Record<string, unknown>,
      });
    } catch (error: unknown) {
      if (error instanceof CallerRejected || error instanceof IdentityRejected) {
        return reply.code(401).send(unidentified(error));
      }
      request.log.error({ err: error }, 'ML run caller identification failed');
      return reply.code(500).send({ error: 'internal_error', requestId: request.id });
    }

    if (
      !OPAQUE_REFERENCE_TOKEN.test(request.params.authorityId) ||
      !OPAQUE_REFERENCE_TOKEN.test(request.params.revisionId)
    ) {
      return reply.code(400).send({
        error: 'invalid_run_reference',
        message: 'run authority and revision must be opaque registry identifiers',
      });
    }

    let pages;
    try {
      pages = parseProjectionPages(request.query);
    } catch (error: unknown) {
      return reply.code(400).send({
        error: 'invalid_pagination',
        message: error instanceof Error ? error.message : 'pagination is invalid',
      });
    }

    try {
      const projection = await withTransaction(options.pool, async (tx) => {
        // One projection must describe one committed state. Under READ COMMITTED, a seal
        // could appear between its query and the later receipt query, producing a response
        // that never existed. This route has no reason to permit writes in its transaction.
        await tx.query('set transaction isolation level repeatable read, read only');
        await setAccessContext(tx, {
          organizationId: caller.organizationId,
          maxClassification: caller.maxClassification,
        });
        await requireMlSchema(tx);
        return readRunProjection(tx, request.params.authorityId, request.params.revisionId, pages);
      });
      return projection === undefined
        ? reply.code(404).send({ error: 'not_found' })
        : reply.send(projection);
    } catch (error: unknown) {
      if (error instanceof MlSchemaUnavailable) {
        return reply.code(503).send({ error: 'ml_schema_unavailable' });
      }
      request.log.error({ err: error }, 'ML run projection failed');
      return reply.code(500).send({ error: 'internal_error', requestId: request.id });
    }
  });
}
