/**
 * The release commands in the deployment contract use flags the pinned pnpm actually has.
 *
 * On 2026-08-25 the first attempt to build a release tree by following
 * `docs/deployment/private-host.md` verbatim died on its sixth command:
 *
 *     [ERROR] Unknown option: 'deploy-all-files'
 *
 * `packageManager` pins `pnpm@11.21.0`, and `--deploy-all-files` was removed from `pnpm deploy`
 * somewhere before it. Six lines of the contract could not run, and nothing said so, because
 * nobody had ever run them — the same reason the pandoc, python3, PostgreSQL-client and
 * `/usr/bin/node` requirements went undiscovered until CI moved off this workstation.
 *
 * This is the fourth defect of that exact shape found in one day: a documented instruction that
 * is false, in a document whose only purpose is to be followed. The others were caught by
 * running the thing. This one is caught by a test, because a release build is too expensive to
 * run in the suite and too rare to catch drift on its own.
 *
 * WHAT IT DOES NOT CHECK, deliberately: whether the commands produce a correct release. That
 * needs a real build. It checks the cheaper property whose absence is fatal — that every flag
 * named exists — which is exactly what failed here.
 *
 * The removal of `--deploy-all-files` was safe only because its BEHAVIOUR became the default,
 * and that was measured rather than assumed: on pnpm 11.21.0 a plain `--legacy` deploy of
 * `@kf/web` yields `.next/` with `BUILD_ID`, `server/` and 365 files, and adding
 * `--config.deploy-all-files=true` produces a byte-identical tree. If a future pnpm reverts
 * that, releases ship without runtime and nothing in the tarball looks wrong — so the hazard
 * the old flag guarded is real even though the flag is gone.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const DOCUMENT = join(ROOT, 'docs', 'deployment', 'private-host.md');

/** Long flags used by the `pnpm ... deploy ...` lines the contract tells an operator to run. */
function documentedDeployFlags(): readonly string[] {
  const body = readFileSync(DOCUMENT, 'utf8');
  const flags = new Set<string>();
  let commands = 0;
  for (const line of body.split('\n')) {
    // Only the command lines. Prose mentioning a flag in backticks is discussion, including
    // this document's own account of the flag that was removed.
    if (!/^pnpm .*\bdeploy\b/.test(line)) continue;
    commands += 1;
    for (const match of line.matchAll(/(?:^|\s)(--[a-z][a-z0-9-]*)/g)) flags.add(match[1]!);
  }
  expect(
    commands,
    'no `pnpm ... deploy ...` command lines parsed out of private-host.md, so this test is ' +
      'checking nothing. If the release recipe moved or changed shape, move this with it.',
  ).toBeGreaterThanOrEqual(6);
  return [...flags].sort();
}

describe('the documented release commands can actually run', () => {
  it('names only pnpm deploy options that the pinned pnpm accepts', () => {
    const help = execFileSync('pnpm', ['deploy', '--help'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const supported = new Set(
      [...help.matchAll(/(?:^|\s)(--[a-z][a-z0-9-]*)/g)].map((match) => match[1]!),
    );
    expect(
      supported.size,
      'parsed no options out of `pnpm deploy --help`, so the comparison below would pass ' +
        'against an empty set and prove nothing',
    ).toBeGreaterThan(3);

    // `--filter` is a global pnpm option and does not appear in the deploy help text.
    const global = new Set(['--filter', '--filter-prod']);
    const unknown = documentedDeployFlags().filter(
      (flag) => !supported.has(flag) && !global.has(flag),
    );

    expect(
      unknown,
      'private-host.md tells an operator to run pnpm deploy with these options and the pinned ' +
        'pnpm does not have them, so the release build stops on its first such command. Check ' +
        'whether the option was renamed or its behaviour became the default, and record which ' +
        'in the document — removing a flag whose behaviour is gone ships a release with no ' +
        'runtime in it.',
    ).toEqual([]);
  });
});
