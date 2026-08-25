/**
 * Every remaining blocker names its check, or says it has none.
 *
 * `docs/deployment/private-host.md` lists what still stands between this repository and a
 * commissioned host. Its blocker list and `COMMISSIONING_CHECKS` are two hand-maintained
 * descriptions of the same set, and they had already drifted: the registry still described
 * "scheduled operation units still share `kf` identity" after that was fixed, and the document
 * claimed "each now with a check that reports on it" when four blockers had no check at all.
 *
 * A blanket claim over an unevenly covered list is the dangerous shape. It reads as coverage,
 * it is cheap to write, and nothing contradicts it — an operator planning a commissioning run
 * would reasonably conclude the verifier reports on `kf-alert@` delivery, which it cannot.
 *
 * So the document now marks each blocker with the check id that reports on it, or with the
 * literal `**no check**`, and this test holds the two together:
 *
 *   - every check id named in the document exists in the registry;
 *   - every check in the registry is named by at least one blocker, so a check cannot be added
 *     without saying which gap it closes;
 *   - every blocker either names a check or says it has none, so silence is not an option and
 *     an unchecked blocker cannot drift into looking checked.
 *
 * What it deliberately does not do is compare the PROSE. The registry's `blocker` strings are
 * printed beside a failing check and the document's bullets are read by somebody planning the
 * work; requiring identical wording would make one of them worse. The id is the contract.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMISSIONING_CHECKS } from '@kf/operations';

const ROOT = join(import.meta.dirname, '..', '..');
const DOCUMENT = join(ROOT, 'docs', 'deployment', 'private-host.md');
const RELEASE_DECISION = join(ROOT, 'docs', 'decisions', '0004-production-release.md');

/** The `## Known blockers` section, as a list of bullets. */
function blockerBullets(): readonly string[] {
  const body = readFileSync(DOCUMENT, 'utf8');
  const start = body.indexOf('## Known blockers');
  expect(start, 'the blockers section is gone from private-host.md').toBeGreaterThan(0);
  const section = body.slice(start, body.indexOf('\nUntil those', start));
  expect(section, 'the blockers section has no terminating paragraph').not.toEqual('');

  // Bullets start at column zero with "- " and continue through indented lines, so a bullet
  // that wraps or carries a follow-up paragraph stays one bullet.
  const bullets: string[] = [];
  for (const line of section.split('\n')) {
    if (line.startsWith('- ')) bullets.push(line);
    else if (bullets.length > 0 && (line.startsWith('  ') || line.trim() === '')) {
      bullets[bullets.length - 1] += `\n${line}`;
    }
  }
  expect(
    bullets.length,
    'no blocker bullets parsed, so every assertion below is vacuous',
  ).toBeGreaterThan(4);
  return bullets;
}

const KNOWN_IDS = new Set(COMMISSIONING_CHECKS.map((check) => check.id));

describe('the blockers list and the commissioning checks describe the same set', () => {
  it('names only checks that exist', () => {
    // Backticked identifiers that look like check ids: lower_snake_case. Anything else in
    // backticks is a path, a unit name or a setting, and is not claiming coverage.
    const named = new Set<string>();
    for (const bullet of blockerBullets()) {
      for (const match of bullet.matchAll(/`([a-z][a-z0-9_]*)`/g)) {
        const candidate = match[1]!;
        if (candidate.includes('_')) named.add(candidate);
      }
    }
    const unknown = [...named].filter((id) => !KNOWN_IDS.has(id));
    expect(
      unknown,
      'the blockers list names these as checks and the registry has no such check, so an ' +
        'operator is told something reports on a gap when nothing does',
    ).toEqual([]);
    expect(named.size, 'no check ids found in the blockers list').toBeGreaterThan(3);
  });

  it('summarises exactly the checks that run, in the table that describes them', () => {
    // The blockers list below was already held to the registry by the assertions in this file.
    // The "what each check reads" table forty lines above it was held to nothing, and by
    // 2026-08-24 it listed SIX of the eight — `reverse_proxy_posture` and
    // `liminal_runtime_inventory` had been shipping, running, and correctly named in the
    // blockers list while the summary went on describing an older registry.
    //
    // That is the argument for this test in one artefact: the guarded half stayed true and the
    // unguarded half did not, in the same document, about the same eight things.
    const body = readFileSync(DOCUMENT, 'utf8');
    const heading = body.indexOf('What each check reads, and the blocker it closes:');
    expect(heading, 'the check-summary table is gone from private-host.md').toBeGreaterThan(0);

    const listed: string[] = [];
    for (const line of body.slice(heading).split('\n').slice(1)) {
      if (!line.startsWith('|')) {
        if (listed.length > 0) break;
        continue;
      }
      const first = line.split('|')[1] ?? '';
      const id = /`([a-z][a-z0-9_]*)`/.exec(first)?.[1];
      if (id !== undefined) listed.push(id);
    }

    expect(
      listed.sort(),
      'the table describing what each check reads does not name the checks that actually run',
    ).toEqual([...KNOWN_IDS].sort());
  });

  it('accounts for every check the verifier runs', () => {
    const document = blockerBullets().join('\n');
    const unmentioned = [...KNOWN_IDS].filter((id) => !document.includes(`\`${id}\``));
    expect(
      unmentioned,
      'these checks run but no blocker says what gap they close, so a failing one sends the ' +
        'operator to a document that does not mention it',
    ).toEqual([]);
  });

  it('leaves no blocker silent about whether anything checks it', () => {
    const silent = blockerBullets()
      .filter((bullet) => !/`[a-z][a-z0-9_]*_[a-z0-9_]*`/.test(bullet))
      .filter((bullet) => !bullet.includes('**no check**'))
      .map((bullet) => bullet.split('\n')[0]!.slice(0, 90));
    expect(
      silent,
      'these blockers name no check and do not say they have none. Silence reads as coverage ' +
        'to anyone planning a commissioning run — mark them `**no check**` if nothing reports ' +
        'on them.',
    ).toEqual([]);
  });

  it('still records the blockers that have no check, so the gaps stay visible', () => {
    // The uncomfortable half. If this ever reaches zero because somebody deleted the wording
    // rather than built the checks, that should be a deliberate edit to this number and not a
    // silent improvement in how the document reads.
    //
    // 4 -> 3 -> 2 on 2026-08-17. `reverse_proxy_posture` reads the installed nginx
    // configuration, so "firewall rules and installed nginx validation" lost its nginx half
    // (firewall rules remain unchecked, which is why that bullet still carries the marker).
    // `liminal_runtime_inventory` then closed the artifact and runtime-closure bullet by
    // running the release's own verifier.
    //
    // 2 -> 3 on 2026-08-24, and the count went UP without anything regressing. Three blockers
    // have no check; only two carried the literal marker, because the firewall bullet wrapped
    // its bold around "Firewall rules still have no check" while the counter matches
    // `**no check**` exactly. The number was right about the markup and wrong about the world.
    //
    // The three are not the same kind, and the difference is worth keeping straight:
    //
    //   CANNOT be closed from here   a person receiving an alert; real-provider browser
    //                                evidence. Both need a human to act and then say so.
    //   NOT YET closed               firewall rules. Automatable in principle; nobody has
    //                                written it. `reverse_proxy_posture` reads the nginx
    //                                configuration but cannot say what reaches the port.
    //
    // If this number falls, check which kind moved. A check closing the firewall gap is
    // progress; either of the other two falling means somebody deleted a sentence.
    const uncovered = blockerBullets().filter((bullet) => bullet.includes('**no check**'));
    expect(
      uncovered.length,
      'the count of blockers with no automated check changed; update this number in the same ' +
        'commit that adds or removes a check, and say which it was',
    ).toBe(3);
  });
});

/**
 * The release decision counts the same blockers, and nothing held it to them.
 *
 * `docs/decisions/0004-production-release.md` opens with a measured block, and one line of it
 * restates this list: how many blockers there are and how many have no check. On 2026-08-24 it
 * read "7, of which 4 have no automated check" — right about the 7, a week stale about the 4,
 * because `reverse_proxy_posture` and `liminal_runtime_inventory` had shipped on 2026-08-17 and
 * the ADR was not part of that commit.
 *
 * That is the third hand-maintained mirror of this one list to drift, after the document's own
 * check-summary table and the marker count above. The pattern is stable enough to act on rather
 * than to keep fixing: a number about measurable state, restated in prose, with nothing
 * comparing it to the state.
 *
 * So this reads the ADR's number and computes the same thing from the document. It deliberately
 * does NOT hardcode 7 and 3 — those live in the assertions above, which is where a deliberate
 * change belongs. This one only insists the two agree, so the ADR cannot fall behind a commit
 * that moves them.
 */
describe('the release decision counts the same blockers this document lists', () => {
  it('restates the blocker counts without drifting from them', () => {
    const decision = readFileSync(RELEASE_DECISION, 'utf8');
    const line = /known blockers\s+(\d+), of which (\d+) have no automated check/.exec(decision);
    expect(
      line,
      'the measured block in 0004-production-release.md no longer states the blocker counts in ' +
        'the form this test reads. If the line was reworded, reword this pattern with it; if it ' +
        'was deleted, delete this test in the same commit and say why.',
    ).not.toBeNull();

    const bullets = blockerBullets();
    expect(
      [Number(line![1]), Number(line![2])],
      'the release decision states blocker counts that private-host.md does not support, so the ' +
        'record defining the v1.0 gate is describing an older repository than the one it gates',
    ).toEqual([bullets.length, bullets.filter((b) => b.includes('**no check**')).length]);
  });
});
