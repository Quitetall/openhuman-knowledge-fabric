/**
 * Search over the derived index.
 *
 * The index holds every record; who may see what is decided on the same two axes as the
 * records themselves, in two places: row-level security on `search.document`, and the
 * explicit predicate in the query below. One index, many audiences — the alternative is an
 * index per clearance, which is several copies of the records with several ways to drift.
 *
 * Two places rather than one because the table is reachable by more than this function:
 * kf_readonly and kf_auditor hold `select` on it and connect directly, and until
 * `20260816000100_search_visibility_boundary.sql` the query-time rule was the only rule
 * there was — so for those roles there was no rule at all.
 *
 * Two query paths, because they fail differently:
 *
 *   Full text answers "records about leakage current". It stems, it ranks, and it is useless
 *   for a part number, because a tokeniser splits `CNB-2201` in ways nobody expects.
 *
 *   Trigram answers "records mentioning CNB-22". It is how people actually look for a thing
 *   they half-remember, and full text cannot do it at all.
 *
 * Both are exhaustive within their scope and both can explain themselves. That is the property
 * an embedding index does not have, and the reason canonical search comes first.
 */

import type { Pool, Tx } from '@kf/database';
import { bindPrincipal, withTransaction, type Principal } from '@kf/database';
import { recordVerification, type RecordVerification } from '@kf/domain';

export interface SearchScope {
  readonly organizationId: string;
  /** The highest classification this caller may see. Never widened by omission. */
  readonly maxClassification: string;
  /** The caller's attestation that they are present (20260924001000); see `Principal`. */
  readonly attestation?: string | undefined;
}

export interface SearchQuery {
  readonly text: string;
  readonly objectTypes?: readonly string[];
  readonly lifecycleStates?: readonly string[];
  readonly limit?: number;
}

export interface SearchHit {
  readonly objectId: string;
  readonly objectType: string;
  readonly title: string;
  readonly lifecycleState: string;
  readonly classification: string;
  readonly rank: number;
  /** Which path matched. Shown to the caller, because "why did this come back" is a real question. */
  readonly matchedBy: 'full_text' | 'partial_identifier';
  /**
   * Whether anybody has verified the record, with the label a reader is shown (KF-SAS-RQ-229).
   * A hit is a place a record appears, so an unverified one says so here too. Read under the
   * caller's row security: `core.object_verification` defers to `core.object`, so nothing is
   * learned about a record the caller cannot see.
   */
  readonly verification: RecordVerification;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * A websearch-syntax query, or nothing.
 *
 * `websearch_to_tsquery` never throws on malformed input — unlike `to_tsquery`, which raises
 * on a stray operator and would turn a user's typo into a 500.
 */
function normalise(text: string): string {
  return text.trim();
}

export async function search(
  pool: Pool,
  scope: SearchScope & Pick<Principal, 'actorId' | 'actingRoleId'>,
  query: SearchQuery,
): Promise<SearchHit[]> {
  return withTransaction(pool, async (tx) => {
    // The scope is bound as the access context as well as passed to the query.
    //
    // `search.document` now carries row-level security on the same two axes, so a session
    // with no context bound sees nothing at all — which is the correct default, and the
    // reason this has to be set rather than assumed. This function owns its transaction, so
    // a transaction-local setting cannot reach anything else.
    //
    // `searchIn` deliberately does NOT do this: there the caller owns the transaction and has
    // already bound its own context, and overwriting it from a search argument would let one
    // query silently redefine the visibility of everything after it.
    await bindPrincipal(tx, scope);
    return searchIn(tx, scope, query);
  });
}

/**
 * The same search inside an existing transaction.
 *
 * The caller is responsible for having bound the access context — every production caller
 * (`apps/api` search route, `@kf/agent-tools`' scoped readers) does so from the same identity
 * it derives this scope from.
 */
export async function searchIn(
  tx: Tx,
  scope: SearchScope,
  query: SearchQuery,
): Promise<SearchHit[]> {
  return searchAmong(tx, scope, query, undefined);
}

/** One lexical match: a record the query matches, scored before any page is cut. */
export interface LexicalMatch {
  readonly objectId: string;
  readonly classification: string;
  /**
   * The share of the query's information the record holds (0..1): the inverse document frequency
   * of the terms it matches over that of all terms. A full-text match holds at least one half;
   * a partial-identifier match scores below every full-text one.
   */
  readonly coverage: number;
  readonly matchedBy: 'full_text' | 'partial_identifier';
}

/**
 * Every record the query matches that the caller's session can see, scored and unlimited, best
 * first; ties newest first (object ids are time-ordered).
 *
 * One definition of "matches" (`search.lexical_matches`, 20260926100000), shared by the ranked
 * page, by the unranked match set that counts what was withheld (ADR 0037), and by the replay of
 * recorded queries — two definitions would disagree about which records a query found, and the
 * count would describe a different query from the one answered. The function is security invoker:
 * row security on `search.document` applies to it, and it repeats the organization and ceiling
 * predicates, as this module always has.
 */
export async function rankedMatchesIn(
  tx: Tx,
  scope: SearchScope,
  query: SearchQuery,
  only?: readonly string[],
): Promise<LexicalMatch[]> {
  const text = normalise(query.text);
  if (text === '') return [];
  if (only !== undefined && only.length === 0) return [];
  const rows = await tx.query<{
    object_id: string;
    classification: string;
    coverage: number;
    matched_by: string;
  }>(
    `select /* search.lexical-matches */ object_id, classification, coverage, matched_by
       from search.lexical_matches($1, $2, $3, $4::text[], $5::text[], $6::uuid[])
      order by coverage desc, object_id desc`,
    [
      scope.organizationId,
      scope.maxClassification,
      text,
      query.objectTypes === undefined ? null : [...query.objectTypes],
      query.lifecycleStates === undefined ? null : [...query.lifecycleStates],
      only === undefined ? null : [...only],
    ],
  );
  return rows.map((row) => ({
    objectId: row.object_id,
    classification: row.classification,
    coverage: Number(row.coverage),
    matchedBy: row.matched_by === 'full_text' ? 'full_text' : 'partial_identifier',
  }));
}

/**
 * Every record the query matches that the caller's session can see, unranked and unlimited: an
 * id and a classification, nothing else.
 *
 * For counting, never for display. Under row security the set stops at the caller's ceiling, so a
 * count taken from it can never describe a record above that ceiling (ADR 0037).
 */
export async function matchesIn(
  tx: Tx,
  scope: SearchScope,
  query: SearchQuery,
): Promise<{ readonly objectId: string; readonly classification: string }[]> {
  return (await rankedMatchesIn(tx, scope, query)).map((m) => ({
    objectId: m.objectId,
    classification: m.classification,
  }));
}

/**
 * How many tied candidates at the edge of a page are re-scored on their text. Past it, ties keep
 * the match order (newest first): re-scoring reads every candidate's vector, and a one-word query
 * can tie half of a 50 000-record organization.
 */
export const TIE_WINDOW = 2000;

/**
 * The ranked page over matches already found and already narrowed to what the caller may read.
 *
 * Order: coverage; then the whole query as a phrase in one of the record's languages (a boost for
 * the words in the order typed); then PostgreSQL's `ts_rank` over every term, which weighs a
 * title above a body; then the title. Only the candidates that can reach the page are re-scored:
 * every match down to the page's last coverage, capped at TIE_WINDOW.
 */
export async function pageOf(
  tx: Tx,
  query: SearchQuery,
  matches: readonly LexicalMatch[],
): Promise<SearchHit[]> {
  const text = normalise(query.text);
  if (text === '' || matches.length === 0) return [];
  const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const edge = matches[Math.min(limit, matches.length) - 1]!.coverage;
  const window: LexicalMatch[] = [];
  for (const match of matches) {
    if (window.length >= limit && (match.coverage < edge || window.length >= TIE_WINDOW)) break;
    window.push(match);
  }
  const byId = new Map(window.map((m, position) => [m.objectId, { match: m, position }]));

  const rows = await tx.query<{
    object_id: string;
    object_type: string;
    title: string;
    lifecycle_state: string;
    classification: string;
    phrase: boolean;
    text_rank: number;
    record_visible: boolean;
    verified_at: Date | null;
    verified_by: string | null;
    verification_basis: string | null;
    verification_policy_id?: string | null;
  }>(
    `with q as (
       select search.tsquery_or(variants) as any_term, count(*) as terms
         from search.query_terms($2)
        where variants is not null
     )
     select /* search.lexical-page */
            d.object_id, d.object_type, d.title, d.lifecycle_state, d.classification,
            (q.terms > 1 and exists (
               select from unnest(d.languages) l where d.document @@ phraseto_tsquery(l, $2)
            )) as phrase,
            coalesce(ts_rank(d.document, q.any_term), 0) as text_rank,
            -- Verification is a fact about the record, so it is read through the record: both
            -- joins run under the caller's row security, and an index row whose record the
            -- caller cannot see reads as "no verification visible" rather than as "unchecked".
            o.id is not null as record_visible,
            v.verified_at, v.verified_by, v.basis as verification_basis, v.policy_id as verification_policy_id
       from search.document d
      cross join q
       left join core.object o on o.id = d.object_id
       left join core.object_verification v on v.object_id = o.id
      where d.object_id = any($1::uuid[])`,
    [window.map((m) => m.objectId), text],
  );

  const scored = rows.flatMap((row) => {
    const entry = byId.get(row.object_id);
    return entry === undefined ? [] : [{ row, entry }];
  });
  scored.sort(
    (a, b) =>
      b.entry.match.coverage - a.entry.match.coverage ||
      Number(b.row.phrase) - Number(a.row.phrase) ||
      Number(b.row.text_rank) - Number(a.row.text_rank) ||
      a.entry.position - b.entry.position,
  );
  return scored.slice(0, limit).map(({ row, entry }) => ({
    objectId: row.object_id,
    objectType: row.object_type,
    title: row.title,
    lifecycleState: row.lifecycle_state,
    classification: row.classification,
    rank: entry.match.coverage,
    matchedBy: entry.match.matchedBy,
    // Fail closed on a row that does not say: a record not positively visible is not looked up,
    // and a verification missing any of its facts is not one this code may repeat.
    verification: verificationOf(row),
  }));
}

/**
 * The ranked page, optionally restricted to `only` — the ids a caller's grants reach, so that a
 * page of `limit` is a page of records the caller may read rather than a page some of which is
 * then removed.
 */
export async function searchAmong(
  tx: Tx,
  scope: SearchScope,
  query: SearchQuery,
  only: readonly string[] | undefined,
): Promise<SearchHit[]> {
  if (only !== undefined && only.length === 0) return [];
  return pageOf(tx, query, await rankedMatchesIn(tx, scope, query, only));
}

/** A record's verification as a hit carries it, failing closed on anything incomplete. */
export function verificationOf(r: {
  readonly record_visible: boolean;
  readonly verified_at: Date | null;
  readonly verified_by: string | null;
  readonly verification_basis: string | null;
  readonly verification_policy_id?: string | null;
}): RecordVerification {
  return recordVerification(
    [r.verified_at, r.verified_by, r.verification_basis].some((v) => v === null || v === undefined)
      ? undefined
      : {
          basis: r.verification_basis as string,
          verifiedAt: r.verified_at as Date,
          verifiedBy: r.verified_by as string,
          policyId: r.verification_policy_id ?? null,
        },
    { visible: r.record_visible === true },
  );
}

/** Index one object. Called from the outbox worker after an action commits. */
export async function indexObject(tx: Tx, objectId: string): Promise<void> {
  await tx.query('select search.index_object($1)', [objectId]);
}

/**
 * Rebuild the whole index, in batches, each its own transaction.
 *
 * The function that keeps the index disposable rather than data. If this stops working, the
 * index has quietly become a second source of truth. One statement over every record outlasted
 * the statement budget at 50 000 records (fixtures/multi); a batch of `batchSize` does not, and a
 * rebuild that stops is resumed from the last record it indexed (`after`), because re-indexing a
 * record is idempotent. Records are visited in id order.
 */
export async function rebuild(
  pool: Pool,
  options: {
    readonly batchSize?: number;
    readonly after?: string;
    readonly onBatch?: (progress: { readonly indexed: number; readonly last: string }) => void;
  } = {},
): Promise<number> {
  const batchSize = Math.max(1, options.batchSize ?? 500);
  let after: string | null = options.after ?? null;
  let total = 0;
  for (;;) {
    const row = await withTransaction(pool, (tx) =>
      tx.one<{ indexed: number; last_object: string | null }>(
        'select indexed, last_object from search.rebuild_batch($1::uuid, $2)',
        [after, batchSize],
      ),
    );
    const indexed = Number(row.indexed);
    if (indexed === 0 || row.last_object === null) return total;
    total += indexed;
    after = row.last_object;
    options.onBatch?.({ indexed: total, last: after });
  }
}

export * from './compose.js';
export * from './transient.js';

export const PACKAGE = {
  name: '@kf/search',
  role: 'Canonical search over a derived, disposable index',
  owns: ['search'],
} as const;
