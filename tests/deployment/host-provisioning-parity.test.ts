/**
 * Every workflow that runs the gate provisions the same host contract.
 *
 * WHY THIS EXISTS. `release.yml` gates the `v1.0.0` tag and is criterion 5 of ADR 0004. Until
 * 2026-08-20 it installed bubblewrap and nothing else, while `ci.yml` had learned — one painful
 * run at a time — that a clean machine also needs pandoc, python3, a PostgreSQL 18 client,
 * `/usr/bin/node` and a permissive user-namespace sysctl.
 *
 * Nothing caught the divergence because `release.yml` HAD NEVER RUN. There were no tags. A
 * workflow that has never executed is not covered by anything, and its bugs are invisible until
 * the one moment it matters, which here would have been the release.
 *
 * The duplication is now gone: both workflows `uses: ./.github/actions/provision-host`. This
 * test asserts that they do, so the next person who inlines "just one more apt-get" into one
 * workflow is told immediately rather than at a tag.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const ACTION = '.github/actions/provision-host';

const workflow = (name: string): string =>
  readFileSync(join(ROOT, '.github', 'workflows', `${name}.yml`), 'utf8');

/** Jobs that run `pnpm gate`, or any part of it that touches the host contract. */
const GATE_WORKFLOWS = ['ci', 'release'] as const;

describe('every workflow that runs the gate provisions the same host contract', () => {
  it.each(GATE_WORKFLOWS)('%s.yml uses the shared provisioning action', (name) => {
    expect(
      workflow(name),
      `${name}.yml must provision the host through ${ACTION} rather than its own apt-get steps`,
    ).toContain(`uses: ./${ACTION}`);
  });

  it('no gate workflow inlines host provisioning of its own', () => {
    // The composite action is the only place `apt-get install` belongs. An inline one in a
    // workflow is how the two drifted the first time.
    for (const name of GATE_WORKFLOWS) {
      const inlined = [...workflow(name).matchAll(/apt-get install[^\n]*/g)].map((m) => m[0]);
      expect(inlined, `${name}.yml installs packages outside ${ACTION}`).toEqual([]);
    }
  });

  it('the shared action still provisions all six requirements', () => {
    // Named individually rather than counted. A count passes when one is swapped for another,
    // and each of these cost a failed run to discover.
    const action = readFileSync(join(ROOT, ACTION, 'action.yml'), 'utf8');
    for (const required of [
      'bubblewrap',
      'pandoc',
      'python3',
      'postgresql-client-18',
      '/usr/bin/node',
      'apparmor_restrict_unprivileged_userns',
    ]) {
      expect(action, `${ACTION} no longer provisions ${required}`).toContain(required);
    }
  });

  it('every gate workflow can be pointed at the self-hosted runner', () => {
    // A workflow pinned to `ubuntu-latest` cannot run while Actions billing is failing, which
    // is the state that made this repository's CI stop twice. release.yml was pinned.
    for (const name of GATE_WORKFLOWS) {
      const pinned = [...workflow(name).matchAll(/runs-on: ubuntu-latest/g)];
      expect(
        pinned,
        `${name}.yml pins runs-on to ubuntu-latest instead of vars.RUNNER_LABEL`,
      ).toEqual([]);
    }
  });
});
