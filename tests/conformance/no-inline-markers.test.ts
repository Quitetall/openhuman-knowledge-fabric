/**
 * KF-SAS-RQ-018: a known gap SHALL be recorded in an enumerable place, and SHALL NOT be recorded
 * only as an inline source comment.
 *
 * SAS Law 9 claims "there is not one" marker in this repository. On 2026-09-24 that was true and
 * nothing held it. ESLint's `no-warning-comments` (eslint.config.js) now covers what ESLint
 * reads — .ts, .tsx, .mjs, .cjs, .js. This covers everything else a person writes comments in:
 * migrations, shell scripts, systemd units, PostgreSQL and nginx config, YAML, TOML, the
 * Dockerfile, the husky hook.
 *
 * Deliberately NOT scanned: Markdown and HTML, which are prose and must be able to NAME the
 * markers to state this rule (SAS §7 Law 9 does); the lockfile and LICENSE/NOTICE, which are
 * third-party text; binaries. Case-insensitive and whole-word, the same terms as the ESLint rule.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

// Assembled, so this file does not contain the words it forbids and the scan of it (if any rule
// ever widened to .ts) would not be self-defeating.
const TERMS = ['TO' + 'DO', 'FIX' + 'ME', 'X' + 'XX', 'HA' + 'CK'];
const MARKER = new RegExp(`\\b(${TERMS.join('|')})\\b`, 'i');

/** Files ESLint reads (covered there), prose, third-party text, and binaries. */
const SKIP = /\.(ts|tsx|mts|cts|mjs|cjs|js|md|html|png|jpe?g|gif|ico|pdf|woff2?|ttf|gz|zip)$/i;
const SKIP_EXACT = new Set(['pnpm-lock.yaml', 'LICENSE', 'NOTICE']);

/** Tracked files plus untracked ones git would not ignore: what a commit could contain. */
function candidateFiles(root: string): string[] {
  const listed = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return [...new Set(listed.split('\0').filter((path) => path !== ''))].filter(
    (path) => !SKIP.test(path) && !SKIP_EXACT.has(path),
  );
}

/** `path:line: text` for every marker in the given files. Unreadable (deleted) files are skipped. */
function findMarkers(root: string, paths: string[]): string[] {
  const found: string[] = [];
  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(join(root, path), 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue;
    text.split('\n').forEach((line, index) => {
      if (MARKER.test(line)) found.push(`${path}:${index + 1}: ${line.trim()}`);
    });
  }
  return found;
}

describe('no inline gap markers outside what ESLint reads (KF-SAS-RQ-018)', () => {
  const files = candidateFiles(ROOT);

  it('scans the file kinds it claims to (non-vacuous)', () => {
    for (const extension of ['.sql', '.sh', '.service', '.timer', '.conf', '.yaml', '.toml']) {
      expect(
        files.some((path) => path.endsWith(extension)),
        `no ${extension} file reached the scan`,
      ).toBe(true);
    }
    expect(files.filter((path) => path.endsWith('.sql')).length).toBeGreaterThan(50);
  });

  it('finds none; a known gap belongs in SAS §100, an ADR or a named warning', () => {
    expect(findMarkers(ROOT, files)).toEqual([]);
  });

  it('finds a planted marker in SQL, shell and config comments, in any case', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kf-markers-'));
    try {
      const planted = {
        'a.sql': `select 1; -- ${TERMS[0]}: index this\n`,
        'b.sh': `#!/bin/sh\n# ${TERMS[1]!.toLowerCase()} quoting\n`,
        'c.conf': `x = 1  # ${TERMS[3]} around the timeout\n`,
        'd.sql': '-- the word todos and xxxl are not markers\n',
      };
      for (const [name, body] of Object.entries(planted)) writeFileSync(join(dir, name), body);
      const found = findMarkers(dir, Object.keys(planted)).map((hit) => hit.split(':')[0]);
      expect(found).toEqual(['a.sql', 'b.sh', 'c.conf']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
