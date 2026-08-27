/**
 * Machine-readable classification of tables that can be observed by the master-record
 * permission boundary. The registry is deliberately data-owned; this helper only checks that
 * an observed table has exactly one declared disposition.
 */
export type MasterRecordBoundaryClass = 'materialized' | 'derived' | 'live_external';

export interface MasterRecordBoundaryRegistry {
  readonly materializedTables: readonly string[];
  readonly derivedTables: readonly string[];
  readonly liveExternalTables: readonly string[];
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
  ];

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
