import type { Tx } from '@kf/database';
import { MAX_BIND_PARAMETERS } from '../format.js';
import type { Row } from '../encoding.js';
import { IMPORT_TARGETS } from '../import-targets.js';
import { decodeLosslessValue, sectionRows, tableColumns } from '../import-support.js';
import type { ExportPackage } from '../types.js';
import { EXPORT_FORMAT_VERSION } from '../types.js';
import { predatedSections, SECTIONS_ADDED_WITHOUT_FORMAT_BUMP } from '../section-eras.js';
import { upconvertLegacyActions } from './legacy-actions.js';

export interface RestoredSections {
  readonly imported: number;
  readonly legacyActionIds: readonly string[];
}

/**
 * Sections that did not exist at export format 1, or were added to format 2 later
 * (`section-eras.ts`). A format-1 archive was written before all of them; a format-2 archive
 * predates exactly those it has no file, manifest entry or count for — the verifier that runs
 * first refuses a half-present section, so absence here means the signing exporter never wrote it.
 */
const SECTIONS_ADDED_AFTER_FORMAT_1 = new Set(SECTIONS_ADDED_WITHOUT_FORMAT_BUMP);

function predatesSection(pkg: ExportPackage, name: string): boolean {
  if (!SECTIONS_ADDED_AFTER_FORMAT_1.has(name)) return false;
  if (pkg.manifest.format_version === '1') return true;
  return predatedSections(pkg).has(name);
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

/**
 * The same holds for `content.document_parse.digest_format` (20260925114000): an archive written
 * before it carries parses whose preimages are all the untagged kf-document-parse-v1, and the
 * column default is the CURRENT format, which would mislabel every one of them.
 */
function withRecordedParseFormat(row: Row): Row {
  return Object.hasOwn(row, 'digest_format')
    ? row
    : { ...row, digest_format: 'kf-document-parse-v1' };
}

/**
 * An archive written before 20260925130100 carries `work.deliverable` as the old table held it:
 * `deliverable_kind` and `definition_of_done`, and none of the ontology's fields. That archive is
 * a backup, and it has to restore into the schema that migration produced, so each old row is
 * moved exactly as the migration moved it: `definition_of_done` becomes the `description` and the
 * one acceptance criterion, `work_order_id` and `due_date` are absent (null), and both old values
 * are kept, per deliverable, in `work.deliverable_retired_attribute` — which that archive has no
 * section for, because the table did not exist yet.
 *
 * Keyed on the archive, not on a date: a row naming `definition_of_done` and not `description` is
 * old. A package that mixes the two shapes, or carries old rows AND a retired-attributes section,
 * was not written by any version of the exporter and is refused; so is a package whose
 * deliverables are new-shape but which has no retired-attributes section (a truncated export).
 * The retirement is stamped when the restore retires the values (the column default), as the
 * migration stamped it when it did.
 */
const RETIRED_DELIVERABLE_COLUMNS = ['deliverable_kind', 'definition_of_done'] as const;

function isRetiredDeliverableShape(row: Row): boolean {
  return (
    !Object.hasOwn(row, 'description') &&
    RETIRED_DELIVERABLE_COLUMNS.every((column) => Object.hasOwn(row, column))
  );
}

interface UpconvertedDeliverables {
  readonly rows: Row[];
  /** The retired values, or null when the rows already carried the ontology's fields. */
  readonly retired: Row[] | null;
}

function upconvertDeliverables(rows: readonly Row[]): UpconvertedDeliverables {
  // No deliverables, no retired values: a package without the section is complete either way.
  if (rows.length === 0) return { rows: [], retired: [] };
  const retiredShape = rows.filter(isRetiredDeliverableShape).length;
  if (retiredShape === 0) return { rows: [...rows], retired: null };
  if (retiredShape !== rows.length) {
    throw new Error(
      'refusing to import: deliverables.json mixes rows with and without the retired ' +
        'deliverable_kind/definition_of_done columns',
    );
  }
  const retired: Row[] = [];
  const upconverted = rows.map((row) => {
    const definition = row['definition_of_done'];
    const kind = row['deliverable_kind'];
    if (typeof definition !== 'string' || typeof kind !== 'string') {
      throw new Error(
        `refusing to import: deliverables.json row ${String(row['id'])} has a retired ` +
          'deliverable_kind/definition_of_done that is not text',
      );
    }
    retired.push({
      deliverable_id: row['id'],
      deliverable_kind: kind,
      definition_of_done: definition,
    });
    const kept = Object.fromEntries(
      Object.entries(row).filter(
        ([column]) => !(RETIRED_DELIVERABLE_COLUMNS as readonly string[]).includes(column),
      ),
    );
    return {
      ...kept,
      work_order_id: null,
      description: definition,
      acceptance_criteria: [definition],
      due_date: null,
    };
  });
  return { rows: upconverted, retired };
}

/**
 * The retired-attributes rows to restore: the archive's own section when it has one, or the
 * values the old-shape deliverables carried when it predates the section. Neither alone is
 * ambiguous; both, or a missing section under new-shape deliverables, is refused.
 */
function retiredDeliverableRows(pkg: ExportPackage, fromOldRows: Row[] | null): Row[] {
  const hasSection = !predatedSections(pkg).has('deliverable-retired-attributes');
  if (hasSection) {
    if (fromOldRows !== null && fromOldRows.length > 0) {
      throw new Error(
        'refusing to import: deliverables.json carries the retired columns and the package ' +
          'also has deliverable-retired-attributes.json',
      );
    }
    return sectionRows(pkg, 'deliverable-retired-attributes');
  }
  if (fromOldRows === null) {
    throw new Error('export has no deliverable-retired-attributes.json');
  }
  return fromOldRows;
}

/**
 * `content.master_record.corpus_digest` (20260901000100) is NOT NULL with no default, and the
 * migration computed it for every existing record from its manifest. An archive written before
 * the master-record section exported it (cade0136) carries records without it, which would fail
 * the insert. Each is derived exactly as the migration derived it, by the database's own function;
 * the `master_record_corpus_digest_matches_manifest` check then holds by construction. A package
 * whose rows disagree about carrying the column is refused by the column-set check below.
 */
async function withDerivedCorpusDigest(
  tx: Tx,
  pkg: ExportPackage,
  rows: readonly Row[],
): Promise<Row[]> {
  const derived: Row[] = [];
  for (const row of rows) {
    if (Object.hasOwn(row, 'corpus_digest')) {
      derived.push(row);
      continue;
    }
    const manifest =
      pkg.manifest.format_version === EXPORT_FORMAT_VERSION
        ? decodeLosslessValue(row['manifest'], 'postgres.jsonb', 'master-records.json.manifest')
        : JSON.stringify(row['manifest']);
    const { digest } = await tx.one<{ digest: string }>(
      'select content.master_record_corpus_digest($1::jsonb) as digest',
      [manifest],
    );
    derived.push({ ...row, corpus_digest: digest });
  }
  return derived;
}

export async function restoreSections(
  tx: Tx,
  pkg: ExportPackage,
  importOrder: readonly string[],
): Promise<RestoredSections> {
  let imported = 0;
  let legacyActionIds: string[] = [];
  let retiredDeliverables: Row[] | null = null;
  for (const name of importOrder) {
    const table = IMPORT_TARGETS[name];
    if (table === undefined) continue;
    let rows: Row[];
    if (name === 'deliverable-retired-attributes') {
      // Before the predates check: an archive that predates this section still has rows for it,
      // derived from its old-shape deliverables.
      rows = retiredDeliverableRows(pkg, retiredDeliverables);
    } else if (predatesSection(pkg, name)) {
      continue;
    } else {
      rows = sectionRows(pkg, name);
    }
    if (name === 'deliverables') {
      const upconverted = upconvertDeliverables(rows);
      rows = upconverted.rows;
      retiredDeliverables = upconverted.retired;
    }
    if (name === 'audit-events') {
      rows = rows.map(withRecordedLinkFormat);
    }
    if (name === 'document-parses') {
      rows = rows.map(withRecordedParseFormat);
    }
    if (name === 'master-records') {
      rows = await withDerivedCorpusDigest(tx, pkg, rows);
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
