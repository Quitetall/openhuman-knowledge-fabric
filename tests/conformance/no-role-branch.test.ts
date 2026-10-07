/**
 * One dashboard, scoped by grants, and nothing branches on a role or a title (KF-SAS-RQ-262,
 * ADR 0040 decision 2; KF-WAR-0005 OBL-006).
 *
 * The dashboard is the same screen for the owner, an engineer and a person with one grant: its
 * panels come from `DASHBOARD_LAYOUT`, a constant, and their contents from the reader's grants.
 * The way that promise is usually broken is small and local — `if (role === 'ceo')` in a panel,
 * a `switch` on a job title in a page — and it would pass every test that happens to log in as
 * the role it was written for. So the surfaces of the experience are read here as source text and
 * refused if they compare anything role- or title-shaped, or name any role the system knows: the
 * seeded vocabulary (read from the migrations that insert it) and the fixture's preset roles.
 *
 * Planted and seen to fail: `if (caller.actingRoleId === x)`, a `switch (role)` and a literal
 * `'chief_executive'` in `apps/api/src/routes/experience/dashboard.ts` each fail this test.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLE_DEFINITIONS } from '../../fixtures/veracier/roles.mjs';

const ROOT = join(import.meta.dirname, '..', '..');

/** The experience's surfaces: the API that assembles the dashboard and the pages that show it. */
const SURFACES = [
  'apps/api/src/routes/experience.ts',
  'apps/api/src/routes/experience',
  'packages/documents/src/organization-overview.ts',
  'apps/web/src/app/page.tsx',
  'apps/web/src/app/dashboard',
  'apps/web/src/app/master-document',
  'apps/web/src/app/components',
];

function files(path: string): string[] {
  const full = join(ROOT, path);
  if (!existsSync(full)) return [];
  if (statSync(full).isFile()) return [full];
  return readdirSync(full, { recursive: true })
    .map((entry) => join(full, String(entry)))
    .filter((file) => /\.(ts|tsx|mjs)$/.test(file) && !/\.test\.(ts|tsx|mjs)$/.test(file));
}

/** Source without comments, so a comment explaining the rule is not a violation of it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Every role id the vocabulary holds: the migrations' inserts and the fixture presets. */
function roleIds(): string[] {
  const ids = new Set<string>(ROLE_DEFINITIONS.map(([id]: readonly [string, string]) => id));
  const migrations = join(ROOT, 'database', 'migrations');
  for (const file of readdirSync(migrations)) {
    const sql = readFileSync(join(migrations, file), 'utf8');
    for (const block of sql.matchAll(
      /insert into org\.role\s*\(id, description\) values([\s\S]*?);/g,
    )) {
      for (const match of block[1]!.matchAll(/\(\s*'([a-z_]+)'/g)) ids.add(match[1]!);
    }
  }
  return [...ids].sort();
}

const BRANCHES = [
  /\b\w*(role|Role)(Id|_id|Name)?\b\s*(===|!==|==|!=)/,
  /(===|!==|==|!=)\s*\w*\.?\b\w*(role|Role)(Id|_id|Name)?\b/,
  /\b\w*(title|Title)\b\s*(===|!==|==|!=)\s*['"`]/,
  /switch\s*\(\s*[\w.]*(role|Role|title|Title)/,
  /\.(includes|has)\(\s*[\w.]*(role|Role)(Id|_id)?\s*\)/,
];

describe('no surface of the experience branches on a role or a title (KF-SAS-RQ-262)', () => {
  const sources = SURFACES.flatMap(files);
  const roles = roleIds();

  it('reads the surfaces it guards, and knows the vocabulary', () => {
    expect(sources.length).toBeGreaterThanOrEqual(5);
    expect(roles).toEqual(expect.arrayContaining(['technical_authority', 'chief_executive']));
  });

  it('compares nothing role- or title-shaped', () => {
    const found: string[] = [];
    for (const file of sources) {
      const lines = code(readFileSync(file, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        for (const pattern of BRANCHES) {
          if (pattern.test(line))
            found.push(`${relative(ROOT, file)}:${String(index + 1)}: ${line.trim()}`);
        }
      });
    }
    expect(found).toEqual([]);
  });

  it('names no role', () => {
    const found: string[] = [];
    for (const file of sources) {
      const text = code(readFileSync(file, 'utf8'));
      for (const role of roles) {
        if (new RegExp(`['"\`]${role}['"\`]`).test(text))
          found.push(`${relative(ROOT, file)}: ${role}`);
      }
    }
    expect(found).toEqual([]);
  });
});
