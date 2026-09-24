/**
 * The write seam, as a property of the source tree (KF-SAS-RQ-050, RQ-062/023).
 *
 * The dispatcher is the only write seam because nothing else can reach the database the way it
 * does. Three textual facts make that checkable:
 *
 *  - only `packages/database` imports the PostgreSQL driver `pg`, so every other package gets a
 *    connection through the one module that binds the principal and seals the context;
 *  - `appendAuditEvent(` is called only by @kf/actions and by the owner's admin commands under
 *    `apps/api/src/admin/` (bootstrap, grant authority, declare service actor, retire an
 *    organization, and any later owner command), the documented bootstrap-tier exception;
 *  - `insert into core.action` appears only in those same two places.
 *
 * Tests are exempt from the last two: they forge acts on purpose, to prove the database refuses
 * them. They are NOT exempt from the first — a test that opened its own driver connection would
 * be testing a database the application cannot reach.
 *
 * The scan is textual and over tracked files, so it also runs against a planted tree below: a
 * boundary check that could not fail would read as a guarantee nobody had checked.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
/** This file plants every violation as text, so it is the one file the scan must skip. */
const SELF = 'tests/conformance/write-seam-boundary.test.ts';

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u;
const PG_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]pg(?:\/[^'"]*)?['"]/mu;
const AUDIT_APPEND = /\bappendAuditEvent\s*\(/u;
const ACTION_INSERT = /\binsert\s+into\s+core\.action\b/iu;

const PG_OWNER = /^packages\/database\//u;
const WRITE_SEAM_OWNERS = [/^packages\/actions\/src\//u, /^apps\/api\/src\/admin\//u];

function isTest(path: string): boolean {
  return (
    /\.test\.[cm]?[jt]sx?$/u.test(path) ||
    path.startsWith('tests/') ||
    /(?:^|\/)(?:test-support|__tests__|fixtures)\//u.test(path)
  );
}

/** Every violation in a tree, as `rule: path`. Pure, so it can run against a planted tree. */
function writeSeamViolations(files: readonly SourceFile[]): string[] {
  const violations: string[] = [];
  for (const { path, text } of files) {
    if (path.endsWith('package.json')) {
      const manifest = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
      const declares = ['dependencies', 'devDependencies', 'peerDependencies'].some(
        (field) => manifest[field]?.['pg'] !== undefined,
      );
      if (declares && !PG_OWNER.test(path)) violations.push(`pg-dependency: ${path}`);
      continue;
    }
    if (!SOURCE.test(path)) continue;
    if (PG_IMPORT.test(text) && !PG_OWNER.test(path)) violations.push(`pg-import: ${path}`);
    if (isTest(path)) continue;
    const owner = WRITE_SEAM_OWNERS.some((pattern) => pattern.test(path));
    if (AUDIT_APPEND.test(text) && !owner) violations.push(`audit-append: ${path}`);
    if (ACTION_INSERT.test(text) && !owner) violations.push(`action-insert: ${path}`);
  }
  return violations;
}

function trackedTree(): SourceFile[] {
  const listed = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: ROOT,
      encoding: 'utf8',
    },
  )
    .split('\0')
    .filter((path) => path !== '' && path !== SELF)
    .filter((path) => !/(?:^|\/)(?:node_modules|dist)\//u.test(path))
    .filter((path) => SOURCE.test(path) || path.endsWith('package.json'));
  return listed.map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') }));
}

describe('the write seam is the only way in', () => {
  const tree = trackedTree();

  it('scans the tree it claims to scan', () => {
    // A scan over nothing passes. Count what it actually saw, and the owners it must see.
    expect(tree.length).toBeGreaterThan(200);
    const paths = tree.map((file) => file.path);
    expect(paths).toContain('packages/database/src/index.ts');
    expect(paths).toContain('packages/actions/src/internal/audit.ts');
    expect(paths).toContain('apps/api/src/admin/bootstrap-organization.ts');
    // And the owners really do the things only they may: otherwise the rules are vacuous.
    const text = (path: string) => tree.find((file) => file.path === path)!.text;
    expect(PG_IMPORT.test(text('packages/database/src/index.ts'))).toBe(true);
    expect(ACTION_INSERT.test(text('packages/actions/src/internal/application.ts'))).toBe(true);
    for (const command of [
      'bootstrap-organization',
      'grant-authority',
      'declare-service-actor',
      'retire-organization',
    ]) {
      const source = text(`apps/api/src/admin/${command}.ts`);
      expect(AUDIT_APPEND.test(source), command).toBe(true);
      expect(ACTION_INSERT.test(source), command).toBe(true);
    }
  });

  it('has no driver import, audit append or act insert outside its owners', () => {
    expect(writeSeamViolations(tree)).toEqual([]);
  });

  it('refuses each planted violation, and only those', () => {
    const planted: SourceFile[] = [
      { path: 'packages/search/src/sneaky.ts', text: "import { Pool } from 'pg';\n" },
      { path: 'apps/api/src/raw.ts', text: "const pg = await import('pg');\n" },
      { path: 'apps/web/package.json', text: JSON.stringify({ dependencies: { pg: '^8' } }) },
      {
        path: 'packages/work-control/src/shortcut.ts',
        text: 'await appendAuditEvent(tx, entry);\n',
      },
      {
        path: 'apps/api/src/routes/shortcut.ts',
        text: 'await tx.query(`INSERT INTO core.action (id) values ($1)`);\n',
      },
      // Legitimate: the owners, a test forging an act, and a lookalike table name.
      { path: 'packages/database/src/index.ts', text: "import pg from 'pg';\n" },
      { path: 'apps/api/src/admin/revoke-identity.ts', text: 'appendAuditEvent(tx, e);\n' },
      { path: 'tests/database/forge.test.ts', text: 'insert into core.action (id) values (1)' },
      { path: 'packages/x/src/y.ts', text: 'insert into core.action_digest (id) values (1)' },
      { path: 'packages/x/src/z.ts', text: "import { pgTyped } from 'pg-typed';\n" },
    ];
    expect(writeSeamViolations(planted)).toEqual([
      'pg-import: packages/search/src/sneaky.ts',
      'pg-import: apps/api/src/raw.ts',
      'pg-dependency: apps/web/package.json',
      'audit-append: packages/work-control/src/shortcut.ts',
      'action-insert: apps/api/src/routes/shortcut.ts',
    ]);
  });
});
