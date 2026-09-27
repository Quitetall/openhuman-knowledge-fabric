/**
 * The transient-observation sweep (§64B, ADR 0029, KF-SAS-RQ-220).
 *
 * Deletes every expired recorded query, demand contribution, disclosure digest, context-source
 * disclosure, refusal before binding and pseudonym key.
 * Losing one is the intended behaviour, not a fault; the sweep is what makes the stated expiry
 * true in the working store, and the export, checkpoint and backup exclusions make it true
 * everywhere else.
 */

import { withTransaction, type Pool } from '@kf/database';

export async function sweepTransientObservations(
  pool: Pool,
): Promise<readonly { readonly table: string; readonly removed: number }[]> {
  const rows = await withTransaction(pool, (tx) =>
    tx.query<{ table_name: string; removed: string }>(
      'select table_name, removed::text from core.sweep_transient_observations()',
    ),
  );
  return rows.map((row) => ({ table: row.table_name, removed: Number(row.removed) }));
}
