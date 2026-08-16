import {
  canonicalize,
  compareCanonicalText,
  digest as digestOf,
  digestBytes,
} from '@kf/canonicalization';
import type { ExportFile } from './types.js';
import { DECIMAL_SEQUENCE } from './format.js';
import { SECTIONS } from './sections.js';

export const DATABASE_SNAPSHOT_PATHS = [
  'ontology/registry.json',
  ...SECTIONS.map((section) => `${section.name}.json`),
] as const;

/** Recompute database snapshot identity from exact exported file bytes, never manifest claims. */
export function recomputeDatabaseSnapshotDigest(files: readonly ExportFile[]): string {
  const byPath = new Map<string, ExportFile>();
  for (const entry of files) {
    if (DATABASE_SNAPSHOT_PATHS.includes(entry.path as (typeof DATABASE_SNAPSHOT_PATHS)[number])) {
      if (byPath.has(entry.path)) {
        throw new Error(`database snapshot contains duplicate ${entry.path}`);
      }
      byPath.set(entry.path, entry);
    }
  }
  const sections = DATABASE_SNAPSHOT_PATHS.map((path) => {
    const entry = byPath.get(path);
    if (entry === undefined) throw new Error(`database snapshot is missing ${path}`);
    const bytes = Buffer.from(entry.content, 'utf8');
    return { path, size_bytes: bytes.length, sha256: digestBytes(bytes) };
  });
  return digestOf({ format: 'kf.database-snapshot.v1', sections });
}

export type Row = Record<string, unknown>;

/**
 * Normalize a database row into something canonicalizable and stable.
 *
 * Dates become ISO strings and bigints become decimal strings, because a value that
 * round-trips through the export as a different JavaScript type would compare unequal on
 * re-export while representing exactly the same fact.
 */
export function normalize(row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) {
    const v = row[key];
    if (v instanceof Date) out[key] = v.toISOString();
    else if (typeof v === 'bigint') out[key] = v.toString();
    else if (Buffer.isBuffer(v)) out[key] = v.toString('base64');
    else out[key] = v;
  }
  return out;
}

export function file(path: string, value: unknown): ExportFile {
  return { path, content: `${canonicalize(value)}\n` };
}

/**
 * Canonical row-set ordering independent of PostgreSQL database collation.
 *
 * SQL ORDER BY remains useful for bounded query plans, but text collation is cluster state.
 * Preservation bytes cannot depend on whether restore host uses builtin C.UTF-8 or another
 * libc/ICU locale, so every non-chain row set receives final UTF-16 ordinal ordering here.
 */
export function canonicalRowOrder<R extends Row>(rows: readonly R[]): R[] {
  return rows
    .map((row) => ({ row, canonical: canonicalize(row) }))
    .sort((left, right) => compareCanonicalText(left.canonical, right.canonical))
    .map(({ row }) => row);
}

export function exactAuditSequence(value: unknown, location: string): string {
  if (typeof value !== 'string' || !DECIMAL_SEQUENCE.test(value)) {
    throw new Error(`${location} must be an exact non-negative decimal string`);
  }
  return value;
}
