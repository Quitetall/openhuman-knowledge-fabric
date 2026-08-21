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
    // A workflow pinned to a bare `ubuntu-latest` cannot run while Actions billing is failing,
    // which is the state that stopped this repository's CI twice. release.yml was pinned.
    for (const name of GATE_WORKFLOWS) {
      const pinned = [...workflow(name).matchAll(/runs-on: ubuntu-latest\s*$/gm)];
      expect(
        pinned,
        `${name}.yml pins runs-on to ubuntu-latest instead of vars.RUNNER_LABEL`,
      ).toEqual([]);
    }
  });
});

/**
 * UNTRUSTED CODE MUST NEVER REACH THE SELF-HOSTED RUNNER.
 *
 * The sandbox in `deploy/self-hosted-runner/` runs a `--privileged` inner docker daemon, which
 * is root-equivalent on whoever's machine hosts it. That is acceptable for code the maintainers
 * wrote and unacceptable for code a stranger opened a pull request with.
 *
 * The usual control is a runner group restricted to selected workflows. That is an organization
 * and enterprise feature, and this repository belongs to a personal account — so the event that
 * triggers the job is the only control surface available, and this test is what holds it.
 *
 * `push` to a branch requires write access. `pull_request` does not, the moment the repository
 * is public.
 */
describe('a fork pull request cannot run on the self-hosted runner', () => {
  it('every ci.yml job sends pull_request to ubuntu-latest', () => {
    const runsOn = [...workflow('ci').matchAll(/^ {4}runs-on: (.+)$/gm)].map((m) => m[1]!);
    expect(runsOn.length, 'ci.yml has no jobs').toBeGreaterThan(0);
    for (const expr of runsOn) {
      expect(expr, 'a ci.yml job does not special-case pull_request').toContain(
        "github.event_name == 'pull_request' && 'ubuntu-latest'",
      );
    }
  });

  it('release.yml is reachable only by pushing a tag', () => {
    // Tags can only be pushed by someone with write access, so release.yml may use the
    // self-hosted runner unconditionally. If it ever grows a pull_request trigger, that stops
    // being true and this fails.
    const on = workflow('release').split(/^jobs:/m)[0]!;
    expect(
      on,
      'release.yml gained a pull_request trigger while using the self-hosted runner',
    ).not.toMatch(/pull_request/);
  });
});

/**
 * The runner image must provide the PLATFORM tools, because it claims to substitute for
 * `ubuntu-latest`.
 *
 * `release.yml` died a second time on `gh: command not found`. A GitHub-hosted runner ships the
 * CLI; the sandbox image is a bare `ubuntu:24.04` and did not.
 *
 * The image is deliberately almost empty, and that is load-bearing — it is what found
 * bubblewrap, pandoc, python3, the PostgreSQL client, `/usr/bin/node` and the userns sysctl,
 * none of which a pre-loaded image would ever have surfaced. So this is NOT a licence to
 * pre-install what the workflows need. The line is:
 *
 *   things the PRODUCT needs  -> the workflow installs them, and the host contract stays tested
 *   things a RUNNER is        -> this image provides them, or it is not a runner
 *
 * Named individually rather than counted, for the same reason as the six above: a count still
 * passes when one is swapped for another.
 */
describe('the runner image provides the tools a hosted runner would', () => {
  const dockerfile = (): string =>
    readFileSync(join(ROOT, 'deploy', 'self-hosted-runner', 'Dockerfile'), 'utf8');

  /**
   * The package names actually passed to `apt-get install`, following `\` continuations and
   * stopping at the next `&&`.
   *
   * The first version of this test searched the whole file for the tool's name, and THREE of the
   * six guards could not fail. Removing `sudo`, `tar` or `curl` from the install line left the
   * test green, because each occurs elsewhere: `tar xzf runner.tar.gz`, `curl -fsSL` in the
   * keyring fetch, and `sudo` in the sudoers setup. Only `git` and `jq` worked, and only because
   * they happen to appear nowhere else — an accident, not a design.
   *
   * A comment naming a tool must never be able to satisfy a guard that the tool is installed.
   */
  const installedPackages = (text: string): Set<string> => {
    const packages = new Set<string>();
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i]!.includes('apt-get install')) continue;
      let joined = lines[i]!;
      while (/\\\s*$/.test(joined) && i + 1 < lines.length) {
        i += 1;
        joined = `${joined.replace(/\\\s*$/, ' ')}${lines[i]!}`;
      }
      const marker = 'apt-get install';
      const args = joined.slice(joined.indexOf(marker) + marker.length).split('&&')[0]!;
      for (const token of args.split(/\s+/)) {
        if (token && !token.startsWith('-')) packages.add(token);
      }
    }
    return packages;
  };

  it.each(['git', 'gh', 'curl', 'jq', 'tar', 'sudo'])('installs %s', (tool) => {
    const installed = installedPackages(dockerfile());
    expect(
      [...installed].sort(),
      `the runner image no longer installs ${tool}, which workflows assume the platform has`,
    ).toContain(tool);
  });

  it('installs the GitHub CLI that release.yml depends on', () => {
    // The tie, not just the tool: if the release path stops shelling out to `gh` this becomes
    // dead weight and should go, and if it starts shelling out to something else this is the
    // test that should have caught it.
    const usesGh = /^\s*gh /m.test(workflow('release'));
    expect(usesGh, 'release.yml no longer invokes gh — drop it from the runner image').toBe(true);
    expect(
      [...installedPackages(dockerfile())].sort(),
      'release.yml invokes gh and the runner image does not install it',
    ).toContain('gh');
  });

  it('pins the GitHub CLI repository to a keyring', () => {
    // An unsigned apt source on a build host is how its packages get replaced. docker-ce-cli is
    // installed this way already; a second repository added without one would be the weak link.
    const sources = [...dockerfile().matchAll(/^\s*&& echo "deb \[([^\]]*)\]/gm)].map((m) => m[1]!);
    expect(sources.length, 'no third-party apt source found to check').toBeGreaterThan(0);
    for (const opts of sources) {
      expect(opts, `an apt source is added without signed-by: [${opts}]`).toContain('signed-by=');
    }
  });
});

/**
 * A composite action must not depend on the caller's environment.
 *
 * `release.yml` died on its first ever run with `KF_POSTGRES_CLIENT_DIR: unbound variable`. The
 * shared action read a shell variable that `ci.yml` happened to declare in its job `env:` and
 * `release.yml` did not, so the action worked in one workflow and failed in the other — which
 * is the same defect the action was extracted to remove, one level up.
 *
 * An action that reads an ambient variable is not shared, it is coupled. Values it needs are
 * either inputs with defaults, or things it computes itself and exports.
 */
describe('the shared provisioning action is self-contained', () => {
  it('reads no variable the caller has to have set', () => {
    const action = readFileSync(join(ROOT, ACTION, 'action.yml'), 'utf8');
    const read = new Set([...action.matchAll(/\$\{([A-Z][A-Z0-9_]{2,})\}/g)].map((m) => m[1]!));
    // Declared as step-level `env:`, assigned in-script, or provided by the runner itself.
    const declared = new Set([...action.matchAll(/^\s+([A-Z][A-Z0-9_]{2,}):/gm)].map((m) => m[1]!));
    for (const provided of ['GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_OUTPUT', 'PATH', 'HOME']) {
      declared.add(provided);
    }
    const ambient = [...read].filter((v) => !declared.has(v)).sort();
    expect(
      ambient,
      `${ACTION} reads ${ambient.join(', ')} from whoever calls it. Make it an input with a ` +
        'default, or compute it in the action and export it to GITHUB_ENV.',
    ).toEqual([]);
  });
});
