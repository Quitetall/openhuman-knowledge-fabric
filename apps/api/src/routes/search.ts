import type { FastifyInstance } from 'fastify';
import { setAccessContext, withTransaction, type Pool } from '@kf/database';
import { readCoverage, reaches } from './documents/read-grant.js';
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
        const found = await searchIn(
          tx,
          {
            organizationId: caller.organizationId,
            maxClassification: caller.maxClassification,
          },
          query,
        );
        // A hit is a read. The index is row-level scoped; the grant is applied here, so a
        // record a person is cleared for but not granted does not surface by its title.
        const coverage = await readCoverage(tx, caller);
        return found.filter((hit) =>
          reaches(coverage, { id: hit.objectId, classification: hit.classification }),
        );
      });
      return reply.send({ hits });
    } catch (error: unknown) {
      request.log.error({ err: error }, 'search query failed');
      return reply.code(500).send({ error: 'search_unavailable' });
    }
  });
}
