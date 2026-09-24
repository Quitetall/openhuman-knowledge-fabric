/**
 * Classification is a closed, totally ordered set, compared by rank (KF-SAS-RQ-036).
 *
 * The order is declared once, in ontology/meta.yaml, and the database mirrors it. TypeScript
 * carries its own rank maps in several places — authorization, projections, the document
 * compiler, the ingest route — because each needs a comparison before or without a database
 * round trip. A map that drifted from the declaration would compare two classifications
 * differently from the database, and the disagreement would surface as a record shown in one
 * surface and hidden in another.
 *
 * The maps are found, not listed: any object literal in production source mapping exactly the
 * declared classifications to integers is a rank map, and each must equal the declaration's
 * order. A new copy is held to the same rule without anybody remembering to add it here.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

/** The `classifications:` list of ontology/meta.yaml, in declared order. */
function declaredOrder(): string[] {
  const meta = readFileSync(join(ROOT, 'ontology', 'meta.yaml'), 'utf8');
  const block = /^classifications:\n((?:[ \t]+-[ \t]+[a-z_]+\n)+)/mu.exec(meta);
  expect(block, 'ontology/meta.yaml declares no classifications list').not.toBeNull();
  return [...block![1]!.matchAll(/-[ \t]+([a-z_]+)/gu)].map((m) => m[1]!);
}

interface RankMap {
  readonly path: string;
  readonly ranks: Readonly<Record<string, number>>;
}

/** Every `{ name: <int>, … }` literal over exactly the given names, in the given sources. */
function rankMaps(files: readonly { path: string; text: string }[], names: readonly string[]) {
  const found: RankMap[] = [];
  const entry = `(?:${names.join('|')})\\s*:\\s*\\d+`;
  const literal = new RegExp(`\\{\\s*${entry}(?:\\s*,\\s*${entry})*\\s*,?\\s*\\}`, 'gu');
  for (const { path, text } of files) {
    for (const match of text.matchAll(literal)) {
      const ranks = Object.fromEntries(
        [...match[0].matchAll(/([a-z_]+)\s*:\s*(\d+)/gu)].map((m) => [m[1]!, Number(m[2])]),
      );
      if (Object.keys(ranks).length >= 3) found.push({ path, ranks });
    }
  }
  return found;
}

function productionSources(): { path: string; text: string }[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => /^(?:packages|apps)\/.*\.tsx?$/u.test(path))
    .filter(
      (path) => !/\.test\.tsx?$/u.test(path) && !/(?:^|\/)(?:dist|node_modules)\//u.test(path),
    )
    .map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') }));
}

describe('classification rank maps equal the declared order (KF-SAS-RQ-036)', () => {
  const order = declaredOrder();
  const expected = Object.fromEntries(order.map((name, rank) => [name, rank]));

  it('reads the declaration it compares against', () => {
    expect(order).toEqual(['public', 'internal', 'confidential', 'restricted']);
  });

  it('finds every rank map in production source, and each equals ontology/meta.yaml', () => {
    const maps = rankMaps(productionSources(), order);
    // Not vacuous: the four known copies are found.
    expect(maps.map((map) => map.path).sort()).toEqual(
      expect.arrayContaining([
        'apps/api/src/routes/documents/ingest-route.ts',
        'packages/authorization/src/access-grants.ts',
        'packages/documents/src/compiler/primitives.ts',
        'packages/projections/src/engine.ts',
      ]),
    );
    for (const map of maps) expect(map.ranks, map.path).toEqual(expected);
  });

  it('refuses a planted map that swaps two ranks or omits one', () => {
    const planted = rankMaps(
      [
        {
          path: 'planted/swapped.ts',
          text: 'const R = { public: 0, internal: 2, confidential: 1, restricted: 3 };',
        },
        { path: 'planted/short.ts', text: 'const R = { public: 0, internal: 1, restricted: 3 };' },
      ],
      order,
    );
    expect(planted).toHaveLength(2);
    for (const map of planted) expect(map.ranks).not.toEqual(expected);
  });
});
