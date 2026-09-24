import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Nothing in this package writes durable state (KF-SAS-RQ-214, RQ-223).
 *
 * A band bitmap, a ceiling, a coverage set or a scope tag handed to the engine is a derived copy
 * of an authorization input. It may live as long as the process holding it and no longer — so this
 * package may not touch the filesystem, and the only SQL it may issue reads. A test rather than a
 * convention, and run against a planted tree as well as the real one, because a scan that cannot
 * fail reads as a guarantee nobody checked.
 */

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

const FILESYSTEM_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](?:node:)?(?:fs|fs\/promises|sqlite|v8|worker_threads)['"]/u;
const DRIVER_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](?:pg|pg-[a-z-]+)['"]/u;
/** A write statement anywhere in a string: SQL is only ever issued as a literal here. */
const WRITE_SQL =
  /['"`]\s*(?:\/\*[^*]*\*\/\s*)?(?:insert|update|delete|merge|truncate|copy|create|alter|drop|grant|call|do)\b/iu;
const SELECT_INTO = /\bselect\b[^;'"`]*\binto\s+(?!strict\b)[a-z_]+\.[a-z_]+/iu;

function durableStateViolations(files: readonly SourceFile[]): string[] {
  const violations: string[] = [];
  for (const { path, text } of files) {
    if (FILESYSTEM_IMPORT.test(text)) violations.push(`filesystem: ${path}`);
    if (DRIVER_IMPORT.test(text)) violations.push(`driver: ${path}`);
    if (WRITE_SQL.test(text)) violations.push(`write sql: ${path}`);
    if (SELECT_INTO.test(text)) violations.push(`select into: ${path}`);
  }
  return violations;
}

const SOURCE_DIR = import.meta.dirname;

function packageSources(): SourceFile[] {
  return readdirSync(SOURCE_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ path: name, text: readFileSync(join(SOURCE_DIR, name), 'utf8') }));
}

describe('@kf/retrieval keeps nothing', () => {
  it('imports no filesystem or driver, and issues no SQL that writes', () => {
    const sources = packageSources();
    expect(sources.map((file) => file.path)).toEqual(
      expect.arrayContaining(['index.ts', 'client.ts', 'protocol.ts', 'engine.ts']),
    );
    expect(durableStateViolations(sources)).toEqual([]);
  });

  it('declares no dependency that could hold state for it', () => {
    const manifest = JSON.parse(readFileSync(join(SOURCE_DIR, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@kf/authorization',
      '@kf/database',
    ]);
  });

  it('finds each kind of violation in a planted tree', () => {
    const planted: SourceFile[] = [
      { path: 'a.ts', text: "import { writeFileSync } from 'node:fs';" },
      { path: 'b.ts', text: "const { mkdir } = await import('fs/promises');" },
      // Assembled, so the write-seam scan over this file does not read the plant as an import.
      { path: 'c.ts', text: `import { Client } from ${"'"}pg';` },
      {
        path: 'd.ts',
        text: "await tx.query('insert into retrieval.band_cache (bits) values ($1)', [b]);",
      },
      {
        path: 'e.ts',
        text: 'await tx.query(`/* cache */ update retrieval.band_version set v = 1`);',
      },
      { path: 'f.ts', text: "await tx.query('select 1 into retrieval.kept_mask');" },
      { path: 'ok.ts', text: "await tx.query('select version from retrieval.band_version');" },
    ];
    expect(durableStateViolations(planted)).toEqual([
      'filesystem: a.ts',
      'filesystem: b.ts',
      'driver: c.ts',
      'write sql: d.ts',
      'write sql: e.ts',
      'select into: f.ts',
    ]);
  });
});
