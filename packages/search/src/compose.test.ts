import { describe, expect, it, vi } from 'vitest';
import type { Tx } from '@kf/database';
import { UNVERIFIED_LABEL } from '@kf/domain';
import {
  composeSearch,
  FUSION_K,
  fuse,
  LEXICAL_RANKING,
  type SemanticOutcome,
  type SemanticRanker,
} from './compose.js';

/**
 * The composition's own rules, against a fake database (the live-row behaviour is in
 * tests/integration/semantic-search.test.ts): one fused list beside the two named source lists
 * (KF-SAS-RQ-224), a withholding entry whenever there is no semantic list (RQ-216), near misses
 * only on request (RQ-217), and one withheld count (ADR 0037).
 */

interface Row {
  readonly id: string;
  readonly classification: string;
  readonly title: string;
}

const ROWS: readonly Row[] = [
  { id: 'a', classification: 'internal', title: 'Alpha valve' },
  { id: 'b', classification: 'internal', title: 'Beta valve' },
  { id: 'c', classification: 'internal', title: 'Gamma seal' },
];

/** A database that matches every row on any text, and knows every row on a re-check. */
function database() {
  const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes('/* search.semantic-recheck */')) {
      const ids = params[0] as string[];
      return ROWS.filter((row) => ids.includes(row.id)).map((row) => ({
        object_id: row.id,
        object_type: 'decision_record',
        title: row.title,
        lifecycle_state: 'draft',
        classification: row.classification,
        record_visible: true,
        verified_at: null,
        verified_by: null,
        verification_basis: null,
      }));
    }
    if (sql.includes('/* search.lexical-matches */')) {
      const only = params[5] as string[] | null;
      return ROWS.filter((row) => only === null || only.includes(row.id)).map((row, index) => ({
        object_id: row.id,
        classification: row.classification,
        coverage: 1 - index / 10,
        matched_by: 'full_text',
      }));
    }
    if (sql.includes('/* search.lexical-page */')) {
      const ids = params[0] as string[];
      return ROWS.filter((row) => ids.includes(row.id)).map((row) => ({
        object_id: row.id,
        object_type: 'decision_record',
        title: row.title,
        lifecycle_state: 'draft',
        classification: row.classification,
        phrase: false,
        text_rank: 0.1,
        record_visible: true,
        verified_at: null,
        verified_by: null,
        verification_basis: null,
      }));
    }
    return [];
  });
  const tx = { query, one: vi.fn() } as unknown as Tx;
  const run = <T>(fn: (inner: Tx) => Promise<T>): Promise<T> => fn(tx);
  return { run, query };
}

const SCOPE = { organizationId: 'org', maxClassification: 'internal' };
const GRANTED_A_AND_B = { reaches: (id: string) => id === 'a' || id === 'b' };

function engine(outcome: SemanticOutcome): SemanticRanker & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    rank: async (_run, request) => {
      calls.push(request.k);
      return outcome;
    },
  };
}

const RANKED = (ids: string[]): SemanticOutcome => ({
  status: 'ranked',
  hits: ids.map((objectId, index) => ({ objectId, score: 1 - index / 10, rank: index + 1 })),
  traceDigest: 'sha256:0011223344556677',
  ranking: 'stub.cosine.v1',
});

describe('composeSearch', () => {
  it('returns the lexical list alone with a withholding entry when no engine is configured', async () => {
    const { run } = database();
    const answer = await composeSearch(run, SCOPE, { text: 'valve' }, { grants: GRANTED_A_AND_B });
    expect(answer.lexical.hits.map((hit) => hit.objectId)).toEqual(['a', 'b']);
    expect(answer.semantic).toBeUndefined();
    expect(answer.withheld).toEqual([
      { reasonClass: 'semantic_ranking_unavailable', reason: 'no retrieval engine is configured' },
    ]);
    expect(answer.withheldCount).toBe(1);
    // With no engine the fused list is the lexical page, and its name says it fused nothing else.
    expect(answer.ranked.ranking).toBe(
      `kf.fused.rrf.v2(k=60; lexical vote=(coverage-0.5)/0.5; ${LEXICAL_RANKING})`,
    );
    expect(answer.ranked.hits.map((hit) => hit.objectId)).toEqual(['a', 'b']);
  });

  it('serves one fused list that names both rankings and where each placed every record', async () => {
    const { run } = database();
    const answer = await composeSearch(
      run,
      SCOPE,
      { text: 'valve' },
      { grants: GRANTED_A_AND_B, semantic: engine(RANKED(['b', 'a'])) },
    );
    expect(answer.ranked.ranking).toBe(
      `kf.fused.rrf.v2(k=60; lexical vote=(coverage-0.5)/0.5; ${LEXICAL_RANKING}; stub.cosine.v1)`,
    );
    expect(answer.ranked.hits).toHaveLength(2);
    // Each record is first on one list and second on the other: equal scores, and the tie goes to
    // the lexical place.
    expect(
      answer.ranked.hits.map((hit) => [hit.objectId, hit.lexical?.rank, hit.semantic?.rank]),
    ).toEqual([
      ['a', 1, 2],
      ['b', 2, 1],
    ]);
    expect(answer.ranked.hits[0]!.score).toBeCloseTo(1 / 61 + 1 / 62, 12);
  });

  it('never fuses a semantic list the re-check refused', async () => {
    const { run } = database();
    const answer = await composeSearch(
      run,
      SCOPE,
      { text: 'valve' },
      { grants: GRANTED_A_AND_B, semantic: engine(RANKED(['c', 'a'])) },
    );
    expect(answer.ranked.hits.map((hit) => hit.objectId)).toEqual(['a', 'b']);
    expect(answer.ranked.hits.every((hit) => hit.semantic === undefined)).toBe(true);
    expect(JSON.stringify(answer.ranked)).not.toContain('Gamma');
  });

  it('keeps the two rankings in separate, named lists', async () => {
    const { run } = database();
    const answer = await composeSearch(
      run,
      SCOPE,
      { text: 'valve' },
      { grants: GRANTED_A_AND_B, semantic: engine(RANKED(['b', 'a'])) },
    );
    expect(answer.lexical.ranking).toBe(LEXICAL_RANKING);
    expect(answer.semantic?.ranking).toBe('stub.cosine.v1');
    expect(answer.semantic?.hits.map((hit) => hit.objectId)).toEqual(['b', 'a']);
    expect(answer.withheld).toEqual([]);
  });

  it('carries the engine’s refusal as a withholding entry, never a partial list', async () => {
    const { run } = database();
    const answer = await composeSearch(
      run,
      SCOPE,
      { text: 'valve' },
      {
        grants: GRANTED_A_AND_B,
        semantic: engine({ status: 'unavailable', reason: 'engine did not answer within 2000ms' }),
      },
    );
    expect(answer.semantic).toBeUndefined();
    expect(answer.withheld).toEqual([
      {
        reasonClass: 'semantic_ranking_unavailable',
        reason: 'engine did not answer within 2000ms',
      },
    ]);
  });

  it('refuses the whole semantic list when one id is outside the grants', async () => {
    const { run } = database();
    const answer = await composeSearch(
      run,
      SCOPE,
      { text: 'valve' },
      { grants: GRANTED_A_AND_B, semantic: engine(RANKED(['a', 'c'])) },
    );
    expect(answer.semantic).toBeUndefined();
    expect(answer.withheld[0]?.reason).toMatch(/outside the caller's mask/);
    expect(JSON.stringify(answer)).not.toContain('Gamma');
  });

  it('asks for twice as many and labels the rest only when near misses are requested', async () => {
    const { run } = database();
    const asked = engine(RANKED(['a', 'b']));
    const answer = await composeSearch(
      run,
      SCOPE,
      { text: 'valve', limit: 1 },
      { grants: GRANTED_A_AND_B, semantic: asked, nearMisses: true },
    );
    expect(asked.calls).toEqual([2]);
    expect(answer.semantic?.hits.map((hit) => hit.objectId)).toEqual(['a']);
    expect(answer.nearMisses?.label).toBe('near_miss');
    expect(answer.nearMisses?.scoringFunction).toBe(
      'kf.near-miss.rank-window.v1(stub.cosine.v1; ranks 2-2)',
    );
    expect(answer.nearMisses?.hits.map((hit) => hit.objectId)).toEqual(['b']);

    const unasked = engine(RANKED(['a', 'b']));
    const plain = await composeSearch(
      run,
      SCOPE,
      { text: 'valve', limit: 1 },
      { grants: GRANTED_A_AND_B, semantic: unasked },
    );
    expect(unasked.calls).toEqual([1]);
    expect(plain.nearMisses).toBeUndefined();
    expect(plain.semantic?.hits.map((hit) => hit.objectId)).toEqual(['a']);
  });
});

describe('fuse (reciprocal rank fusion)', () => {
  const verification = { verified: false, label: UNVERIFIED_LABEL } as const;
  // A lexical hit's `rank` is its coverage: the share of the query it holds. 1 votes fully.
  const hit = (
    objectId: string,
    coverage = 1,
    matchedBy: 'full_text' | 'partial_identifier' = 'full_text',
  ) => ({
    objectId,
    objectType: 'artifact',
    title: objectId.toUpperCase(),
    lifecycleState: 'draft',
    classification: 'internal',
    rank: coverage,
    score: 0,
    matchedBy,
    verification,
  });

  it('puts a record both rankings found above records only one found', () => {
    const fused = fuse([hit('x'), hit('y'), hit('both')], [hit('both'), hit('z')], 10);
    expect(fused[0]!.objectId).toBe('both');
    expect(fused[0]!.score).toBeCloseTo(1 / (FUSION_K + 3) + 1 / (FUSION_K + 1), 12);
    expect(fused.map((h) => h.rank)).toEqual([1, 2, 3, 4]);
  });

  it('weighs a word match by its share of the query above the floor (SAS §100.45)', () => {
    // Half the question, first by its words: it votes nothing, and the semantic list's first
    // record leads. Plain RRF would have tied them and put the word match first.
    const half = fuse([hit('half', 0.5), hit('most', 0.9)], [hit('meaning'), hit('most')], 10);
    expect(half.map((h) => h.objectId)).toEqual(['most', 'meaning', 'half']);
    expect(half[0]!.score).toBeCloseTo(0.8 / (FUSION_K + 2) + 1 / (FUSION_K + 2), 12);
    expect(half[2]!.score).toBe(0);
    // A partial identifier votes fully: it is what an identifier's fragment is looked for by.
    const identifier = fuse([hit('cnb', 0.2, 'partial_identifier')], [hit('other')], 10);
    expect(identifier[0]!.score).toBeCloseTo(1 / (FUSION_K + 1), 12);
    // Nothing to fuse with: the lexical page keeps its own order, whatever the votes.
    const alone = fuse([hit('a', 0.5), hit('b', 0.9), hit('c', 0.2, 'partial_identifier')], [], 10);
    expect(alone.map((h) => h.objectId)).toEqual(['a', 'b', 'c']);
  });

  it('is a function of the two lists alone, cuts at k, and adds no record', () => {
    const lexical = [hit('a'), hit('b'), hit('c')];
    const semantic = [hit('d'), hit('b')];
    const once = fuse(lexical, semantic, 3);
    expect(once).toEqual(fuse(lexical, semantic, 3));
    expect(once).toHaveLength(3);
    for (const h of once) expect(['a', 'b', 'c', 'd']).toContain(h.objectId);
    expect(fuse([], [], 5)).toEqual([]);
  });
});
