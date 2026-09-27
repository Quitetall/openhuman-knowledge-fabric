/**
 * Search composed from a lexical ranking and a retrieval engine's semantic one, against a stub
 * engine that speaks the real protocol over a real unix socket (§64A, ADR 0028, ADR 0037).
 *
 * The engine is hostile where it matters: it can return a record the caller may not see, or one no
 * grant reaches, and the Fabric must refuse the whole semantic answer rather than show it or
 * quietly drop it (KF-SAS-RQ-213, RQ-216). Everything else — the separate lists (RQ-224), near
 * misses only on request (RQ-217), the disclosure digest with no person (RQ-219), and the
 * withheld count of ADR 0037 (RQ-222) — is asserted against live rows.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { coveringGrants, type AccessCoverage, type AccessGrantRef } from '@kf/authorization';
import { withTransaction, type Tx } from '@kf/database';
import {
  RetrievalClient,
  RETRIEVAL_PROTOCOL_VERSION,
  SemanticRetrieval,
  encode,
  type ServerMessage,
} from '@kf/retrieval';
import {
  composeSearch,
  indexObject,
  recordQuery,
  replayRecordedQuery,
  type SemanticRanker,
} from '@kf/search';
import {
  bindContext,
  bindReader,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from '../database/harness.js';

let h: Harness;
let f: Fixtures;
/** Matches "valve", restricted: above the caller's `internal` ceiling. */
let above: string;
/** Matches "valve", internal, and no grant reaches it. */
let ungranted: string;
/** Matches "valve", internal, granted. */
let granted: string;
/** Does not match "valve", internal, granted: a semantic neighbour only. */
let neighbour: string;

const TRACE = 'sha256:5f1d0c2e9a7b4c3d';

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
  above = await make('Relief valve supplier dispute settlement');
  ungranted = await make('Relief valve torque specification');
  granted = await make('Relief valve inspection interval');
  neighbour = await make('Pressure vessel overpressure protection');
  await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f);
    await tx.query(
      `update core.object set classification = 'restricted', row_version = row_version + 1 where id = $1`,
      [above],
    );
    for (const id of [above, ungranted, granted, neighbour]) await indexObject(tx, id);
  });
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

function objectGrant(id: string): AccessGrantRef {
  return {
    source: 'grant',
    sourceId: `grant-${id}`,
    scopeObjectId: id,
    classificationCeiling: null,
    reason: 'test',
  };
}

/** The caller's grants: object grants on `ids`, nothing organization-wide. */
function coverageOf(ids: readonly string[]): AccessCoverage {
  return { organizationWide: [], byObject: new Map(ids.map((id) => [id, [objectGrant(id)]])) };
}

const run = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withTransaction(h.pool, async (tx) => {
    await bindReader(tx, f, f.performerId, 'internal');
    return fn(tx);
  });

const SCOPE = () => ({ organizationId: f.organizationId, maxClassification: 'internal' });

// ── The stub engine ──────────────────────────────────────────────────────────────────────────

interface Stub {
  readonly path: string;
  readonly searches: { ceiling: string; allow: string[]; k: number }[];
}

let active: { server: Server; dir: string } | undefined;

afterEach(() => {
  active?.server.close();
  if (active) rmSync(active.dir, { recursive: true, force: true });
  active = undefined;
});

/** An engine indexing every record here, which returns `ranked` for every query. */
function stubEngine(ranked: (k: number) => string[]): Stub {
  const dir = mkdtempSync(join(tmpdir(), 'kf-semantic-'));
  const path = join(dir, 'engine.sock');
  const searches: Stub['searches'] = [];
  const slots = [above, ungranted, granted, neighbour];
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        buffer = buffer.slice(newline + 1);
        const reply = (answer: ServerMessage): void => void socket.write(encode(answer));
        if (message['type'] === 'hello') {
          reply({
            type: 'hello_ok',
            protocol: RETRIEVAL_PROTOCOL_VERSION,
            engine: 'stub/1',
            generation: 'g1',
            slotCount: slots.length,
            embedder: { identity: 'local:stub', local: true },
            capabilities: ['vectors_only_write'],
          });
        } else if (message['type'] === 'slots') {
          reply({ type: 'slots_ok', generation: 'g1', objectIds: slots });
        } else if (message['type'] === 'bands') {
          reply({
            type: 'bands_ok',
            bandVersion: String(message['bandVersion']),
            generation: 'g1',
          });
        } else if (message['type'] === 'search') {
          const k = Number(message['k']);
          searches.push({
            ceiling: String(message['ceiling']),
            allow: message['allow'] as string[],
            k,
          });
          reply({
            type: 'results',
            hits: ranked(k).map((objectId, index) => ({
              objectId,
              score: 1 - index / 10,
              rank: index + 1,
            })),
            traceDigest: TRACE,
            ranking: 'stub.cosine.v1',
          });
        }
        newline = buffer.indexOf('\n');
      }
    });
  });
  server.listen(path);
  active = { server, dir };
  return { path, searches };
}

function ranker(path: string, coverage: AccessCoverage): SemanticRanker {
  const engine = new SemanticRetrieval(new RetrievalClient({ socketPath: path, timeoutMs: 1_000 }));
  return { rank: (runner, request) => engine.rank(runner, { ...request, coverage }) };
}

function grantsOf(coverage: AccessCoverage) {
  return {
    reaches: (id: string, classification: string) =>
      coveringGrants(coverage, id, classification).length > 0,
  };
}

async function disclosures(): Promise<{ trace_digest: string; semantic_hits: number }[]> {
  return withTransaction(h.adminPool, (tx) =>
    tx.query('select trace_digest, semantic_hits from retrieval.disclosure order by recorded_at'),
  );
}

// ── The tests ────────────────────────────────────────────────────────────────────────────────

describe('semantic hits are re-checked against what the caller may read (KF-SAS-RQ-213)', () => {
  it('refuses the whole semantic answer when the engine names a record above the ceiling', async () => {
    const coverage = coverageOf([granted, neighbour]);
    const engine = stubEngine(() => [granted, above]);
    const before = (await disclosures()).length;
    const answer = await composeSearch(
      run,
      SCOPE(),
      { text: 'valve' },
      { grants: grantsOf(coverage), semantic: ranker(engine.path, coverage) },
    );
    expect(answer.semantic, 'an engine that leaks one id has its whole answer refused').toBe(
      undefined,
    );
    expect(answer.withheld).toEqual([
      {
        reasonClass: 'semantic_ranking_unavailable',
        reason: expect.stringMatching(/outside the caller's mask/),
      },
    ]);
    expect(JSON.stringify(answer)).not.toContain(above);
    expect(JSON.stringify(answer)).not.toContain('supplier dispute');
    expect(answer.lexical.hits.map((hit) => hit.objectId)).toEqual([granted]);
    expect((await disclosures()).length, 'nothing was disclosed, so nothing is recorded').toBe(
      before,
    );
  });

  it('refuses it too when the engine names a visible record no grant reaches', async () => {
    const coverage = coverageOf([granted, neighbour]);
    const engine = stubEngine(() => [granted, ungranted]);
    const answer = await composeSearch(
      run,
      SCOPE(),
      { text: 'valve' },
      { grants: grantsOf(coverage), semantic: ranker(engine.path, coverage) },
    );
    expect(answer.semantic).toBeUndefined();
    expect(JSON.stringify(answer)).not.toContain('torque specification');
  });

  it('scopes the engine by the caller’s grants, not their clearance', async () => {
    const coverage = coverageOf([granted, neighbour]);
    const engine = stubEngine(() => [granted]);
    await composeSearch(
      run,
      SCOPE(),
      { text: 'valve' },
      { grants: grantsOf(coverage), semantic: ranker(engine.path, coverage) },
    );
    expect(engine.searches).toEqual([
      { ceiling: 'none', allow: [granted, neighbour].sort(), k: 50 },
    ]);
  });
});

describe('lexical and semantic are composed, not merged (KF-SAS-RQ-224, RQ-219)', () => {
  it('returns two lists, each naming its ranking, and records the trace digest', async () => {
    const coverage = coverageOf([granted, neighbour]);
    const engine = stubEngine(() => [neighbour, granted]);
    const answer = await composeSearch(
      run,
      SCOPE(),
      { text: 'valve' },
      { grants: grantsOf(coverage), semantic: ranker(engine.path, coverage) },
    );
    expect(answer.lexical).toMatchObject({
      ranking: 'kf.lexical.idf_coverage(floor=0.5)+phrase+partial_identifier.v2',
      exhaustive: true,
      total: 1,
      complete: true,
    });
    expect(answer.lexical.hits.map((hit) => hit.objectId)).toEqual([granted]);
    expect(answer.semantic?.ranking).toBe('stub.cosine.v1');
    expect(answer.semantic?.hits.map((hit) => hit.objectId)).toEqual([neighbour, granted]);
    expect(answer.withheld).toEqual([]);
    const recorded = await disclosures();
    expect(recorded.at(-1)).toEqual({ trace_digest: TRACE, semantic_hits: 2 });
  });
});

describe('a degraded engine refuses; the answer never carries partial semantic results (KF-SAS-RQ-216)', () => {
  it('serves lexical results with a withholding entry when the engine is down', async () => {
    const coverage = coverageOf([granted]);
    const answer = await composeSearch(
      run,
      SCOPE(),
      { text: 'valve' },
      {
        grants: grantsOf(coverage),
        semantic: ranker(join(tmpdir(), 'kf-no-engine-here.sock'), coverage),
      },
    );
    expect(answer.lexical.hits.map((hit) => hit.objectId)).toEqual([granted]);
    expect(answer.semantic).toBeUndefined();
    expect(answer.withheld).toEqual([
      { reasonClass: 'semantic_ranking_unavailable', reason: expect.any(String) },
    ]);
  });

  it('says so when no engine is configured at all', async () => {
    const answer = await composeSearch(
      run,
      SCOPE(),
      { text: 'valve' },
      { grants: grantsOf(coverageOf([granted])) },
    );
    expect(answer.withheld).toEqual([
      { reasonClass: 'semantic_ranking_unavailable', reason: 'no retrieval engine is configured' },
    ]);
  });
});

describe('near misses are opt-in and labelled (KF-SAS-RQ-217)', () => {
  it('returns them separately, naming the scoring function, only when asked', async () => {
    const coverage = coverageOf([granted, neighbour]);
    const engine = stubEngine((k) => [granted, neighbour].slice(0, k));
    const asked = await composeSearch(
      run,
      SCOPE(),
      { text: 'valve', limit: 1 },
      { grants: grantsOf(coverage), semantic: ranker(engine.path, coverage), nearMisses: true },
    );
    expect(asked.semantic?.hits.map((hit) => hit.objectId)).toEqual([granted]);
    expect(asked.nearMisses).toEqual({
      label: 'near_miss',
      scoringFunction: 'kf.near-miss.rank-window.v1(stub.cosine.v1; ranks 2-2)',
      hits: [expect.objectContaining({ objectId: neighbour })],
    });

    const unasked = await composeSearch(
      run,
      SCOPE(),
      { text: 'valve', limit: 1 },
      { grants: grantsOf(coverage), semantic: ranker(engine.path, coverage) },
    );
    expect(unasked.nearMisses).toBeUndefined();
    expect(unasked.semantic?.hits.map((hit) => hit.objectId)).toEqual([granted]);
    expect(engine.searches.map((search) => search.k)).toEqual([2, 1]);
  });
});

describe('what a query withheld is one count within the asker’s ceiling (ADR 0037, KF-SAS-RQ-222)', () => {
  it('counts the matches within the ceiling that no grant reaches, and nothing above it', async () => {
    const answer = await composeSearch(
      run,
      SCOPE(),
      { text: 'valve' },
      { grants: grantsOf(coverageOf([granted])) },
    );
    // Three records match "valve": one above the ceiling, one within it and ungranted, one granted.
    expect(answer.lexical.hits.map((hit) => hit.objectId)).toEqual([granted]);
    expect(answer.withheldCount, 'only the middle group').toBe(1);
    expect(JSON.stringify(answer)).not.toContain(ungranted);
    expect(JSON.stringify(answer)).not.toContain('torque');
  });

  it('changes with the grants, with no stored row between', async () => {
    // Stored nowhere: every table a count could have been written to holds what it held before.
    const stored = async () =>
      withTransaction(h.adminPool, (tx) =>
        tx.one<{ rows: string }>(
          `select ((select count(*) from search.recorded_query)
                 + (select count(*) from retrieval.disclosure)
                 + (select count(*) from search.demand_contribution)
                 + (select count(*) from org.access_demand))::text as rows`,
        ),
      );
    const before = await stored();
    const withGrant = await composeSearch(
      run,
      SCOPE(),
      { text: 'valve' },
      { grants: grantsOf(coverageOf([granted, ungranted])) },
    );
    const without = await composeSearch(
      run,
      SCOPE(),
      { text: 'valve' },
      { grants: grantsOf(coverageOf([granted])) },
    );
    expect(withGrant.withheldCount).toBe(0);
    expect(without.withheldCount).toBe(1);
    expect(await stored()).toEqual(before);

    // A reclassification is reflected on the next query: the middle record moves above the
    // ceiling, and is no longer counted, because it is no longer the caller's to be told about.
    await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f);
      await tx.query(
        `update core.object set classification = 'restricted', row_version = row_version + 1 where id = $1`,
        [ungranted],
      );
      await indexObject(tx, ungranted);
    });
    const reclassified = await composeSearch(
      run,
      SCOPE(),
      { text: 'valve' },
      { grants: grantsOf(coverageOf([granted])) },
    );
    expect(reclassified.withheldCount).toBe(0);
  });
});

describe('a recorded query replayed higher shows what the asker’s ceiling withheld (§64B)', () => {
  it('returns the withheld records to the replayer and counts the asker once, storing no delta', async () => {
    const recorded = await run((tx) => recordQuery(tx, 'relief valve'));
    expect(recorded).toBeDefined();

    const replayAt = (grants: readonly string[]) =>
      withTransaction(h.pool, async (tx) => {
        await bindReader(tx, f, f.reviewerId, 'restricted');
        return replayRecordedQuery(
          tx,
          { organizationId: f.organizationId, maxClassification: 'restricted' },
          grantsOf(coverageOf(grants)),
          recorded!,
        );
      });

    const first = await replayAt([above, granted]);
    expect(first?.askerCeiling).toBe('internal');
    // Two records now sit above the asker's `internal` ceiling and match: `above`, and `ungranted`
    // since the reclassification above. Only the one the replayer may read is shown.
    expect(first?.withheld.map((hit) => hit.objectId)).toEqual([above]);
    expect(first?.counted).toBe(1);
    expect((await replayAt([above, granted]))?.counted, 'the same asker is counted once').toBe(0);

    const demand = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ object_id: string; distinct_person_count: number }>(
        'select object_id, distinct_person_count from org.access_demand',
      ),
    );
    expect(demand).toEqual([{ object_id: above, distinct_person_count: 1 }]);
  });

  it('shows nothing to a replayer cleared below the asker', async () => {
    const recorded = await withTransaction(h.pool, async (tx) => {
      await bindReader(tx, f, f.reviewerId, 'restricted');
      return recordQuery(tx, 'relief valve');
    });
    const replay = await run((tx) =>
      replayRecordedQuery(tx, SCOPE(), grantsOf(coverageOf([granted])), recorded!),
    );
    expect(replay).toBeUndefined();
  });
});
