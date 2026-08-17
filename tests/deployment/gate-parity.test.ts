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
 * WHOLE COMMANDS ARE COMPARED, NOT SCRIPT NAMES. The first version of this file extracted a
 * script name with `/\bpnpm\s+([a-z][a-z0-9:-]*)/` and compared names. Review caught the hole
 * and it reproduced exactly: `pnpm --filter web lint` yields NO match, because the character
 * after the space is `-`. A CI step written with a flag would have been invisible to the side
 * that reads CI, so the "runs every gate CI runs" assertion would have passed while CI ran a
 * gate the local command did not. `pnpm run build` was worse — it captured `run`. Every fix
 * for that regex is another regex with another hole, so nothing is extracted now: the command
 * strings are compared verbatim, and a flag is just part of the string.
 *
 * The cost is strictness — CI writing `pnpm run test` while the gate says `pnpm test` fails
 * this test. That is the right direction to fail in, and the fix is to write them the same.
 *
 * TWO CI STEP SHAPES FAIL NOISILY RATHER THAN SILENTLY, measured against the parser rather
 * than reasoned about. A shell continuation (`pnpm test \`) is read as the literal
 * `'pnpm test \'`, and two commands on one line (`pnpm lint && pnpm test`) are read as one
 * string; neither matches a gate entry, so the suite fails and says the gate is missing a
 * command it appears to have. Confusing, but it fails CLOSED, which is why both are left
 * alone: the fix is to write the CI step as one command per line. Block scalars are fine —
 * `run: |` content lines are read individually and each parses correctly.
 *
 * WHAT IT STILL DOES NOT COVER. Only `pnpm` commands are compared. CI steps that are not pnpm
 * commands are environment rather than gates: the bubblewrap provisioning and the `actions/*`
 * setup steps. The one non-pnpm command inside `pnpm gate` — the `git diff` that proves
 * `generated/` is current — is therefore outside the comparison, so it is pinned by name in
 * the last test rather than left to be dropped silently. A whole CI job whose steps are all
 * non-pnpm (a `bash scripts/check.sh` gate, say) would be invisible; if one is ever added,
 * this comparison has to grow to meet it. Order is not checked, and `pnpm gate` is expected
 * to stay FLAT — the commands are read from its own `&&` chain and not followed into a
 * sub-script, so delegating part of the gate to another script would fail here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

/**
 * CI commands that are not gates.
 *
 * Only environment preparation belongs here. Anything that can FAIL for a reason a
 * contributor should have caught locally is a gate and belongs in `pnpm gate`.
 */
const NOT_A_GATE: readonly string[] = [
  'pnpm install --frozen-lockfile', // dependency installation, not a check
];

/** The check that `generated/` is current, which is a gate but not a pnpm command. */
const GENERATED_IS_CURRENT = 'git diff --exit-code -- generated/';

/**
 * Every pnpm command CI runs, verbatim.
 *
 * Handles both step forms: `- run: pnpm lint` and a line inside a `run: |` block. Anything
 * that does not start with `pnpm` after the prefix is stripped — `sudo apt-get update`, the
 * `if !` line wrapping the generated/ diff — is not a pnpm command and is not compared.
 */
function ciCommands(): ReadonlySet<string> {
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const commands = workflow
    .split('\n')
    .map((line) => line.replace(/^\s*-?\s*(?:run:\s*)?/, '').trim())
    .filter((line) => line.startsWith('pnpm '));
  // A parse that found nothing would make every assertion below vacuously true — the exact
  // shape of failure this file exists to catch. Pinning a command rather than a count,
  // because a count stays satisfiable by the wrong lines.
  expect(commands, 'ci.yml parsed but no `pnpm test` step found — the parse is wrong').toContain(
    'pnpm test',
  );
  return new Set(commands.filter((command) => !NOT_A_GATE.includes(command)));
}

/** Every pnpm command `pnpm gate` runs, verbatim. */
function gateCommands(): ReadonlySet<string> {
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<
    string,
    string
  >;
  const gate = scripts.gate;
  expect(gate, 'package.json declares no `gate` script').toBeTypeOf('string');
  return new Set(
    gate!
      .split('&&')
      .map((command) => command.trim())
      .filter((command) => command.startsWith('pnpm ')),
  );
}

describe('the local gate command and CI agree on what a gate is', () => {
  it('runs every gate CI runs', () => {
    const gate = gateCommands();
    const missing = [...ciCommands()].filter((command) => !gate.has(command));
    expect(
      missing,
      'CI runs these and `pnpm gate` does not, so a contributor who runs the gate and sees ' +
        'green can still be red on push — which is how format:check stayed broken for a week. ' +
        'If the gate looks like it already has one of these, check the SHAPE: commands are ' +
        'compared verbatim, so `pnpm lint && pnpm test` on one CI line does not match a gate ' +
        'that runs them as two, and a trailing `\\` continuation is part of the string.',
    ).toEqual([]);
  });

  it('claims no gate CI does not run', () => {
    // The reverse direction matters less but is not free: a gate only in the local command is
    // one CI will not enforce, so it fails on the contributor's machine and lands anyway.
    const ci = ciCommands();
    const extra = [...gateCommands()].filter((command) => !ci.has(command));
    expect(
      extra,
      'these run locally under `pnpm gate` and are not enforced by CI, so they are advisory ' +
        'while reading as required',
    ).toEqual([]);
  });

  it('keeps the two gates that are not pnpm commands', () => {
    // Pinned by name because the comparison above cannot see them. `git diff --exit-code --
    // generated/` is what proves the committed `generated/` tree matches what the ontology
    // compiler emits; drop it from the gate script and both assertions above stay green while
    // the gate stops checking it. The `NOT_A_GATE` list is pinned for the same reason — it is
    // an escape hatch, and an unbounded escape hatch is where this kind of check goes to die.
    const gate = (
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>
    ).gate;
    expect(gate).toContain(GENERATED_IS_CURRENT);
    expect(NOT_A_GATE).toEqual(['pnpm install --frozen-lockfile']);
  });
});
