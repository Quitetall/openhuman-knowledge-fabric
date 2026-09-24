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

/**
 * Sections added to the export after archives of the current format were already being written.
 *
 * A format-1 archive was written before these tables did, so their absence means the corpus had
 * none — which is true, and not a loss. The same holds for a format-2 archive written before the
 * section existed: `object-verifications` arrived on 2026-09-20 without a format bump, and every
 * format-2 archive from before then refused to restore with "export has no
 * object-verifications.json". Those archives are the backups.
 *
 * Named explicitly rather than treating any missing section as empty: a blanket rule would
 * silently accept a truncated export, which is the failure the round trip exists to catch. And a
 * named section is skipped only when its file is absent from the archive — the manifest check
 * that runs before this refuses a listed file that is missing, so absence here means the signed
 * manifest never listed it, not that it was lost on the way.
 */
const SECTIONS_ADDED_AFTER_FORMAT_1 = new Set(['object-verifications', 'access-demand']);

function predatesSection(pkg: ExportPackage, name: string): boolean {
  if (!SECTIONS_ADDED_AFTER_FORMAT_1.has(name)) return false;
  if (pkg.manifest.format_version === '1') return true;
  return !pkg.files.some((file) => file.path === `${name}.json`);
}

/**
 * An archive written before `core.audit_event.link_format` existed (20260924001100) carries no
 * format per link, and every link in it is the untagged kf-audit-link-v1 — nothing wrote
 * anything else until that migration. The format is supplied explicitly rather than left to the
 * column default, which is the CURRENT format and would restore every old link as unverifiable.
 * A row that does carry the column keeps exactly what it says; the chain check that follows the
 * restore then verifies each link under it. No export format bump: the file is still the same
 * rows, and an old archive still restores.
 */
function withRecordedLinkFormat(row: Row): Row {
  return Object.hasOwn(row, 'link_format') ? row : { ...row, link_format: 'kf-audit-link-v1' };
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
    if (predatesSection(pkg, name)) continue;
    let rows = sectionRows(pkg, name);
    if (name === 'audit-events') {
      rows = rows.map(withRecordedLinkFormat);
    }
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
