/**
 * Expiry only counts if every copy expires (§64B, ADR 0029, KF-SAS-RQ-220).
 *
 * A transient observation is swept after its window. A sweeper that deletes the rows while
 * another mechanism keeps them is decorative, so each table declared under `transientTables` in
 * the boundary registry is held here to every place a copy could survive:
 *
 *  - the preservation export, whose retention is unbounded — `PRESERVATION_TABLE_EXCLUSIONS`;
 *  - the master-record boundary — declared transient and never a permission member;
 *  - checkpoint coverage, which signs state — named nowhere in `apps/checkpoint/src`, and carrying
 *    no trigger that would copy it into the audit chain the checkpoint signs;
 *  - backups retained past the window — `--exclude-table-data` in `scripts/backup.sh`;
 *
 * and to its own window: the migration that creates it states an `expires_at` default equal to
 * the declared expiry.
 *
 * Pure over file text, so it also runs against planted trees: a gate that could not fail would
 * read as a guarantee nobody checked.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRESERVATION_TABLE_EXCLUSIONS } from '../../packages/export/src/internal/import-targets.js';
import type { MasterRecordBoundaryRegistry } from '../../packages/documents/src/master-record-boundary.js';

const ROOT = join(import.meta.dirname, '..', '..');

interface Tree {
  readonly registry: MasterRecordBoundaryRegistry;
  readonly exportExclusions: readonly string[];
  readonly backupScript: string;
  readonly checkpointSources: readonly { path: string; text: string }[];
  readonly migrations: readonly { path: string; text: string }[];
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Every way a declared transient table survives its window, as `rule: table`. */
function transientViolations(tree: Tree): string[] {
  const violations: string[] = [];
  const declared = tree.registry.transientTables ?? [];
  const members = new Set([
    ...tree.registry.materializedTables,
    ...tree.registry.derivedTables,
    ...tree.registry.liveExternalTables,
  ]);
  const allMigrations = tree.migrations.map((file) => file.text).join('\n');

  for (const { table, expiry } of declared) {
    const name = escape(table);
    const [schema] = table.split('.');
    const excludedFromExport = tree.exportExclusions.some((excluded) =>
      excluded.endsWith('.*') ? excluded === `${schema}.*` : excluded === table,
    );
    if (!excludedFromExport) violations.push(`export: ${table}`);
    if (members.has(table)) violations.push(`boundary: ${table}`);
    if (!new RegExp(`--exclude-table-data=${name}(?:\\s|\\\\|$)`, 'u').test(tree.backupScript)) {
      violations.push(`backup: ${table}`);
    }
    if (tree.checkpointSources.some((file) => new RegExp(`\\b${name}\\b`, 'u').test(file.text))) {
      violations.push(`checkpoint: ${table}`);
    }
    if (
      new RegExp(`create\\s+(?:constraint\\s+)?trigger[^;]*\\bon\\s+${name}\\b`, 'iu').test(
        allMigrations,
      )
    ) {
      violations.push(`trigger: ${table}`);
    }
    const created = new RegExp(`create table ${name} \\(([\\s\\S]*?)\\n\\);`, 'u').exec(
      allMigrations,
    );
    const window = new RegExp(
      `expires_at\\s+timestamptz not null default now\\(\\) \\+ interval '${escape(expiry)}'`,
      'u',
    );
    if (created === null || !window.test(created[1] ?? '')) violations.push(`expiry: ${table}`);
  }
  return violations;
}

function sources(directory: string, relative: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...sources(path, `${relative}/${entry.name}`));
    else if (entry.name.endsWith('.ts')) {
      out.push({ path: `${relative}/${entry.name}`, text: readFileSync(path, 'utf8') });
    }
  }
  return out;
}

function realTree(): Tree {
  const migrationsDir = join(ROOT, 'database', 'migrations');
  return {
    registry: JSON.parse(
      readFileSync(join(ROOT, 'docs', 'architecture', 'master-record-boundary.json'), 'utf8'),
    ) as MasterRecordBoundaryRegistry,
    exportExclusions: Object.keys(PRESERVATION_TABLE_EXCLUSIONS),
    backupScript: readFileSync(join(ROOT, 'scripts', 'backup.sh'), 'utf8'),
    checkpointSources: sources(join(ROOT, 'apps', 'checkpoint', 'src'), 'apps/checkpoint/src'),
    migrations: readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => ({ path: name, text: readFileSync(join(migrationsDir, name), 'utf8') })),
  };
}

describe('every copy of a transient observation expires', () => {
  it('declares the transient observations §64B names', () => {
    const tables = (realTree().registry.transientTables ?? []).map((entry) => entry.table);
    expect(tables).toEqual(
      expect.arrayContaining(['search.recorded_query', 'retrieval.disclosure']),
    );
  });

  it('excludes each from the export, the boundary, checkpoints and backup data', () => {
    expect(transientViolations(realTree())).toEqual([]);
  });

  it('finds each missing exclusion in a planted tree', () => {
    const real = realTree();
    const planted: Tree = {
      ...real,
      registry: {
        ...real.registry,
        materializedTables: [...real.registry.materializedTables, 'search.recorded_query'],
      },
      exportExclusions: real.exportExclusions.filter((table) => table !== 'retrieval.disclosure'),
      backupScript: real.backupScript.replace('--exclude-table-data=search.asker_key', ''),
      checkpointSources: [
        ...real.checkpointSources,
        { path: 'planted.ts', text: "tx.query('select * from search.demand_contribution')" },
      ],
      migrations: [
        ...real.migrations.map((file) => ({
          ...file,
          text: file.text.replace(
            "expires_at      timestamptz not null default now() + interval '90 days',\n  check (expires_at > recorded_at)\n);\n\ncreate index disclosure_expiry",
            "expires_at      timestamptz not null default now() + interval '900 days',\n  check (expires_at > recorded_at)\n);\n\ncreate index disclosure_expiry",
          ),
        })),
        {
          path: 'planted.sql',
          text: 'create trigger copy_to_audit after insert on search.asker_key for each row execute function x();',
        },
      ],
    };
    expect(transientViolations(planted).sort()).toEqual(
      [
        'boundary: search.recorded_query',
        'export: retrieval.disclosure',
        'backup: search.asker_key',
        'checkpoint: search.demand_contribution',
        'trigger: search.asker_key',
        'expiry: retrieval.disclosure',
      ].sort(),
    );
  });
});
