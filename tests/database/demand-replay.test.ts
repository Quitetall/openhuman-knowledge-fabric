import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@kf/database';
import { UNVERIFIED_LABEL } from '@kf/domain';
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
 * Somebody cleared higher replays what people cleared lower asked, and is shown only the aggregate
 * (ADR 0029 amended 2026-09-24, §64B, KF-SAS-RQ-221, RQ-222).
 *
 * `POST /search/demand/replay` re-runs every live recorded query asked below the caller's ceiling,
 * at the caller's ceiling, and counts what each original ceiling withheld into `org.access_demand`
 * once per distinct asker. The answer carries records and distinct-person counts; it never carries
 * a query's text, its id or time, or anything naming who asked.
 */

let h: Harness;
let f: Fixtures;
let wanted: string;
let open: string;
let who: { actorId: string; actingRoleId: string; maxClassification: string };
let app: FastifyInstance;

async function as<T>(actorId: string, maxClassification: string, run: () => Promise<T>) {
  who = {
    actorId,
    actingRoleId: actorId === f.reviewerId ? f.reviewerRoleId : f.performerRoleId,
    maxClassification,
  };
  return run();
}

async function search(q: string): Promise<void> {
  const response = await app.inject({ method: 'GET', url: `/search?q=${encodeURIComponent(q)}` });
  expect(response.statusCode, response.body).toBe(200);
}

async function replay(): Promise<{ body: string; json: DemandReplayBody }> {
  const response = await app.inject({ method: 'POST', url: '/search/demand/replay' });
  expect(response.statusCode, response.body).toBe(200);
  return { body: response.body, json: response.json() as DemandReplayBody };
}

interface DemandReplayBody {
  replayed: number;
  truncated: boolean;
  counted: number;
  records: { objectId: string; title: string; distinctPersonCount: number }[];
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
  wanted = await make('Tungsten carbide die pricing');
  open = await make('Tungsten carbide die handling');
  await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f);
    await tx.query(
      `update core.object set classification = 'restricted', row_version = row_version + 1
        where id = $1`,
      [wanted],
    );
    for (const id of [wanted, open]) await tx.query('select search.index_object($1)', [id]);
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

  // Two people ask at `internal`, where the pricing record is withheld; one asks at `restricted`.
  await as(f.performerId, 'internal', () => search('tungsten pricing'));
  await as(f.reviewerId, 'internal', () => search('carbide pricing'));
  await as(f.performerId, 'restricted', () => search('tungsten die'));
}, 240_000);

afterAll(async () => {
  await app?.close();
  await h?.stop();
});

describe('a demand replay by somebody cleared higher', () => {
  it('counts what lower-clearance queries were withheld, once per distinct person', async () => {
    const { body, json } = await as(f.reviewerId, 'restricted', replay);
    // The restricted query is not below the replayer's ceiling, so it is not replayed.
    expect(json.replayed).toBe(2);
    expect(json.truncated).toBe(false);
    expect(json.counted).toBe(2);
    expect(json.records).toEqual([
      expect.objectContaining({ objectId: wanted, distinctPersonCount: 2 }),
    ]);
    expect(json.records.map((r) => r.objectId)).not.toContain(open);

    // Nothing about any query leaves the server: no text, no id, no time, no asker.
    const recorded = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ id: string; query_text: string }>(
        'select id::text, query_text from search.recorded_query',
      ),
    );
    expect(recorded).toHaveLength(3);
    for (const q of recorded) {
      expect(body).not.toContain(q.id);
      expect(body).not.toContain(q.query_text);
    }
    expect(Object.keys(json).sort()).toEqual(['counted', 'records', 'replayed', 'truncated']);
    expect(Object.keys(json.records[0]!).sort()).toEqual([
      'classification',
      'distinctPersonCount',
      'objectId',
      'objectType',
      'title',
      'verification',
    ]);
    // KF-SAS-RQ-229: a record shown here is labelled like anywhere else; nobody verified this one.
    expect(json.records[0]).toMatchObject({
      verification: { verified: false, label: UNVERIFIED_LABEL },
    });
  });

  it('counts nobody twice when replayed again', async () => {
    const { json } = await as(f.reviewerId, 'restricted', replay);
    expect(json.counted).toBe(0);
    expect(json.records).toEqual([
      expect.objectContaining({ objectId: wanted, distinctPersonCount: 2 }),
    ]);
  });

  it('replays nothing for a caller no higher than the askers', async () => {
    const { json } = await as(f.performerId, 'internal', replay);
    expect(json).toEqual({ replayed: 0, truncated: false, counted: 0, records: [] });
  });
});
