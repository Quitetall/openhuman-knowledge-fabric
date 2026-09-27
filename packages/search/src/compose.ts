/**
 * One query, two rankings, and one list fused from them (§64A, KF-SAS-RQ-213, RQ-216, RQ-217,
 * RQ-219, RQ-222, RQ-224, ADR 0037).
 *
 * Lexical search answers "every record naming SOP-QMS-012", exhaustively. Semantic search answers
 * "records about this", and cannot be exhaustive by construction. People read one list, and two
 * lists shown one after the other lost to semantic ranking alone (Véracier recall@10 0.1767 served
 * as two lists against 0.1866 for the semantic list by itself, 2026-09-25): the lexical list took
 * the first places whether or not its records were the better ones.
 *
 * So the answer leads with `ranked`: the two rankings fused by reciprocal rank fusion (Cormack,
 * Clarke and Büttcher, SIGIR 2009) with its published constant k = 60, not a value fitted here.
 * A record's fused score is the sum over the lists it appears in of 1 / (60 + its rank there),
 * which needs no comparison between the lexical score and the engine's, and every fused hit says
 * which list placed it where. The two source lists are still returned beside it: `lexical` is the
 * exhaustive answer (its `total`, and the page), `semantic` the engine's, each under the name of
 * its ranking; a merged order never replaces the exhaustive one, it is offered first.
 *
 * The semantic list comes from an engine KF does not trust with authorization. It scored under a
 * mask built from live rows, and every id it returns is still re-read here under the caller's row
 * security and grants before anything is shown. An id that fails means the mask was wrong; the
 * whole list is then refused — and the fused list is the lexical list alone — because a list with
 * the bad id quietly removed is a short list, and a caller cannot tell a short list from a
 * complete one.
 */

import type { Tx } from '@kf/database';
import type { RecordVerification } from '@kf/domain';
import {
  pageOf,
  rankedMatchesIn,
  verificationOf,
  type SearchHit,
  type SearchQuery,
  type SearchScope,
} from './index.js';
import { recordQuery } from './transient.js';

/** Whether a grant reaches a record at a classification — the caller's coverage, as a predicate. */
export interface ReadGrants {
  reaches(objectId: string, classification: string): boolean;
}

export type SemanticOutcome =
  | {
      readonly status: 'ranked';
      readonly hits: readonly {
        readonly objectId: string;
        readonly score: number;
        readonly rank: number;
      }[];
      readonly traceDigest: string;
      readonly ranking: string;
    }
  | { readonly status: 'unavailable'; readonly reason: string };

/**
 * Runs `fn` in a short transaction of its own with the caller's access context bound. The
 * composition takes one rather than a transaction, so that no transaction is open while the
 * retrieval engine works (ADR 0028).
 */
export type TransactionRunner = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

/**
 * A retrieval engine, as search sees it. `@kf/retrieval`'s `SemanticRetrieval`, closed over the
 * caller's coverage by the composition root, is the production one; tests supply their own.
 */
export interface SemanticRanker {
  rank(
    run: TransactionRunner,
    request: {
      readonly organizationId: string;
      readonly clearance: string;
      readonly query: string;
      readonly k: number;
    },
  ): Promise<SemanticOutcome>;
}

/** An omission, with its basis (§63, KF-SAS-RQ-120). */
export interface WithholdingEntry {
  readonly reasonClass: 'semantic_ranking_unavailable';
  readonly reason: string;
}

export interface SemanticHit {
  readonly objectId: string;
  readonly objectType: string;
  readonly title: string;
  readonly lifecycleState: string;
  readonly classification: string;
  readonly rank: number;
  readonly score: number;
  readonly verification: RecordVerification;
}

export const LEXICAL_RANKING =
  'kf.lexical.idf_coverage(floor=0.5)+phrase+partial_identifier.v2' as const;

/** Reciprocal rank fusion's constant, as published (Cormack, Clarke and Büttcher, 2009). */
export const FUSION_K = 60;

/** The fused ranking's name: the method, its constant, and the rankings it fused (RQ-224). */
export function fusedRankingName(lexical: string, semantic?: string): string {
  return semantic === undefined
    ? `kf.fused.rrf.v1(k=${FUSION_K}; ${lexical})`
    : `kf.fused.rrf.v1(k=${FUSION_K}; ${lexical}; ${semantic})`;
}

/** A record in the fused list, saying where each ranking placed it. */
export interface FusedHit {
  readonly objectId: string;
  readonly objectType: string;
  readonly title: string;
  readonly lifecycleState: string;
  readonly classification: string;
  /** Place in the fused list, from 1. */
  readonly rank: number;
  /** Σ 1 / (FUSION_K + rank) over the lists the record is in. */
  readonly score: number;
  /** Its place in the lexical page, when it is there, and how it matched. */
  readonly lexical?: { readonly rank: number; readonly matchedBy: SearchHit['matchedBy'] };
  /** Its place in the re-checked semantic list, when it is there. */
  readonly semantic?: { readonly rank: number };
  readonly verification: RecordVerification;
}
export const NEAR_MISS_LABEL = 'near_miss';

/** How the near-miss window is chosen. Named in every response that carries one (RQ-217). */
export function nearMissScoringFunction(ranking: string, k: number): string {
  return `kf.near-miss.rank-window.v1(${ranking}; ranks ${k + 1}-${2 * k})`;
}

export interface ComposedSearch {
  /**
   * The one list to read first: the lexical page and the re-checked semantic list, fused. Without
   * a semantic list it is the lexical page in its own order, and `ranking` says so.
   */
  readonly ranked: { readonly ranking: string; readonly hits: readonly FusedHit[] };
  readonly lexical: {
    readonly ranking: typeof LEXICAL_RANKING;
    /** The lexical list is complete within its scope; `complete` says whether this page is all of it. */
    readonly exhaustive: true;
    readonly total: number;
    readonly complete: boolean;
    readonly hits: readonly SearchHit[];
  };
  /** Present only when the engine answered and every id survived the re-check. */
  readonly semantic?: { readonly ranking: string; readonly hits: readonly SemanticHit[] };
  /** Present only when asked for, and only alongside a semantic list. */
  readonly nearMisses?: {
    readonly label: typeof NEAR_MISS_LABEL;
    readonly scoringFunction: string;
    readonly hits: readonly SemanticHit[];
  };
  readonly withheld: readonly WithholdingEntry[];
  /**
   * Records at or below the caller's ceiling that match the lexical query and that no grant
   * reaches (ADR 0037). Computed now, stored nowhere; nothing above the ceiling is ever counted.
   */
  readonly withheldCount: number;
}

export interface ComposeOptions {
  readonly grants: ReadGrants;
  /** Absent: no engine is configured, and the answer says so. */
  readonly semantic?: SemanticRanker;
  /** Near misses are returned only when asked for (RQ-217). */
  readonly nearMisses?: boolean;
  /** Record the query as a transient observation (§64B) in the lexical transaction. */
  readonly record?: boolean;
}

const DEFAULT_LIMIT = 50;
const TRACE_DIGEST = /^[A-Za-z0-9:+/=_.-]{8,255}$/u;

function unavailable(reason: string): WithholdingEntry {
  return { reasonClass: 'semantic_ranking_unavailable', reason };
}

/**
 * Compose one answer. `run` binds the caller's access context in every transaction it opens.
 *
 * Three phases: the lexical answer and the withheld count in one transaction; the engine, with no
 * transaction open; the re-check of the engine's ids and the disclosure digest in another.
 */
export async function composeSearch(
  run: TransactionRunner,
  scope: SearchScope,
  query: SearchQuery,
  options: ComposeOptions,
): Promise<ComposedSearch> {
  const text = query.text.trim();
  const k = Math.max(1, query.limit ?? DEFAULT_LIMIT);

  const { matched, granted, hits } = await run(async (tx) => {
    // The match set under row security stops at the caller's ceiling, so the withheld count can
    // only ever describe records the caller is cleared for (ADR 0037). It is scored once; the
    // page is cut from the part of it the caller's grants reach.
    const all = await rankedMatchesIn(tx, scope, query);
    const reached = all.filter((m) => options.grants.reaches(m.objectId, m.classification));
    const page = reached.length === 0 ? [] : await pageOf(tx, query, reached);
    if (options.record === true) await recordQuery(tx, text);
    return { matched: all.length, granted: reached.length, hits: page };
  });
  const lexical: ComposedSearch['lexical'] = {
    ranking: LEXICAL_RANKING,
    exhaustive: true as const,
    total: granted,
    complete: hits.length === granted,
    hits,
  };
  const withheldCount = matched - granted;
  const lexicalOnly = (withheld: readonly WithholdingEntry[]): ComposedSearch => ({
    ranked: { ranking: fusedRankingName(LEXICAL_RANKING), hits: fuse(hits, [], k) },
    lexical,
    withheld,
    withheldCount,
  });

  if (text === '') return lexicalOnly([]);
  if (options.semantic === undefined) {
    return lexicalOnly([unavailable('no retrieval engine is configured')]);
  }

  const outcome = await options.semantic.rank(run, {
    organizationId: scope.organizationId,
    clearance: scope.maxClassification,
    query: text,
    k: options.nearMisses === true ? 2 * k : k,
  });
  if (outcome.status !== 'ranked') return lexicalOnly([unavailable(outcome.reason)]);

  const checked = await run(async (tx) => {
    const result = await recheck(tx, scope, outcome, options.grants);
    if ('refused' in result) return result;
    const served = result.hits.slice(0, k);
    const near = options.nearMisses === true ? result.hits.slice(k, 2 * k) : [];
    // What was disclosed, as the digest of the engine's trace (RQ-219). In the same transaction
    // as the re-check: a disclosure that could not be recorded is not made. The fused list shows
    // no semantic hit that is not among these.
    await tx.query('select retrieval.record_disclosure($1, $2, $3)', [
      outcome.traceDigest,
      served.length,
      near.length,
    ]);
    return { semanticHits: served, adjacent: near };
  });
  if ('refused' in checked) return lexicalOnly([unavailable(checked.refused)]);
  const { semanticHits, adjacent } = checked;

  return {
    ranked: {
      ranking: fusedRankingName(LEXICAL_RANKING, outcome.ranking),
      hits: fuse(hits, semanticHits, k),
    },
    lexical,
    semantic: { ranking: outcome.ranking, hits: semanticHits },
    ...(options.nearMisses === true
      ? {
          nearMisses: {
            label: NEAR_MISS_LABEL,
            scoringFunction: nearMissScoringFunction(outcome.ranking, k),
            hits: adjacent,
          },
        }
      : {}),
    withheld: [],
    withheldCount,
  };
}

/**
 * Reciprocal rank fusion of the lexical page and the re-checked semantic list, first `k`.
 *
 * Ranks are places in each list as served, from 1. Ties (equal score) go to the better single
 * place, then to the lexical place, then to the record id, so the order is a function of the two
 * lists and nothing else. Only records already on one of the two lists can appear: fusion adds no
 * record and removes none that it had room for.
 */
export function fuse(
  lexical: readonly SearchHit[],
  semantic: readonly SemanticHit[],
  k: number,
): FusedHit[] {
  interface Entry {
    base: Omit<FusedHit, 'rank' | 'score' | 'lexical' | 'semantic'>;
    lexical?: { rank: number; matchedBy: SearchHit['matchedBy'] };
    semantic?: { rank: number };
  }
  const entries = new Map<string, Entry>();
  const baseOf = (hit: SearchHit | SemanticHit): Entry['base'] => ({
    objectId: hit.objectId,
    objectType: hit.objectType,
    title: hit.title,
    lifecycleState: hit.lifecycleState,
    classification: hit.classification,
    verification: hit.verification,
  });
  lexical.forEach((hit, index) => {
    const entry = entries.get(hit.objectId) ?? { base: baseOf(hit) };
    entry.lexical ??= { rank: index + 1, matchedBy: hit.matchedBy };
    entries.set(hit.objectId, entry);
  });
  semantic.forEach((hit, index) => {
    const entry = entries.get(hit.objectId) ?? { base: baseOf(hit) };
    entry.semantic ??= { rank: index + 1 };
    entries.set(hit.objectId, entry);
  });
  const scored = [...entries.values()].map((entry) => {
    const places = [entry.lexical?.rank, entry.semantic?.rank].filter(
      (rank): rank is number => rank !== undefined,
    );
    return {
      entry,
      score: places.reduce((sum, rank) => sum + 1 / (FUSION_K + rank), 0),
      best: Math.min(...places),
    };
  });
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.best - b.best ||
      (a.entry.lexical?.rank ?? Infinity) - (b.entry.lexical?.rank ?? Infinity) ||
      (a.entry.base.objectId < b.entry.base.objectId ? -1 : 1),
  );
  return scored.slice(0, k).map(({ entry, score }, index) => ({
    ...entry.base,
    rank: index + 1,
    score,
    ...(entry.lexical === undefined ? {} : { lexical: entry.lexical }),
    ...(entry.semantic === undefined ? {} : { semantic: entry.semantic }),
  }));
}

/**
 * Re-read every id the engine returned, in one statement, under the caller's row security, and
 * then through the caller's grants. Never trusts the engine's ids or its order beyond its ranks.
 */
async function recheck(
  tx: Tx,
  scope: SearchScope,
  outcome: Extract<SemanticOutcome, { status: 'ranked' }>,
  grants: ReadGrants,
): Promise<{ readonly hits: SemanticHit[] } | { readonly refused: string }> {
  if (!TRACE_DIGEST.test(outcome.traceDigest)) {
    return { refused: 'engine returned a trace digest this Fabric cannot record' };
  }
  const ordered = [...outcome.hits].sort((a, b) => a.rank - b.rank);
  const ids = ordered.map((hit) => hit.objectId);
  if (new Set(ids).size !== ids.length) {
    return { refused: 'engine returned the same record twice' };
  }
  if (ids.length === 0) return { hits: [] };

  const rows = await tx.query<{
    object_id: string;
    object_type: string;
    title: string;
    lifecycle_state: string;
    classification: string;
    record_visible: boolean;
    verified_at: Date | null;
    verified_by: string | null;
    verification_basis: string | null;
  }>(
    `select /* search.semantic-recheck */
            d.object_id, d.object_type, d.title, d.lifecycle_state, o.classification,
            o.id is not null as record_visible,
            v.verified_at, v.verified_by, v.basis as verification_basis
       from search.document d
       join core.object o on o.id = d.object_id
       join registry.classification c on c.id = o.classification
       join registry.classification mine on mine.id = $3
       left join core.object_verification v on v.object_id = o.id
      where d.object_id = any($1::uuid[])
        and d.organization_id = $2
        and o.organization_id = $2
        and c.rank <= mine.rank`,
    [ids, scope.organizationId, scope.maxClassification],
  );
  const byId = new Map(rows.map((row) => [row.object_id, row]));

  const outside = ids.filter((id) => {
    const row = byId.get(id);
    return row === undefined || !grants.reaches(id, row.classification);
  });
  if (outside.length > 0) {
    // Not which ones: the ids are the engine's, and naming them to the caller would disclose the
    // very records the mask was meant to hide.
    return {
      refused:
        `engine returned ${outside.length} record(s) outside the caller's mask; the semantic ` +
        'ranking is refused rather than shortened',
    };
  }

  return {
    hits: ordered.map((hit) => {
      const row = byId.get(hit.objectId)!;
      return {
        objectId: hit.objectId,
        objectType: row.object_type,
        title: row.title,
        lifecycleState: row.lifecycle_state,
        classification: row.classification,
        rank: hit.rank,
        score: hit.score,
        verification: verificationOf(row),
      };
    }),
  };
}
