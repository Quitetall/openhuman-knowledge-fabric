/**
 * Every control the threat model claims points at a file that exists.
 *
 * `docs/threat-model/README.md` states its controls as tables with `Where` and `Proven by`
 * columns — 65 rows naming implementation files and the tests that hold them. That is the
 * right shape for a threat model: a claim with an address rather than a paragraph. It is also
 * a hand-maintained index into a moving tree, and nothing checked it.
 *
 * A renamed test file does not break the build. It breaks the threat model, silently, by
 * leaving a control pointing at nothing — and a control whose evidence cannot be found is
 * indistinguishable from one that was never true. That is the failure this guards.
 *
 * WHAT THIS DOES NOT DO, stated because the gap is larger than the check. It verifies the
 * reference RESOLVES, not that the named test asserts the named control. "Secrets are read
 * from files, not the environment / proven by tests/permissions/secrets.test.ts" could be
 * satisfied by a file that tests something else entirely, and no mechanical check can tell.
 * Reading 65 rows against their tests is a human review, and this is not a substitute for one
 * — it is the part that can be automated, which is the part that rots fastest.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const THREAT_MODEL = join(ROOT, 'docs', 'threat-model', 'README.md');

/** Backticked paths in the non-heading cells of every control table row. */
function citedPaths(): readonly string[] {
  const body = readFileSync(THREAT_MODEL, 'utf8');
  const rows = body
    .split('\n')
    .filter((line) => line.startsWith('|') && line.split('|').length >= 4)
    .filter((line) => !line.includes('---'));
  expect(rows.length, 'no control table rows found in the threat model').toBeGreaterThan(20);

  const paths = new Set<string>();
  for (const row of rows) {
    // Skip the first cell: it is the control's prose, and a path there is descriptive rather
    // than a claim about where the control lives.
    for (const cell of row.replace(/^\|/, '').split('|').slice(1)) {
      for (const match of cell.matchAll(/`([^`]+)`/g)) {
        const candidate = match[1]!;
        if (candidate.includes('/') && candidate.includes('.')) paths.add(candidate);
      }
    }
  }
  return [...paths].sort();
}

describe('the threat model cites code that exists', () => {
  it('resolves every file named as an implementation or as evidence', () => {
    const missing = citedPaths().filter((path) => !existsSync(join(ROOT, path)));
    expect(
      missing,
      'the threat model names these as where a control lives or what proves it, and they are ' +
        'not there. A control whose evidence cannot be found is indistinguishable from one ' +
        'that was never true.',
    ).toEqual([]);
  });

  it('cites enough to be worth checking', () => {
    // Guards the parse. A regex that stopped matching would report a clean threat model with
    // no controls in it, which is the most reassuring possible way to be broken.
    expect(
      citedPaths().length,
      'suspiciously few cited paths; the table parse is wrong',
    ).toBeGreaterThan(15);
  });

  it('keeps the open-items table honest about what has no owner in code', () => {
    // Item 5 is the one open item the document itself calls "a genuine gap" rather than a
    // decision for an operator: every scheduled unit routes failure to `kf-alert@%n.service`
    // and no such unit is shipped. Pinned here so that if the unit is ever added, this test
    // fails and forces the threat model to stop describing it as missing.
    const body = readFileSync(THREAT_MODEL, 'utf8');
    expect(
      body,
      'the threat model no longer records the alert-unit gap; if an alert unit now ships, say ' +
        'so here and in docs/deployment/private-host.md',
    ).toContain('kf-alert@');
    expect(
      existsSync(join(ROOT, 'deploy', 'systemd', 'kf-alert@.service')),
      'an alert unit now ships, so the threat model and the private-host blockers must stop ' +
        'listing it as absent',
    ).toBe(false);
  });
});
