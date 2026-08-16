import type { FastifyInstance } from 'fastify';
import { setAccessContext, withTransaction, type Pool } from '@kf/database';
import { searchIn } from '@kf/search';
import type { IdentifyCaller } from './actions.js';
import { unidentified } from './actions.js';
import { InvalidSearchQuery, parseSearchQuery } from './search-validation.js';

export interface SearchRoutesOptions {
  readonly pool: Pool;
  readonly identify: IdentifyCaller;
}

export async function registerSearchRoutes(
  app: FastifyInstance,
  options: SearchRoutesOptions,
): Promise<void> {
  app.get<{ Querystring: Record<string, unknown> }>('/search', async (request, reply) => {
    let caller;
    try {
      caller = await options.identify({ headers: request.headers as Record<string, unknown> });
    } catch (error: unknown) {
      return reply.code(401).send(unidentified(error));
    }

    let query;
    try {
      query = parseSearchQuery(request.query);
    } catch (error: unknown) {
      if (error instanceof InvalidSearchQuery) {
        return reply.code(400).send({ error: 'invalid_search_query', field: error.field });
      }
      throw error;
    }

    try {
      const hits = await withTransaction(options.pool, async (tx) => {
        await setAccessContext(tx, {
          organizationId: caller.organizationId,
          maxClassification: caller.maxClassification,
        });
        return searchIn(
          tx,
          {
            organizationId: caller.organizationId,
            maxClassification: caller.maxClassification,
          },
          query,
        );
      });
      return reply.send({ hits });
    } catch (error: unknown) {
      request.log.error({ err: error }, 'search query failed');
      return reply.code(500).send({ error: 'search_unavailable' });
    }
  });
}
