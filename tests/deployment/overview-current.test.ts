/**
 * The control record is a projection, so it must be regenerable and compared.
 *
 * `docs/generated/overview.html` is written by `kf overview` from the specification and the
 * Warrant corpus. Committing it without checking it would recreate the defect it was built to
 * remove: the README's status block named an accepted revision one revision out of date, and
 * nothing noticed, because a human had to remember.
 *
 * The output carries no wall-clock timestamp precisely so this comparison is possible.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');
const PAGE = join(ROOT, 'docs', 'generated', 'overview.html');

describe('the committed control record still describes this tree', () => {
  it('regenerates byte-identically, so the page cannot go stale unnoticed', () => {
    // Rendered to a scratch path, never over the committed one. A check that rewrites the file
    // it is checking passes by repairing the thing it was meant to report.
    const scratch = join(mkdtempSync(join(tmpdir(), 'kf-overview-')), 'overview.html');
    execFileSync(
      process.execPath,
      [join(ROOT, 'apps/api/dist/cli.js'), 'overview', '--out', scratch],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(
      readFileSync(scratch, 'utf8'),
      'docs/generated/overview.html differs from a fresh `kf overview`. The specification or ' +
        'the Warrant corpus moved and the page did not. Run `kf overview` and commit the result.',
    ).toBe(readFileSync(PAGE, 'utf8'));
  });

  it('is generated, not typed — it carries no wall-clock timestamp', () => {
    const page = readFileSync(PAGE, 'utf8');
    // An ISO instant or a rendered date in the body would differ on every build and make the
    // comparison above meaningless. The commit identifies the state instead.
    const stamps = [...page.matchAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g)].map((m) => m[0]);
    expect(
      stamps,
      'the page embeds a timestamp. Every build would differ, the drift check above would fail ' +
        'for no reason, and it would then be deleted or ignored.',
    ).toEqual([]);
  });

  it('reports figures the specification actually contains', () => {
    const page = readFileSync(PAGE, 'utf8');
    const sas = readFileSync(
      join(ROOT, 'docs', 'sas', 'KF_Software_Architecture_Specification.md'),
      'utf8',
    );
    const requirements = new Set([...sas.matchAll(/^\| (KF-SAS-RQ-\d+) \|/gm)].map((m) => m[1]!))
      .size;
    const phases = [...sas.matchAll(/^### Phase \d+ — /gm)].length;
    expect(requirements, 'no requirements parsed from §106').toBeGreaterThan(0);
    expect(phases, 'no phases parsed from §98').toBeGreaterThan(0);
    // The page writes a ratio denominator as `&thinsp;/&thinsp;N`, hair spaces either side of
    // the slash. Both counts share that shape, so one literal covers both.
    expect(page, 'the requirement total on the page disagrees with §106').toContain(
      `&thinsp;/&thinsp;${String(requirements)}`,
    );
    expect(page, 'the phase count on the page disagrees with §98').toContain(
      `&thinsp;/&thinsp;${String(phases)}`,
    );
  });
});
