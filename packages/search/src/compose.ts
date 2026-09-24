/**
 * One query, two rankings, composed rather than merged (§64A, KF-SAS-RQ-213, RQ-216, RQ-217,
 * RQ-219, RQ-222, RQ-224, ADR 0037).
 *
 * Lexical search answers "every record naming SOP-QMS-012", exhaustively. Semantic search answers
 * "records about this", and cannot be exhaustive by construction. A merged order would destroy the
 * first property, because a semantically near record sits in the same list as the complete lexical
 * answer and looks identical to it — so the two are returned as two lists, each naming the ranking
 * that produced it.
 *
 * The semantic list comes from an engine KF does not trust with authorization. It scored under a
 * mask built from live rows, and every id it returns is still re-read here under the caller's row
 * security and grants before anything is shown. An id that fails means the mask was wrong; the
 * whole list is then refused, because a list with the bad id quietly removed is a short list, and a
 * caller cannot tell a short list from a complete one.
 */

import type { Tx } from '@kf/database';
import type { RecordVerification } from '@kf/domain';
import {
  matchesIn,
  searchAmong,
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

export const LEXICAL_RANKING = 'kf.lexical.full_text+partial_identifier.v1' as const;
export const NEAR_MISS_LABEL = 'near_miss';

/** How the near-miss window is chosen. Named in every response that carries one (RQ-217). */
export function nearMissScoringFunction(ranking: string, k: number): string {
  return `kf.near-miss.rank-window.v1(${ranking}; ranks ${k + 1}-${2 * k})`;
}

export interface ComposedSearch {
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

  const { matches, granted, hits } = await run(async (tx) => {
    // The match set under row security stops at the caller's ceiling, so the withheld count can
    // only ever describe records the caller is cleared for (ADR 0037).
    const matched = await matchesIn(tx, scope, query);
    const reached = matched.filter((m) => options.grants.reaches(m.objectId, m.classification));
    const page =
      reached.length === 0
        ? []
        : await searchAmong(
            tx,
            scope,
            query,
            reached.map((m) => m.objectId),
          );
    if (options.record === true) await recordQuery(tx, text);
    return { matches: matched, granted: reached, hits: page };
  });
  const lexical: ComposedSearch['lexical'] = {
    ranking: LEXICAL_RANKING,
    exhaustive: true as const,
    total: granted.length,
    complete: hits.length === granted.length,
    hits,
  };
  const withheldCount = matches.length - granted.length;

  if (text === '') return { lexical, withheld: [], withheldCount };
  if (options.semantic === undefined) {
    return {
      lexical,
      withheld: [unavailable('no retrieval engine is configured')],
      withheldCount,
    };
  }

  const outcome = await options.semantic.rank(run, {
    organizationId: scope.organizationId,
    clearance: scope.maxClassification,
    query: text,
    k: options.nearMisses === true ? 2 * k : k,
  });
  if (outcome.status !== 'ranked') {
    return { lexical, withheld: [unavailable(outcome.reason)], withheldCount };
  }

  const checked = await run(async (tx) => {
    const result = await recheck(tx, scope, outcome, options.grants);
    if ('refused' in result) return result;
    const served = result.hits.slice(0, k);
    const near = options.nearMisses === true ? result.hits.slice(k, 2 * k) : [];
    // What was disclosed, as the digest of the engine's trace (RQ-219). In the same transaction
    // as the re-check: a disclosure that could not be recorded is not made.
    await tx.query('select retrieval.record_disclosure($1, $2, $3)', [
      outcome.traceDigest,
      served.length,
      near.length,
    ]);
    return { semanticHits: served, adjacent: near };
  });
  if ('refused' in checked) {
    return { lexical, withheld: [unavailable(checked.refused)], withheldCount };
  }
  const { semanticHits, adjacent } = checked;

  return {
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
