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

import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
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

/**
 * Markdown documents, not the links to them. `docs/decisions/NNNN-*.md` are symbolic links to
 * the ADR atoms, kept so every citation of the old path — signed authority records included —
 * still resolves; the atom is read at its own path, and the links are checked below.
 */
function markdownFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(path);
  }
  return found.sort();
}

function symbolicLinks(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...symbolicLinks(path));
    else if (entry.isSymbolicLink()) found.push(path);
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

/** Every relative markdown link in README.md and docs/, resolved against its own document. */
function relativeLinks(): ReadonlyArray<{ readonly document: string; readonly target: string }> {
  const found: { document: string; target: string }[] = [];
  // `docs/warrants/generated/` and `docs/decisions/generated/` are OpenWarrant's output, which
  // writes its links relative to the repository root rather than to the page. They are
  // regenerated, never edited here, so the fix belongs upstream; checking them would only fail
  // on every regeneration until then.
  const generated = [join(DOCS, 'warrants', 'generated'), join(DOCS, 'decisions', 'generated')];
  for (const file of [join(ROOT, 'README.md'), ...markdownFiles(DOCS)]) {
    if (generated.some((directory) => file.startsWith(directory))) continue;
    const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const link = match[1]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith('#')) continue;
      const target = decodeURIComponent(link.split('#')[0]!);
      if (target === '') continue;
      found.push({ document: relative(ROOT, file), target: join(dirname(file), target) });
    }
  }
  return found;
}

describe('the documentation links to files that exist', () => {
  // The backticked-path check above did not look at links, so `README.md` linked an empty
  // `docs/security/` for as long as the directory had no tracked file, and passed.
  it('resolves every relative markdown link', () => {
    const broken = relativeLinks()
      .filter(({ target }) => !existsSync(target))
      .map(({ document, target }) => `${document} -> ${relative(ROOT, target)}`);
    expect(broken, 'these links lead nowhere').toEqual([]);
  });

  it('finds enough links to be worth checking', () => {
    expect(relativeLinks().length).toBeGreaterThan(20);
  });

  it('keeps every old ADR path pointing at its atom', () => {
    const links = symbolicLinks(DOCS);
    const decisions = links.filter((path) => dirname(path) === join(DOCS, 'decisions'));
    expect(decisions.length, 'no ADR path links found; the scan is wrong').toBeGreaterThan(30);
    const broken = links
      .filter(
        (path) =>
          !existsSync(path) ||
          (dirname(path) === join(DOCS, 'decisions') && !readlinkSync(path).startsWith('atoms/')),
      )
      .map((path) => `${relative(ROOT, path)} -> ${readlinkSync(path)}`);
    expect(broken, 'these links lead nowhere, or away from the atoms').toEqual([]);
  });
});
