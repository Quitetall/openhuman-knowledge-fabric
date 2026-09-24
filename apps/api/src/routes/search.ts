import type { FastifyInstance } from 'fastify';
import { withTransaction, type Pool, type Tx, bindPrincipal } from '@kf/database';
import type { SemanticRetrieval } from '@kf/retrieval';
import { composeSearch, type SemanticRanker } from '@kf/search';
import { readCoverage, reaches } from './documents/read-grant.js';
import type { IdentifyCaller } from './actions.js';
import { refuseUnidentified } from './actions.js';
import { InvalidSearchQuery, parseNearMisses, parseSearchQuery } from './search-validation.js';

export interface SearchRoutesOptions {
  readonly pool: Pool;
  readonly identify: IdentifyCaller;
  /**
   * The retrieval engine (§64A). Absent means lexical only, and every answer carries a
   * `semantic_ranking_unavailable` withholding entry saying so (KF-SAS-RQ-216).
   */
  readonly semantic?: Pick<SemanticRetrieval, 'rank'>;
}

/**
 * GET /search — one query, two rankings, composed rather than merged (KF-SAS-RQ-224).
 *
 * `lexical` is the exhaustive answer, `semantic` the engine's (when it answered), `nearMisses`
 * only on request (KF-SAS-RQ-217), `withheld` the ledger of what could not be done and why,
 * `withheldCount` how many matching records within the caller's ceiling no grant reaches
 * (ADR 0037). `hits` repeats `lexical.hits` for clients written before composition.
 */
export async function registerSearchRoutes(
  app: FastifyInstance,
  options: SearchRoutesOptions,
): Promise<void> {
  app.get<{ Querystring: Record<string, unknown> }>('/search', async (request, reply) => {
    let caller;
    try {
      caller = await options.identify({ headers: request.headers as Record<string, unknown> });
    } catch (error: unknown) {
      return refuseUnidentified(reply, error);
    }

    let query;
    let nearMisses;
    try {
      query = parseSearchQuery(request.query);
      nearMisses = parseNearMisses(request.query);
    } catch (error: unknown) {
      if (error instanceof InvalidSearchQuery) {
        return reply.code(400).send({ error: 'invalid_search_query', field: error.field });
      }
      throw error;
    }

    const identity = caller;
    // Every transaction the composition opens binds the same principal; none stays open while
    // the retrieval engine works (ADR 0028).
    const run = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
      withTransaction(options.pool, async (tx) => {
        await bindPrincipal(tx, identity);
        return fn(tx);
      });

    try {
      // A hit is a read. The index is row-level scoped; the grant is applied to every match, so a
      // record a person is cleared for but not granted neither surfaces by its title nor fills a
      // slot on the page — it is counted, once, in `withheldCount`.
      const coverage = await run((tx) => readCoverage(tx, identity));
      const semantic: SemanticRanker | undefined =
        options.semantic === undefined
          ? undefined
          : {
              rank: (runner, ranked) => options.semantic!.rank(runner, { ...ranked, coverage }),
            };
      const composed = await composeSearch(
        run,
        {
          organizationId: identity.organizationId,
          maxClassification: identity.maxClassification,
          attestation: identity.attestation,
        },
        query,
        {
          grants: {
            reaches: (id, classification) => reaches(coverage, { id, classification }),
          },
          ...(semantic === undefined ? {} : { semantic }),
          nearMisses,
          record: true,
        },
      );
      return reply.send({ hits: composed.lexical.hits, ...composed });
    } catch (error: unknown) {
      request.log.error({ err: error }, 'search query failed');
      return reply.code(500).send({ error: 'search_unavailable' });
    }
  });
}
