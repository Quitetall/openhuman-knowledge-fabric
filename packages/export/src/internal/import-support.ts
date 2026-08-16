import type { Tx } from '@kf/database';
import type { ExportPackage } from './types.js';
import type { Row } from './encoding.js';
import { PRESERVATION_IMPORT_TARGETS } from './import-targets.js';
import {
  ISO_UTC_TIMESTAMPTZ,
  LOSSLESS_TAG_KEYS,
  isRecord,
  type LosslessPostgresType,
} from './format.js';

export interface TableColumns {
  /** Every column the table has. An import may write no others. */
  readonly all: ReadonlySet<string>;
  /** JSON kind by column; v2 carries exact server text rather than a parsed JS value. */
  readonly json: ReadonlyMap<string, 'postgres.json' | 'postgres.jsonb'>;
  /** timestamptz columns whose six-digit UTC representation must survive restoration. */
  readonly timestamptz: ReadonlySet<string>;
}

/**
 * A table's columns, read from the catalogue rather than hard-coded.
 *
 * This is the ALLOW-LIST for import, not merely a type hint. Column names in an export file
 * are attacker-controllable — a package's manifest verifies the digests of its files as they
 * are, so whoever crafts the package computes those digests too — and they are interpolated
 * into the INSERT text because SQL has no parameter form for an identifier. Checking each one
 * against the real table is what closes that.
 */
export async function tableColumns(tx: Tx, qualified: string): Promise<TableColumns> {
  const [schema, table] = qualified.split('.');
  const rows = await tx.query<{ column_name: string; data_type: string }>(
    `select column_name, data_type from information_schema.columns
      where table_schema = $1 and table_name = $2`,
    [schema, table],
  );
  if (rows.length === 0) throw new Error(`no such table: ${qualified}`);
  return {
    all: new Set(rows.map((r) => r.column_name)),
    json: new Map(
      rows
        .filter((r) => r.data_type === 'json' || r.data_type === 'jsonb')
        .map(
          (r) =>
            [r.column_name, r.data_type === 'json' ? 'postgres.json' : 'postgres.jsonb'] as const,
        ),
    ),
    timestamptz: new Set(
      rows.filter((r) => r.data_type === 'timestamp with time zone').map((r) => r.column_name),
    ),
  };
}

export function decodeLosslessValue(
  value: unknown,
  expectedType: LosslessPostgresType,
  location: string,
): string {
  if (!isRecord(value)) {
    throw new Error(`refusing to import: ${location} lacks ${expectedType} lossless tag`);
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== LOSSLESS_TAG_KEYS.length ||
    keys.some((key, index) => key !== LOSSLESS_TAG_KEYS[index]) ||
    value['$kf_type'] !== expectedType ||
    typeof value['text'] !== 'string'
  ) {
    throw new Error(`refusing to import: ${location} has malformed ${expectedType} lossless tag`);
  }
  if (expectedType === 'postgres.timestamptz' && !ISO_UTC_TIMESTAMPTZ.test(value['text'])) {
    throw new Error(`refusing to import: ${location} timestamptz is not six-digit UTC ISO`);
  }
  return value['text'];
}

export const TRUSTED_IMPORT_TABLES = [
  ...new Set(Object.values(PRESERVATION_IMPORT_TARGETS)),
].sort();

export async function assertUserTriggersEnabled(tx: Tx, phase: string): Promise<void> {
  const disabled = await tx.query<{ table_name: string; trigger_name: string; enabled: string }>(
    `select n.nspname || '.' || c.relname as table_name,
            t.tgname as trigger_name,
            t.tgenabled as enabled
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
      where not t.tgisinternal
        and n.nspname || '.' || c.relname = any($1::text[])
        and t.tgenabled <> 'O'
      order by 1, 2`,
    [TRUSTED_IMPORT_TABLES],
  );
  if (disabled.length > 0) {
    throw new Error(
      `refusing preservation import: USER triggers are not enabled ${phase}: ${disabled
        .map((row) => `${row.table_name}.${row.trigger_name}=${row.enabled}`)
        .join(', ')}`,
    );
  }
}

export async function setUserTriggers(tx: Tx, enabled: boolean): Promise<void> {
  for (const table of TRUSTED_IMPORT_TABLES) {
    // Names come only from the fixed source-controlled map above; package bytes can never
    // influence this identifier position.
    await tx.query(`alter table ${table} ${enabled ? 'enable' : 'disable'} trigger user`);
  }
}

export function sectionRows(pkg: ExportPackage, name: string): Row[] {
  const f = pkg.files.find((x) => x.path === `${name}.json`);
  if (f === undefined) throw new Error(`export has no ${name}.json`);
  return JSON.parse(f.content) as Row[];
}
