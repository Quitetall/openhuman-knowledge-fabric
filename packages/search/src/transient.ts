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

import type { Tx } from '@kf/database';
import type { ReadGrants } from './compose.js';
import { matchesIn, searchAmong, type SearchHit, type SearchScope } from './index.js';

/** Record one query. Empty text is not a query and is not recorded. */
export async function recordQuery(tx: Tx, text: string): Promise<string | undefined> {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const row = await tx.one<{ id: string }>('select search.record_query($1) as id', [trimmed]);
  return row.id;
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
