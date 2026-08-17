/**
 * `pnpm gate` runs what CI runs.
 *
 * CI is three jobs — `verify`, `ontology`, `build` — so there is no single command a
 * contributor can run to answer "will this pass?". The answer was assembled by reading
 * `ci.yml`, and it was assembled wrong: a week of work went in under "gates green" while
 * `format:check` failed, because four of the seven steps looked like the important ones and
 * the list was never checked against the file. `pnpm gate` is that list, made runnable.
 *
 * A hand-maintained mirror of a CI config drifts the first time somebody adds a step, and it
 * drifts SILENTLY — the mirror keeps passing, which is the failure mode it was built to
 * prevent. So the mirror is asserted against its source here instead of being trusted.
 *
 * WHAT THIS CHECKS AND WHAT IT DOES NOT. It compares the set of `pnpm <script>` invocations
 * in `ci.yml` against the set `pnpm gate` transitively runs. It is therefore blind to a CI
 * step that is not a pnpm script — the bubblewrap provisioning, `pnpm install
 * --frozen-lockfile`, and the `actions/*` setup steps are environment, not gates, and are
 * listed as exempt below so that "not a gate" is a claim on the record rather than an
 * omission. It is also blind to ORDER and to a step that passes different arguments.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

/**
 * CI steps that run a pnpm script but are not gates.
 *
 * Only environment preparation belongs here. Anything that can FAIL for a reason a
 * contributor should have caught locally is a gate and belongs in `pnpm gate`.
 */
const NOT_A_GATE: readonly string[] = [
  'install', // dependency installation, not a check
];

/** Every `pnpm <script>` CI invokes, from the workflow file itself. */
function scriptsCiRuns(): ReadonlySet<string> {
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const invoked = [...workflow.matchAll(/\bpnpm\s+([a-z][a-z0-9:-]*)/g)].map((match) => match[1]!);
  // A regex that matched nothing would make every assertion below vacuously true — the exact
  // shape of failure this file exists to catch.
  expect(
    invoked.length,
    'no pnpm invocations parsed out of .github/workflows/ci.yml',
  ).toBeGreaterThan(4);
  return new Set(invoked.filter((script) => !NOT_A_GATE.includes(script)));
}

/** Everything `pnpm gate` reaches, following `pnpm <script>` references transitively. */
function scriptsGateRuns(): ReadonlySet<string> {
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<
    string,
    string
  >;
  const reached = new Set<string>();
  const walk = (name: string): void => {
    if (reached.has(name)) return;
    reached.add(name);
    const body = scripts[name];
    if (body === undefined) return;
    for (const match of body.matchAll(/\bpnpm\s+([a-z][a-z0-9:-]*)/g)) walk(match[1]!);
  };
  walk('gate');
  reached.delete('gate');
  return reached;
}

describe('the local gate command and CI agree on what a gate is', () => {
  it('runs every gate CI runs', () => {
    const missing = [...scriptsCiRuns()].filter((script) => !scriptsGateRuns().has(script));
    expect(
      missing,
      'CI runs these and `pnpm gate` does not, so a contributor who runs the gate and sees ' +
        'green can still be red on push — which is how format:check stayed broken for a week',
    ).toEqual([]);
  });

  it('claims no gate CI does not run', () => {
    // The reverse direction matters less but is not free: a gate only in the local command
    // is one CI will not enforce, so it fails on the contributor's machine and lands anyway.
    const ci = scriptsCiRuns();
    const extra = [...scriptsGateRuns()].filter((script) => !ci.has(script));
    expect(
      extra,
      'these run locally under `pnpm gate` and are not enforced by CI, so they are advisory ' +
        'while reading as required',
    ).toEqual([]);
  });

  it('exempts nothing that could fail as a gate', () => {
    // `NOT_A_GATE` is an escape hatch, so it is bounded here rather than left to grow. Each
    // entry has to be environment preparation; the moment a real check is parked in this list
    // the list stops meaning anything.
    expect(NOT_A_GATE).toEqual(['install']);
  });
});
