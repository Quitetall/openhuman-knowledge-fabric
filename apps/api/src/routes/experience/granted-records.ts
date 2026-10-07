/**
 * Records a reader may read, newest first, selected where they live.
 *
 * The dashboard's lists (Recent record, Work in flight) must stay fast for a reader of fifty
 * thousand records, so they cannot enumerate the permitted set and sort it in the application.
 * They apply the SAME rule every read surface applies (`coveringGrants`, ADR 0016/0027) inside
 * the query instead: a record is listed when row security shows it AND a live read grant covers
 * it at its classification — an organization-wide grant up to its ceiling, or a grant on that
 * record up to its own. The coverage comes from `org.effective_access_grant`, the one view; this
 * is that answer applied in SQL, not a second policy. The result is re-checked against the same
 * coverage in the application before it is returned, so a mistake here can only drop a record,
 * never add one.
 */

import { coveringGrants, type AccessCoverage } from '@kf/authorization';
import type { Tx } from '@kf/database';
import { recordVerification, type RecordVerification } from '@kf/domain';

const RANK: Readonly<Record<string, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

/** A grant with no ceiling admits whatever row security shows; above every rank. */
const UNCAPPED = 99;

export interface CoverageParameters {
  /** The highest rank an organization-wide grant admits; -1 when there is none. */
  readonly organizationRank: number;
  readonly objectIds: readonly string[];
  readonly objectRanks: readonly number[];
}

export function coverageParameters(coverage: AccessCoverage): CoverageParameters {
  const rankOf = (ceiling: string | null): number =>
    ceiling === null ? UNCAPPED : (RANK[ceiling] ?? -1);
  const organizationRank = Math.max(
    -1,
    ...coverage.organizationWide.map((g) => rankOf(g.classificationCeiling)),
  );
  const objectIds: string[] = [];
  const objectRanks: number[] = [];
  for (const [id, grants] of coverage.byObject) {
    const rank = Math.max(-1, ...grants.map((g) => rankOf(g.classificationCeiling)));
    // An object an organization-wide grant already reaches needs no second path.
    if (rank > organizationRank) {
      objectIds.push(id);
      objectRanks.push(rank);
    }
  }
  return { organizationRank, objectIds, objectRanks };
}

export interface GrantedRecord {
  readonly id: string;
  readonly objectType: string;
  readonly title: string;
  readonly lifecycleState: string;
  readonly classification: string;
  readonly updatedAt: string;
  readonly verification: RecordVerification;
}

interface Row extends Record<string, unknown> {
  readonly id: string;
  readonly object_type: string;
  readonly title: string;
  readonly lifecycle_state: string;
  readonly classification: string;
  readonly updated_at: Date;
  readonly basis: 'reviewed_individually' | 'promoted_in_bulk' | null;
  readonly verified_at: Date | null;
  readonly verified_by: string | null;
}

export interface GrantedRecordQuery {
  readonly organizationId: string;
  readonly limit: number;
  /** Only these object types; absent, every type but `exclude`. */
  readonly types?: readonly string[];
  readonly exclude?: readonly string[];
  /** Only records whose current state has a declared way onward: work still in flight. */
  readonly inFlight?: boolean;
}

/**
 * The `limit` newest records the reader may read, by `updated_at`, and how many there are in all.
 * Two index walks (the organization-wide part and the object-grant part), merged; neither reads
 * a record the reader could not read.
 */
export async function grantedRecords(
  tx: Tx,
  coverage: AccessCoverage,
  query: GrantedRecordQuery,
): Promise<{ readonly records: readonly GrantedRecord[]; readonly total: number }> {
  const params = coverageParameters(coverage);
  const filters: string[] = [];
  const values: unknown[] = [
    query.organizationId,
    params.organizationRank,
    params.objectIds,
    params.objectRanks,
  ];
  if (query.types !== undefined) {
    values.push([...query.types]);
    filters.push(`o.object_type = any($${String(values.length)}::text[])`);
  }
  if (query.exclude !== undefined && query.exclude.length > 0) {
    values.push([...query.exclude]);
    filters.push(`o.object_type <> all($${String(values.length)}::text[])`);
  }
  if (query.inFlight === true) {
    filters.push(
      `exists (select 1 from registry.state_transition t
                where t.object_type = o.object_type and t.from_state = o.lifecycle_state)`,
    );
  }
  const where = filters.length === 0 ? '' : ` and ${filters.join(' and ')}`;
  const limit = `$${String(values.length + 1)}`;
  const columns = `o.id, o.object_type, o.title, o.lifecycle_state, o.classification, o.updated_at`;
  const rows = await tx.query<Row>(
    `with object_grant(id, ceiling_rank) as (
       select * from unnest($3::uuid[], $4::int[])
     ),
     candidates as (
       (select ${columns}
          from core.object o
          join registry.classification c on c.id = o.classification
         where $2::int >= 0 and o.organization_id = $1 and c.rank <= $2${where}
         order by o.updated_at desc, o.id desc
         limit ${limit})
       union
       (select ${columns}
          from object_grant g
          join core.object o on o.id = g.id
          join registry.classification c on c.id = o.classification
         where o.organization_id = $1 and c.rank <= g.ceiling_rank${where}
         order by o.updated_at desc, o.id desc
         limit ${limit})
     )
     select /* experience.granted-records */ candidates.*,
            v.basis, v.verified_at, v.verified_by
       from candidates
       left join core.object_verification v on v.object_id = candidates.id
      order by candidates.updated_at desc, candidates.id desc
      limit ${limit}`,
    [...values, query.limit],
  );
  const total = await tx.one<{ n: string }>(
    `with object_grant(id, ceiling_rank) as (
       select * from unnest($3::uuid[], $4::int[])
     )
     select /* experience.granted-count */ (
       (select count(*) from core.object o
          join registry.classification c on c.id = o.classification
         where $2::int >= 0 and o.organization_id = $1 and c.rank <= $2${where})
       +
       (select count(*) from object_grant g
          join core.object o on o.id = g.id
          join registry.classification c on c.id = o.classification
         where o.organization_id = $1 and c.rank <= g.ceiling_rank
           and not ($2::int >= 0 and c.rank <= $2)${where})
     )::text as n`,
    values,
  );
  const records = rows
    // The same rule, in the application: a record the query let through that the coverage does
    // not reach is dropped here rather than shown.
    .filter((row) => coveringGrants(coverage, row.id, row.classification).length > 0)
    .map((row) => ({
      id: row.id,
      objectType: row.object_type,
      title: row.title,
      lifecycleState: row.lifecycle_state,
      classification: row.classification,
      updatedAt: new Date(row.updated_at).toISOString(),
      verification: recordVerification(
        row.basis === null || row.verified_at === null || row.verified_by === null
          ? undefined
          : {
              basis: row.basis,
              verifiedAt: new Date(row.verified_at).toISOString(),
              verifiedBy: row.verified_by,
            },
      ),
    }));
  return { records, total: Number(total.n) };
}
