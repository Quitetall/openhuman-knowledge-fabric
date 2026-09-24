import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@kf/database';
import { registerSearchRoutes } from '../../apps/api/src/routes/search.js';
import {
  bindContext,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

/**
 * A person lists and replays their own recorded queries, and nobody else's (KF-SAS-RQ-221, §64B).
 *
 * Through the real routes over the real database: the query is recorded by `GET /search` at a
 * narrowed ceiling, listed by `GET /search/recorded-queries`, and replayed at the person's full
 * ceiling by `POST /search/recorded-queries/:id/replay`, which counts what the narrowed ceiling
 * withheld into `org.access_demand`.
 */

let h: Harness;
let f: Fixtures;
let restrictedMatch: string;
let internalMatch: string;
/** Who the next request is, and at what ceiling. */
let who: { actorId: string; actingRoleId: string; maxClassification: string };
let app: FastifyInstance;

async function as<T>(
  actorId: string,
  maxClassification: string,
  run: () => Promise<T>,
): Promise<T> {
  who = {
    actorId,
    actingRoleId: actorId === f.reviewerId ? f.reviewerRoleId : f.performerRoleId,
    maxClassification,
  };
  return run();
}

async function listOwn(): Promise<{ id: string; text: string; askerCeiling: string }[]> {
  const response = await app.inject({ method: 'GET', url: '/search/recorded-queries' });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { queries: { id: string; text: string; askerCeiling: string }[] })
    .queries;
}

async function demandFor(objectId: string): Promise<number> {
  const row = await withTransaction(h.adminPool, (tx) =>
    tx.maybeOne<{ n: number }>(
      'select distinct_person_count as n from org.access_demand where object_id = $1',
      [objectId],
    ),
  );
  return row?.n ?? 0;
}

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  const make = (title: string) =>
    createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title,
      createdBy: f.performerId,
    });
  restrictedMatch = await make('Beryllium copper spring supplier pricing');
  internalMatch = await make('Beryllium copper spring handling guideline');
  await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f);
    await tx.query(
      `update core.object set classification = 'restricted', row_version = row_version + 1
        where id = $1`,
      [restrictedMatch],
    );
    for (const id of [restrictedMatch, internalMatch]) {
      await tx.query('select search.index_object($1)', [id]);
    }
  });

  app = Fastify();
  await registerSearchRoutes(app, {
    pool: h.pool,
    identify: async () => ({
      ...who,
      organizationId: f.organizationId,
      authentication: { authenticatedAt: undefined, assuranceLevel: undefined, methods: [] },
    }),
  });
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await h?.stop();
});

describe('a person lists their own recorded queries', () => {
  it('lists only the caller’s own, never another person’s they could otherwise read', async () => {
    await as(f.performerId, 'internal', async () => {
      const search = await app.inject({ method: 'GET', url: '/search?q=beryllium%20copper' });
      expect(search.statusCode, search.body).toBe(200);
    });
    await as(f.reviewerId, 'internal', async () => {
      const search = await app.inject({ method: 'GET', url: '/search?q=spring%20handling' });
      expect(search.statusCode, search.body).toBe(200);
    });

    // Both are readable under the table's policy by either person at `internal`; the listing is
    // narrower than the policy, by who asked.
    const performers = await as(f.performerId, 'restricted', listOwn);
    expect(performers.map((q) => q.text)).toEqual(['beryllium copper']);
    expect(performers[0]!.askerCeiling).toBe('internal');
    const reviewers = await as(f.reviewerId, 'restricted', listOwn);
    expect(reviewers.map((q) => q.text)).toEqual(['spring handling']);
  });

  it('replays one, counting what the original ceiling withheld into access demand', async () => {
    const [own] = await as(f.performerId, 'restricted', listOwn);
    expect(await demandFor(restrictedMatch)).toBe(0);

    const response = await as(f.performerId, 'restricted', () =>
      app.inject({ method: 'POST', url: `/search/recorded-queries/${own!.id}/replay` }),
    );
    expect(response.statusCode, response.body).toBe(200);
    const replay = response.json() as {
      askerCeiling: string;
      withheld: { objectId: string }[];
      counted: number;
    };
    expect(replay.askerCeiling).toBe('internal');
    expect(replay.withheld.map((hit) => hit.objectId)).toEqual([restrictedMatch]);
    expect(replay.counted).toBe(1);
    expect(await demandFor(restrictedMatch)).toBe(1);
    expect(await demandFor(internalMatch)).toBe(0);

    // The same person again is not a second person.
    await as(f.performerId, 'restricted', () =>
      app.inject({ method: 'POST', url: `/search/recorded-queries/${own!.id}/replay` }),
    );
    expect(await demandFor(restrictedMatch)).toBe(1);
  });

  it('answers another person’s query as not found, and counts nothing', async () => {
    const [theirs] = await as(f.reviewerId, 'restricted', listOwn);
    const before = await demandFor(restrictedMatch);
    const response = await as(f.performerId, 'restricted', () =>
      app.inject({ method: 'POST', url: `/search/recorded-queries/${theirs!.id}/replay` }),
    );
    expect(response.statusCode).toBe(404);
    expect(await demandFor(restrictedMatch)).toBe(before);

    const malformed = await as(f.performerId, 'restricted', () =>
      app.inject({ method: 'POST', url: '/search/recorded-queries/not-a-uuid/replay' }),
    );
    expect(malformed.statusCode).toBe(400);
  });
});
