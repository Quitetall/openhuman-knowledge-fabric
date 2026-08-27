import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertMasterRecordBoundaryComplete,
  type MasterRecordBoundaryRegistry,
} from '../../packages/documents/src/master-record-boundary.js';

const ROOT = join(import.meta.dirname, '..', '..');

function rlsTables(): string[] {
  const directory = join(ROOT, 'database', 'migrations');
  const paths = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => join(directory, name));
  const tables = new Set<string>();
  for (const path of paths) {
    const body = readFileSync(path, 'utf8');
    for (const match of body.matchAll(
      /alter table\s+([a-z_]+\.[a-z_]+)\s+enable row level security/giu,
    )) {
      tables.add(match[1]!);
    }
  }
  return [...tables].sort();
}

describe('master-record permission boundary', () => {
  it('has no live external permission tables and covers newly added RLS tables', () => {
    const registry = JSON.parse(
      readFileSync(join(ROOT, 'docs', 'architecture', 'master-record-boundary.json'), 'utf8'),
    ) as MasterRecordBoundaryRegistry;
    const observed = rlsTables();
    assertMasterRecordBoundaryComplete(registry, observed);
    const all = new Set([
      ...registry.materializedTables,
      ...registry.derivedTables,
      ...registry.liveExternalTables,
    ]);
    expect(registry.liveExternalTables).toEqual([]);
    expect(all.size).toBe(
      registry.materializedTables.length +
        registry.derivedTables.length +
        registry.liveExternalTables.length,
    );
    expect(registry.derivedTables).toEqual(['search.document']);
    expect(registry.materializedTables).toContain('content.master_record_item');
    expect(registry.materializedTables).toContain('content.master_record_link');
    expect(registry.materializedTables).toContain('org.person_clearance');
    expect(observed).toEqual(
      expect.arrayContaining(['content.master_record', 'content.master_record_link']),
    );
    for (const table of observed) expect(all.has(table), table).toBe(true);
  });

  it('refuses a classification with an unclassified observed table', () => {
    const registry = JSON.parse(
      readFileSync(join(ROOT, 'docs', 'architecture', 'master-record-boundary.json'), 'utf8'),
    ) as MasterRecordBoundaryRegistry;
    const observed = rlsTables();
    const planted = {
      ...registry,
      materializedTables: registry.materializedTables.filter((table) => table !== 'core.object'),
    };
    expect(() => assertMasterRecordBoundaryComplete(planted, observed)).toThrow(
      /unclassified observed table.*core\.object/,
    );
  });
});
