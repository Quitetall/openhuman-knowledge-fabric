import { describe, expect, it, vi } from 'vitest';
import type { Tx } from '@kf/database';
import { composeSearch, type SemanticOutcome, type SemanticRanker } from './compose.js';

/**
 * The composition's own rules, against a fake database (the live-row behaviour is in
 * tests/integration/semantic-search.test.ts): two lists never merged (KF-SAS-RQ-224), a
 * withholding entry whenever there is no semantic list (RQ-216), near misses only on request
 * (RQ-217), and one withheld count (ADR 0037).
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
    if (sql.includes('with visible as')) {
      const only = params[5] as string[] | null;
      const rows = ROWS.filter((row) => only === null || only.includes(row.id));
      if (params.length === 6) {
        return rows.map((row) => ({ object_id: row.id, classification: row.classification }));
      }
      return rows.map((row) => ({
        object_id: row.id,
        object_type: 'decision_record',
        title: row.title,
        lifecycle_state: 'draft',
        classification: row.classification,
        rank: 0.5,
        matched_by: 'full_text',
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
  });

  it('keeps the two rankings in separate, named lists', async () => {
    const { run } = database();
    const answer = await composeSearch(
      run,
      SCOPE,
      { text: 'valve' },
      { grants: GRANTED_A_AND_B, semantic: engine(RANKED(['b', 'a'])) },
    );
    expect(answer.lexical.ranking).toBe('kf.lexical.full_text+partial_identifier.v1');
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
