/**
 * Every file the documentation points at exists.
 *
 * The docs here are unusually specific — the threat model states controls as tables of
 * `Where` and `Proven by`, the runbook names the migration that installs a guard, the
 * deployment contract names the verifier that enforces each rule. 75 repo-relative paths
 * across the tree, and that specificity is the reason the documents are worth reading.
 *
 * It is also a hand-maintained index into a moving tree. A renamed test file does not break
 * the build; it breaks the document, silently, by leaving a claim pointing at nothing — and a
 * control whose evidence cannot be found is indistinguishable from one that was never true.
 *
 * Audited when this was written: all 75 resolved. Nothing was wrong. What was missing is that
 * nothing would notice if something became wrong, which is the only reason this exists.
 *
 * SCOPE, because a looser rule would be worse than none. Only citations beginning with a
 * top-level directory of this repository are checked. Deliberately excluded:
 *
 *   - host paths (`/etc/kf/...`) — they describe a machine, not this tree;
 *   - backup artefacts (`roles.sql`, `dump.pgcustom`, `backup.manifest.json`) — produced by a
 *     run, and asserting they exist here would be asserting something false;
 *   - commands, SQL fragments and unit names, which are not paths at all.
 *
 * WHAT IT CANNOT DO. It checks the reference RESOLVES, not that the file says what the
 * document claims it says. "Secrets are read from files, not the environment / proven by
 * tests/permissions/secrets.test.ts" could point at a file testing something else entirely.
 * Reading those rows against their tests is human review; this automates the part that rots.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const DOCS = join(ROOT, 'docs');

/** Top-level directories of this repository. A citation starting with one is a path claim. */
const REPO_ROOTS = [
  'docs/',
  'scripts/',
  'packages/',
  'apps/',
  'tests/',
  'deploy/',
  'database/',
  'ontology/',
  'generated/',
  '.github/',
] as const;

function markdownFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(path));
    else if (entry.name.endsWith('.md')) found.push(path);
  }
  return found.sort();
}

/** Every backticked repo-relative path in the docs tree, with the file that cites it. */
function citations(): ReadonlyArray<{ readonly document: string; readonly path: string }> {
  const found: { document: string; path: string }[] = [];
  for (const file of markdownFiles(DOCS)) {
    for (const match of readFileSync(file, 'utf8').matchAll(/`([^`\n]+)`/g)) {
      const candidate = match[1]!.trim();
      if (REPO_ROOTS.some((root) => candidate.startsWith(root))) {
        found.push({ document: relative(ROOT, file), path: candidate });
      }
    }
  }
  return found;
}

describe('the documentation cites files that exist', () => {
  it('resolves every repo-relative path named in docs/', () => {
    const broken = citations()
      .filter(({ path }) => !existsSync(join(ROOT, path)))
      .map(({ document, path }) => `${document} -> ${path}`);
    expect(
      broken,
      'these documents name a file in this repository that is not there. A reader following ' +
        'the citation finds nothing, and a claim whose evidence cannot be located is ' +
        'indistinguishable from one that was never true.',
    ).toEqual([]);
  });

  it('finds enough citations to be worth checking', () => {
    // Guards the parse rather than the tree. A regex that stopped matching would report a
    // spotless documentation set containing no claims at all, which is the most reassuring
    // possible way to be broken.
    expect(
      citations().length,
      'suspiciously few repo-relative citations found; the markdown scan is wrong',
    ).toBeGreaterThan(50);
  });

  it('covers the documents that make the most specific claims', () => {
    // Named explicitly so that deleting a document — or moving it out of docs/ — is a visible
    // change here rather than a quiet reduction in what this test covers.
    const documents = new Set(citations().map(({ document }) => document));
    for (const required of [
      'docs/threat-model/README.md',
      'docs/deployment/private-host.md',
      'docs/operating-model/runbook.md',
      'docs/backup-and-restore/README.md',
    ]) {
      expect(
        documents,
        `${required} no longer cites any file in this repository, so this check now says ` +
          'nothing about it',
      ).toContain(required);
    }
  });
});
