import type { FastifyInstance } from 'fastify';
import { withTransaction, type Pool, type Tx, bindPrincipal } from '@kf/database';
import type { SemanticRetrieval } from '@kf/retrieval';
import { reaches as grantReaches, readCoverage as grantCoverage } from '@kf/authorization';
import {
  composeSearch,
  listOwnRecordedQueries,
  replayOrganizationDemand,
  replayRecordedQuery,
  type SemanticRanker,
} from '@kf/search';
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
      // Named, so a refusal before anybody is bound is recorded (20260926200200).
      caller = await options.identify({
        headers: request.headers as Record<string, unknown>,
        surface: 'search',
      });
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

  /**
   * GET /search/recorded-queries — the caller's OWN recorded queries (KF-SAS-RQ-221), newest
   * first. There is no parameter naming whose: the database recomputes the bound principal's
   * pseudonymous asker key and returns only rows carrying it.
   */
  app.get('/search/recorded-queries', async (request, reply) => {
    let caller;
    try {
      caller = await options.identify({ headers: request.headers as Record<string, unknown> });
    } catch (error: unknown) {
      return refuseUnidentified(reply, error);
    }
    try {
      const queries = await withTransaction(options.pool, async (tx) => {
        await bindPrincipal(tx, caller);
        return listOwnRecordedQueries(tx);
      });
      return reply.send({ queries });
    } catch (error: unknown) {
      request.log.error({ err: error }, 'recorded query listing failed');
      return reply.code(500).send({ error: 'search_unavailable' });
    }
  });

  /**
   * POST /search/recorded-queries/:id/replay — replay one of the caller's own recorded queries at
   * their ceiling now (§64B). What the original ceiling withheld is returned and not stored; each
   * such record the caller may read counts once, for this pseudonymous asker, into
   * `org.access_demand` (search.record_demand). A query that is not the caller's own, expired, or
   * unknown is the same 404.
   */
  app.post<{ Params: { id: string } }>(
    '/search/recorded-queries/:id/replay',
    async (request, reply) => {
      let caller;
      try {
        caller = await options.identify({ headers: request.headers as Record<string, unknown> });
      } catch (error: unknown) {
        return refuseUnidentified(reply, error);
      }
      const id = request.params.id;
      if (!UUID.test(id)) {
        return reply.code(400).send({ error: 'invalid_search_query', field: 'id' });
      }
      try {
        const replay = await withTransaction(options.pool, async (tx) => {
          await bindPrincipal(tx, caller);
          const own = await listOwnRecordedQueries(tx, id);
          if (own.length === 0) return undefined;
          const coverage = await grantCoverage(tx, caller);
          return replayRecordedQuery(
            tx,
            {
              organizationId: caller.organizationId,
              maxClassification: caller.maxClassification,
              attestation: caller.attestation,
            },
            {
              reaches: (objectId, classification) =>
                grantReaches(coverage, { id: objectId, classification }),
            },
            id,
          );
        });
        if (replay === undefined) return reply.code(404).send({ error: 'not_found' });
        return reply.send(replay);
      } catch (error: unknown) {
        request.log.error({ err: error }, 'recorded query replay failed');
        return reply.code(500).send({ error: 'search_unavailable' });
      }
    },
  );

  /**
   * POST /search/demand/replay — replay the organization's recorded queries asked below the
   * caller's ceiling, at the caller's ceiling and grants, and count what each original ceiling
   * withheld into `org.access_demand` (ADR 0029, §64B). The answer is the aggregate — records the
   * caller may read, each with its count of distinct persons — and how many queries were replayed.
   * It carries no query text, no recorded-query id or time and no asker: other people's recorded
   * queries are never listed (ADR 0029, amended 2026-09-24).
   */
  app.post('/search/demand/replay', async (request, reply) => {
    let caller;
    try {
      caller = await options.identify({ headers: request.headers as Record<string, unknown> });
    } catch (error: unknown) {
      return refuseUnidentified(reply, error);
    }
    try {
      const replay = await withTransaction(options.pool, async (tx) => {
        await bindPrincipal(tx, caller);
        const coverage = await grantCoverage(tx, caller);
        return replayOrganizationDemand(
          tx,
          {
            organizationId: caller.organizationId,
            maxClassification: caller.maxClassification,
            attestation: caller.attestation,
          },
          {
            reaches: (objectId, classification) =>
              grantReaches(coverage, { id: objectId, classification }),
          },
        );
      });
      return reply.send(replay);
    } catch (error: unknown) {
      request.log.error({ err: error }, 'demand replay failed');
      return reply.code(500).send({ error: 'search_unavailable' });
    }
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
