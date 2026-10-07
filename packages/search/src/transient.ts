/**
 * Recorded queries and their replay (§64B, ADR 0029, KF-SAS-RQ-221, RQ-222).
 *
 * A query is a transient observation. `recordQuery` writes one through a definer seam that takes
 * the organization, the ceiling and the asker from the sealed context; the asker is stored only as
 * a pseudonymous key the application cannot read. `replayRecordedQuery` is the one use the log
 * has: somebody cleared higher runs a recorded query at their own ceiling, sees what the original
 * asker's ceiling withheld, and each such record is counted once per distinct asker into the
 * durable demand aggregate. What was withheld is returned and never stored.
 */

import type { RecordVerification } from '@kf/domain';
import type { Tx } from '@kf/database';
import type { ReadGrants } from './compose.js';
import {
  matchesIn,
  searchAmong,
  verificationOf,
  type SearchHit,
  type SearchScope,
} from './index.js';

/** Record one query. Empty text is not a query and is not recorded. */
export async function recordQuery(tx: Tx, text: string): Promise<string | undefined> {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const row = await tx.one<{ id: string }>('select search.record_query($1) as id', [trimmed]);
  return row.id;
}

/** One of the caller's own recorded queries. Names nobody: it is the caller's by construction. */
export interface OwnRecordedQuery {
  readonly id: string;
  readonly text: string;
  readonly askerCeiling: string;
  readonly recordedAt: string;
  readonly expiresAt: string;
}

/**
 * The bound principal's own live recorded queries, newest first (KF-SAS-RQ-221). The seam
 * recomputes the caller's pseudonymous asker key itself and takes no person, so there is no way to
 * ask it for somebody else's. With `id`, at most that one — and only if it is the caller's.
 */
export async function listOwnRecordedQueries(
  tx: Tx,
  id?: string,
): Promise<readonly OwnRecordedQuery[]> {
  const rows = await tx.query<{
    id: string;
    query_text: string;
    asker_ceiling: string;
    recorded_at: Date;
    expires_at: Date;
  }>(
    `select id, query_text, asker_ceiling, recorded_at, expires_at
       from search.my_recorded_queries($1::uuid)`,
    [id ?? null],
  );
  return rows.map((row) => ({
    id: row.id,
    text: row.query_text,
    askerCeiling: row.asker_ceiling,
    recordedAt: row.recorded_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  }));
}

export interface Replay {
  readonly recordedQueryId: string;
  readonly askerCeiling: string;
  /** Records the asker's ceiling withheld that the replayer may read. Computed, not stored. */
  readonly withheld: readonly SearchHit[];
  /** How many of them counted as a new distinct asker in the demand aggregate. */
  readonly counted: number;
}

/**
 * Replay a recorded query at the replayer's ceiling and grants. `undefined` when the recorded
 * query is not visible to the replayer — expired, another organization's, or asked above their own
 * ceiling — which a caller must not distinguish.
 */
export async function replayRecordedQuery(
  tx: Tx,
  scope: SearchScope,
  grants: ReadGrants,
  recordedQueryId: string,
): Promise<Replay | undefined> {
  const recorded = await tx.query<{
    query_text: string;
    asker_ceiling: string;
    asker_rank: number;
  }>(
    `select query_text, asker_ceiling, asker_rank
       from search.recorded_query
      where id = $1 and expires_at > now()`,
    [recordedQueryId],
  );
  const query = recorded[0];
  if (query === undefined) return undefined;

  const ranks = await tx.query<{ id: string; rank: number }>(
    'select id, rank from registry.classification',
  );
  const rankOf = new Map(ranks.map((row) => [row.id, Number(row.rank)]));

  const matches = await matchesIn(tx, scope, { text: query.query_text });
  const withheldIds = matches
    .filter((m) => (rankOf.get(m.classification) ?? -1) > Number(query.asker_rank))
    .filter((m) => grants.reaches(m.objectId, m.classification))
    .map((m) => m.objectId);

  const withheld =
    withheldIds.length === 0
      ? []
      : await searchAmong(tx, scope, { text: query.query_text, limit: 200 }, withheldIds);
  const { counted } = await tx.one<{ counted: number }>(
    'select search.record_demand($1, $2::uuid[]) as counted',
    [recordedQueryId, withheldIds],
  );
  return {
    recordedQueryId,
    askerCeiling: query.asker_ceiling,
    withheld,
    counted: Number(counted),
  };
}

/** One record the organization's lower-clearance queries wanted, as the durable aggregate counts it. */
export interface DemandedRecord {
  readonly objectId: string;
  readonly objectType: string;
  readonly title: string;
  readonly classification: string;
  /** Distinct persons whose queries it answered above their ceiling. Never which persons. */
  readonly distinctPersonCount: number;
  /** Whether anybody has verified the record, with its label (KF-SAS-RQ-229). */
  readonly verification: RecordVerification;
}

export interface DemandReplay {
  /** How many recorded queries were replayed: every live one asked below the replayer's ceiling. */
  readonly replayed: number;
  /** True when more were eligible than one replay runs; the newest were replayed. */
  readonly truncated: boolean;
  /** New distinct-person contributions this replay counted. */
  readonly counted: number;
  /**
   * The records those replays found withheld, readable by the replayer, with their aggregate: the
   * DEMAND_RECORD_LIMIT most wanted.
   */
  readonly records: readonly DemandedRecord[];
}

/** The most recorded queries one demand replay runs. Each is one search. */
export const DEMAND_REPLAY_LIMIT = 500;

/** The most records one demand replay returns: the most wanted first. */
export const DEMAND_RECORD_LIMIT = 200;

/**
 * Replay the organization's recorded queries at the replayer's ceiling and grants — somebody cleared
 * higher re-running what people cleared lower asked (ADR 0029, §64B) — and count what each
 * original ceiling withheld into the demand aggregate.
 *
 * The replayer is never shown a query. Recorded query text says what somebody was trying to find
 * out, and the owner's line is that nobody reads the log (ADR 0029: the demand signal and the query
 * log are different artifacts; conflating them turns a provisioning tool into workplace
 * monitoring). No text, id, time or asker key of any recorded query leaves this function; what
 * comes back is the aggregate — records, each with its count of distinct persons — plus how many
 * queries were replayed. There is deliberately no route that lists other people's recorded queries
 * (ADR 0029, "Amended 2026-09-24": what is deliberately not built).
 *
 * Only queries asked strictly BELOW the replayer's ceiling are replayed: a query asked at or above
 * it has nothing it could have withheld that the replayer may count (search.record_demand counts a
 * record only above the asker's ceiling and at or below the replayer's).
 */
export async function replayOrganizationDemand(
  tx: Tx,
  scope: SearchScope,
  grants: ReadGrants,
): Promise<DemandReplay> {
  const queries = await tx.query<{ id: string; query_text: string; asker_rank: number }>(
    `select q.id, q.query_text, q.asker_rank
       from search.recorded_query q
      where q.expires_at > now()
        and q.asker_rank < (select core.current_classification_rank())
      order by q.recorded_at desc, q.id desc
      limit $1`,
    [DEMAND_REPLAY_LIMIT + 1],
  );
  const truncated = queries.length > DEMAND_REPLAY_LIMIT;
  const replaying = queries.slice(0, DEMAND_REPLAY_LIMIT);

  const ranks = await tx.query<{ id: string; rank: number }>(
    'select id, rank from registry.classification',
  );
  const rankOf = new Map(ranks.map((row) => [row.id, Number(row.rank)]));

  let counted = 0;
  const found = new Set<string>();
  for (const query of replaying) {
    const matches = await matchesIn(tx, scope, { text: query.query_text });
    const withheldIds = [
      ...new Set(
        matches
          .filter((m) => (rankOf.get(m.classification) ?? -1) > Number(query.asker_rank))
          .filter((m) => grants.reaches(m.objectId, m.classification))
          .map((m) => m.objectId),
      ),
    ];
    if (withheldIds.length === 0) continue;
    const row = await tx.one<{ counted: number }>(
      'select search.record_demand($1, $2::uuid[]) as counted',
      [query.id, withheldIds],
    );
    counted += Number(row.counted);
    for (const id of withheldIds) found.add(id);
  }

  const records =
    found.size === 0
      ? []
      : await tx.query<{
          object_id: string;
          object_type: string;
          title: string;
          classification: string;
          distinct_person_count: number;
          record_visible: boolean;
          verified_at: Date | null;
          verified_by: string | null;
          verification_basis: string | null;
          verification_policy_id?: string | null;
        }>(
          // Under the caller's row security: a record they cannot see is not listed, and its
          // verification is read through the record, as a search hit's is.
          `select d.object_id, o.object_type, o.title, o.classification, d.distinct_person_count,
                  true as record_visible,
                  v.verified_at, v.verified_by, v.basis as verification_basis, v.policy_id as verification_policy_id
             from org.access_demand d
             join core.object o on o.id = d.object_id
             left join core.object_verification v on v.object_id = o.id
            where d.object_id = any($1::uuid[])
            order by d.distinct_person_count desc, o.title, d.object_id
            limit ${DEMAND_RECORD_LIMIT}`,
          [[...found]],
        );
  return {
    replayed: replaying.length,
    truncated,
    counted,
    records: records.map((row) => ({
      objectId: row.object_id,
      objectType: row.object_type,
      title: row.title,
      classification: row.classification,
      distinctPersonCount: Number(row.distinct_person_count),
      verification: verificationOf(row),
    })),
  };
}
