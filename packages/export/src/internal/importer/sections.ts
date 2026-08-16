import type { Tx } from '@kf/database';
import { MAX_BIND_PARAMETERS } from '../format.js';
import type { Row } from '../encoding.js';
import { IMPORT_TARGETS } from '../import-targets.js';
import { decodeLosslessValue, sectionRows, tableColumns } from '../import-support.js';
import type { ExportPackage } from '../types.js';
import { EXPORT_FORMAT_VERSION } from '../types.js';
import { upconvertLegacyActions } from './legacy-actions.js';

export interface RestoredSections {
  readonly imported: number;
  readonly legacyActionIds: readonly string[];
}

export async function restoreSections(
  tx: Tx,
  pkg: ExportPackage,
  importOrder: readonly string[],
): Promise<RestoredSections> {
  let imported = 0;
  let legacyActionIds: string[] = [];
  for (const name of importOrder) {
    const table = IMPORT_TARGETS[name];
    if (table === undefined) continue;
    let rows = sectionRows(pkg, name);
    if (pkg.manifest.format_version === '1' && name === 'audit-checkpoints') {
      rows = rows.map((row) => ({ ...row, format_version: 'kf.audit-checkpoint.v1' }));
    }
    if (pkg.manifest.format_version === '1' && name === 'actions') {
      rows = await upconvertLegacyActions(tx, rows);
      legacyActionIds = rows.map((row) => row['id'] as string);
    }
    if (rows.length === 0) continue;

    const columnsOf = await tableColumns(tx, table);
    const columns = Object.keys(rows[0]!);
    for (const column of columns) {
      if (!columnsOf.all.has(column)) {
        throw new Error(
          `refusing to import: ${name}.json names a column '${column}' that ${table} does not have`,
        );
      }
    }
    for (const [index, row] of rows.entries()) {
      const keys = Object.keys(row);
      if (keys.length !== columns.length || keys.some((key, offset) => key !== columns[offset])) {
        throw new Error(`refusing to import: ${name}.json row ${index} has a different column set`);
      }
    }

    const prepare = (row: Row): unknown[] =>
      columns.map((column) => {
        const value = row[column];
        const jsonType = columnsOf.json.get(column);
        if (jsonType !== undefined && value !== null) {
          return pkg.manifest.format_version === EXPORT_FORMAT_VERSION
            ? decodeLosslessValue(value, jsonType, `${name}.json.${column}`)
            : JSON.stringify(value);
        }
        if (
          columnsOf.timestamptz.has(column) &&
          value !== null &&
          pkg.manifest.format_version === EXPORT_FORMAT_VERSION
        ) {
          return decodeLosslessValue(value, 'postgres.timestamptz', `${name}.json.${column}`);
        }
        return value;
      });

    const perStatement = Math.max(1, Math.floor(MAX_BIND_PARAMETERS / columns.length));
    for (let start = 0; start < rows.length; start += perStatement) {
      const batch = rows.slice(start, start + perStatement);
      const values: unknown[] = [];
      const tuples = batch.map((row) => {
        const placeholders = columns.map((_, index) => `$${values.length + index + 1}`).join(', ');
        values.push(...prepare(row));
        return `(${placeholders})`;
      });
      await tx.query(
        `insert into ${table} (${columns.join(', ')}) values ${tuples.join(', ')}`,
        values,
      );
      imported += batch.length;
    }
  }
  return { imported, legacyActionIds };
}
