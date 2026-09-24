/**
 * No capture surface has a private path to storage (KF-SAS-RQ-203, ADR 0024, ADR 0034 §5).
 *
 * Every surface dispatches the same typed acts through the same seam, and none reaches storage
 * directly. The seam is the API: `apps/api` hosts the dispatcher, and `packages/database` is the
 * one module holding the driver. The processes that legitimately open a database connection of
 * their own are named below — the API, the worker, the checkpoint signer, the storage sweep and
 * the attestor — and every OTHER application is a surface: the web app today, a chat
 * integration or anything else tomorrow. A surface must hold no driver, no `@kf/database`, no
 * dispatcher, and no SQL write statement; it talks to the API over HTTP.
 *
 * `write-seam-boundary.test.ts` already keeps the driver inside `packages/database`. This is the
 * sharper rule for surfaces: not even the sanctioned connection module, and no SQL that writes.
 * The scan is textual, over tracked and untracked-unignored files, and runs against a planted
 * tree too, because a gate that cannot fail reads as a guarantee nobody checked.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
/**
 * The driver's name, assembled: this file plants driver imports as text, and
 * write-seam-boundary.test.ts scans every test file for a literal one.
 */
const PG = ['p', 'g'].join('');

/** Applications that own a database connection by design. Everything else under apps/ is a surface. */
const CONNECTION_OWNERS: ReadonlySet<string> = new Set([
  'api',
  'worker',
  'checkpoint',
  'kf-storage',
  'attestor',
]);

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;
/** Any import of a PostgreSQL client, the connection module, or the dispatcher. */
const FORBIDDEN_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"](?:pg|pg\/[^'"]*|postgres|@kf\/database|@kf\/orchestrator)['"]/mu;
const FORBIDDEN_DEPENDENCIES = ['pg', 'postgres', '@kf/database', '@kf/orchestrator'];
/** SQL that writes. `update … set` needs both words so prose like "update the page" passes. */
const SQL_WRITE =
  /\b(?:insert\s+into|delete\s+from|update\s+[A-Za-z_][\w."]*\s+set|merge\s+into|truncate\s+(?:table\s+)?[A-Za-z_]|copy\s+[A-Za-z_][\w."]*\s+from|alter\s+table|drop\s+table|create\s+table)\b/iu;

/** The surface an app-relative path belongs to, or undefined for a connection owner / non-app. */
function surfaceOf(path: string): string | undefined {
  const match = /^apps\/([^/]+)\//u.exec(path);
  if (match === null) return undefined;
  return CONNECTION_OWNERS.has(match[1]!) ? undefined : match[1];
}

/** Every violation, as `rule: path`. Pure, so it runs against a planted tree. */
export function surfaceViolations(files: readonly SourceFile[]): string[] {
  const violations: string[] = [];
  for (const { path, text } of files) {
    if (surfaceOf(path) === undefined) continue;
    if (path.endsWith('package.json')) {
      const manifest = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
      for (const dependency of FORBIDDEN_DEPENDENCIES) {
        const declared = ['dependencies', 'devDependencies', 'peerDependencies'].some(
          (field) => manifest[field]?.[dependency] !== undefined,
        );
        if (declared) violations.push(`dependency ${dependency}: ${path}`);
      }
      continue;
    }
    if (!SOURCE.test(path)) continue;
    if (FORBIDDEN_IMPORT.test(text)) violations.push(`storage-import: ${path}`);
    if (SQL_WRITE.test(text)) violations.push(`sql-write: ${path}`);
  }
  return violations;
}

function appTree(): SourceFile[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => path.startsWith('apps/'))
    .filter((path) => !/(?:^|\/)(?:node_modules|dist|\.next)\//u.test(path))
    .filter((path) => SOURCE.test(path) || path.endsWith('package.json'))
    .map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') }));
}

describe('capture surfaces reach storage only through the API', () => {
  const tree = appTree();
  const surfaces = tree.filter((file) => surfaceOf(file.path) !== undefined);

  it('scans the surfaces it claims to scan', () => {
    // A scan over nothing passes. The web app is a surface, its capture form included, and the
    // connection owners are really there to be exempted.
    expect(surfaces.length).toBeGreaterThan(50);
    const paths = surfaces.map((file) => file.path);
    expect(paths).toContain('apps/web/package.json');
    expect(paths).toContain('apps/web/src/app/capture/page.tsx');
    expect(paths).toContain('apps/web/src/lib/api/capture.ts');
    for (const owner of CONNECTION_OWNERS) {
      expect(
        tree.some((file) => file.path.startsWith(`apps/${owner}/`)),
        owner,
      ).toBe(true);
    }
    // And the web capture client really does talk to the API route, so the rule is not vacuous.
    const client = surfaces.find((file) => file.path === 'apps/web/src/lib/api/capture.ts')!;
    expect(client.text).toContain('/capture/observation');
  });

  it('finds no driver, connection module, dispatcher or SQL write in any surface', () => {
    expect(surfaceViolations(tree)).toEqual([]);
  });

  it('refuses each planted violation, and only those', () => {
    const planted: SourceFile[] = [
      { path: 'apps/web/src/lib/sneaky.ts', text: `import { Pool } from '${PG}';\n` },
      { path: 'apps/web/src/app/x/route.ts', text: "const db = await import('@kf/database');\n" },
      {
        path: 'apps/chat/src/bot.ts',
        text: "import { createFabricDispatcher } from '@kf/orchestrator';\n",
      },
      {
        path: 'apps/chat/src/note.ts',
        text: 'await client.query(`INSERT INTO content.observation (id) values ($1)`);\n',
      },
      { path: 'apps/web/src/lib/fix.ts', text: 'sql`update core.object set title = ${t}`;\n' },
      { path: 'apps/web/src/lib/purge.ts', text: "q('DELETE FROM core.relation where 1=1');\n" },
      {
        path: 'apps/chat/package.json',
        text: JSON.stringify({ dependencies: { postgres: '^3' } }),
      },
      // Legitimate: the connection owners, prose that merely contains the words, and an HTTP call.
      {
        path: 'apps/api/src/routes/x.ts',
        text: `insert into core.object (id) values ($1)\nimport pg from '${PG}';\n`,
      },
      { path: 'apps/worker/src/y.ts', text: 'delete from core.outbox where id = $1\n' },
      { path: 'apps/web/src/app/copy.tsx', text: '<p>Update the note, then set it aside.</p>\n' },
      {
        path: 'apps/web/src/lib/ok.ts',
        text: "await fetch(`${api}/capture/observation`, { method: 'POST' });\n",
      },
      { path: 'apps/web/src/lib/pgish.ts', text: "import { pgTyped } from 'pg-typed';\n" },
    ];
    expect(surfaceViolations(planted)).toEqual([
      'storage-import: apps/web/src/lib/sneaky.ts',
      'storage-import: apps/web/src/app/x/route.ts',
      'storage-import: apps/chat/src/bot.ts',
      'sql-write: apps/chat/src/note.ts',
      'sql-write: apps/web/src/lib/fix.ts',
      'sql-write: apps/web/src/lib/purge.ts',
      'dependency postgres: apps/chat/package.json',
    ]);
  });
});
