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
import { setAccessContext, withTransaction } from '@kf/database';

export interface SearchScope {
  readonly organizationId: string;
  /** The highest classification this caller may see. Never widened by omission. */
  readonly maxClassification: string;
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
  scope: SearchScope,
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
    await setAccessContext(tx, scope);
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
  const text = normalise(query.text);
  if (text === '') return [];

  const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

  const rows = await tx.query<{
    object_id: string;
    object_type: string;
    title: string;
    lifecycle_state: string;
    classification: string;
    rank: number;
    matched_by: string;
  }>(
    `with visible as (
       select d.*
         from search.document d
         join registry.classification c on c.id = d.classification
         join registry.classification mine on mine.id = $2
        where d.organization_id = $1
          -- The same rule row-level security applies to core.object, and now to
          -- search.document itself. Kept here as well as there, because a filter that only
          -- exists on one of two paths is a filter that will be missed on the other.
          and c.rank <= mine.rank
          and ($4::text[] is null or d.object_type = any($4))
          and ($5::text[] is null or d.lifecycle_state = any($5))
     ),
     needle as (
       -- ILIKE patterns are not search syntax. Escape their metacharacters so an identifier
       -- such as LOT_A7 or ZX%Q stays literal instead of widening into a wildcard scan.
       select replace(replace(replace($3, '!', '!!'), '%', '!%'), '_', '!_') as pattern
     ),
     full_text as (
       select v.*, ts_rank(v.document, websearch_to_tsquery('english', $3)) as rank,
              'full_text' as matched_by
         from visible v
        where v.document @@ websearch_to_tsquery('english', $3)
     ),
     partial as (
       -- Only what full text missed. Ranked below every full-text hit, because a stemmed
       -- match on the actual words beats a substring every time.
       select v.*, greatest(similarity(v.title, $3), similarity(v.body, $3)) * 0.5 as rank,
              'partial_identifier' as matched_by
         from visible v cross join needle n
        where (v.title ilike '%' || n.pattern || '%' escape '!'
               or v.body ilike '%' || n.pattern || '%' escape '!')
          and v.object_id not in (select object_id from full_text)
     )
     select object_id, object_type, title, lifecycle_state, classification, rank, matched_by
       from (select * from full_text union all select * from partial) hits
      order by rank desc, title
      limit $6`,
    [
      scope.organizationId,
      scope.maxClassification,
      text,
      query.objectTypes === undefined ? null : [...query.objectTypes],
      query.lifecycleStates === undefined ? null : [...query.lifecycleStates],
      limit,
    ],
  );

  return rows.map((r) => ({
    objectId: r.object_id,
    objectType: r.object_type,
    title: r.title,
    lifecycleState: r.lifecycle_state,
    classification: r.classification,
    rank: Number(r.rank),
    matchedBy: r.matched_by === 'full_text' ? 'full_text' : 'partial_identifier',
  }));
}

/** Index one object. Called from the outbox worker after an action commits. */
export async function indexObject(tx: Tx, objectId: string): Promise<void> {
  await tx.query('select search.index_object($1)', [objectId]);
}

/**
 * Rebuild the whole index.
 *
 * The function that keeps the index disposable rather than data. If this stops working, the
 * index has quietly become a second source of truth.
 */
export async function rebuild(pool: Pool): Promise<number> {
  return withTransaction(pool, async (tx) => {
    const row = await tx.one<{ rebuild: string }>('select search.rebuild() as rebuild');
    return Number(row.rebuild);
  });
}

export const PACKAGE = {
  name: '@kf/search',
  role: 'Canonical search over a derived, disposable index',
  owns: ['search'],
} as const;
