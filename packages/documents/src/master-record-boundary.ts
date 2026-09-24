/**
 * Machine-readable classification of tables that can be observed by the master-record
 * permission boundary. The registry is deliberately data-owned; this helper only checks that
 * an observed table has exactly one declared disposition.
 */
export type MasterRecordBoundaryClass = 'materialized' | 'derived' | 'live_external' | 'transient';

/**
 * A transient observation (§64B, ADR 0029): neither authoritative nor rebuildable, kept for a
 * stated window. `expiry` is that window as PostgreSQL states it (`'90 days'`), and the table's
 * `expires_at` default must say the same.
 */
export interface TransientTable {
  readonly table: string;
  readonly expiry: string;
}

export interface MasterRecordBoundaryRegistry {
  readonly materializedTables: readonly string[];
  readonly derivedTables: readonly string[];
  readonly liveExternalTables: readonly string[];
  /** Absent reads as none; a registry that names a transient table must name its expiry. */
  readonly transientTables?: readonly TransientTable[];
}

/**
 * Refuse a boundary with an unclassified or stale table, or with one table listed in multiple
 * classes. `observedTables` should be the complete RLS-enabled table set for the checkout.
 */
export function assertMasterRecordBoundaryComplete(
  registry: MasterRecordBoundaryRegistry,
  observedTables: readonly string[],
): void {
  const classifications = new Map<string, MasterRecordBoundaryClass>();
  const declarations: readonly [MasterRecordBoundaryClass, readonly string[]][] = [
    ['materialized', registry.materializedTables],
    ['derived', registry.derivedTables],
    ['live_external', registry.liveExternalTables],
    ['transient', (registry.transientTables ?? []).map((entry) => entry.table)],
  ];

  for (const entry of registry.transientTables ?? []) {
    if (!/^[1-9][0-9]* days$/u.test(entry.expiry)) {
      throw new Error(
        `master-record boundary transient table '${entry.table}' states no expiry in days ` +
          `(got '${String(entry.expiry)}'); a transient observation without one is kept forever`,
      );
    }
  }

  for (const [boundaryClass, tables] of declarations) {
    for (const table of tables) {
      const prior = classifications.get(table);
      if (prior !== undefined) {
        throw new Error(
          `master-record boundary table '${table}' is classified as both ${prior} and ${boundaryClass}`,
        );
      }
      classifications.set(table, boundaryClass);
    }
  }

  const unclassified = [...new Set(observedTables)].filter((table) => !classifications.has(table));
  if (unclassified.length > 0) {
    throw new Error(
      `master-record boundary has unclassified observed table(s): ${unclassified
        .sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'variant' }))
        .join(', ')}`,
    );
  }

  const stale = [...classifications.keys()].filter((table) => !observedTables.includes(table));
  if (stale.length > 0) {
    throw new Error(
      `master-record boundary declares table(s) not observed in the permission surface: ${stale
        .sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'variant' }))
        .join(', ')}`,
    );
  }
}
