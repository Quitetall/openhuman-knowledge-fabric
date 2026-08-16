/**
 * Which declared invariant does a refusal code implement?
 *
 * `ontology/rules.yaml` declares fifteen invariants and gives each an `implementation:` list.
 * The code refuses with a much larger vocabulary — `KF-DOC-AUTH-003`, `KF-DOC-PUBLISH-002`,
 * `KF-VER-002` — and nothing connects the two. That gap is not cosmetic: it made the question
 * "is this declared invariant actually enforced?" unanswerable mechanically.
 *
 * It was answered wrongly once, here, which is why this file exists. A sweep matching rule ids
 * against source produced a table showing seven of fifteen invariants with no implementation.
 * Most of that was an artefact: `KF-DOC-003` says authority is required for Holder transfer,
 * compilation acceptance and publication, and it is enforced — by `KF-DOC-AUTH-001..004`,
 * which share none of its characters. Reporting that table would have been a confident wrong
 * answer about the thing this system exists to be right about.
 *
 * So the link is declared, once, here, and asserted EXHAUSTIVE in both directions: a new code
 * has to be classified before the suite passes, and a family pointing at an invariant the
 * ontology does not declare fails. The map is a claim about the code that the code is checked
 * against, rather than documentation that drifts.
 *
 * The limit is worth stating up front, because it was measured rather than assumed. These
 * assertions read SOURCE, so they catch a rule with no implementation at all and are blind to
 * an implementation nothing dispatches to — unregistering a precondition while leaving the
 * function in place keeps them green. Reachability is not decidable from a grep. The one
 * orphan that mattered is pinned by name in the last test instead.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORK_CONTROL_PRECONDITIONS } from '@kf/work-control';

const ROOT = join(import.meta.dirname, '..', '..');

/**
 * Refusal-code family to the declared invariant it enforces.
 *
 * Longest prefix wins, so `KF-DOC-BASIS` is read before `KF-DOC`. The sub-namespacing was
 * evidently deliberate — every family lines up with exactly one rule's description — and this
 * table is that intent written down where it can be checked.
 */
const FAMILY_IMPLEMENTS: ReadonlyArray<readonly [string, string]> = [
  // KF-DOC-001: one current Source Holder; Holder changes use the narrow typed action.
  ['KF-DOC-HOLDER', 'KF-DOC-001'],
  ['KF-DOC-001', 'KF-DOC-001'],
  // KF-DOC-002: a run and its views consume the exact Basis one prior request authorized.
  ['KF-DOC-BASIS', 'KF-DOC-002'],
  ['KF-DOC-COMPILE', 'KF-DOC-002'],
  ['KF-DOC-COMP', 'KF-DOC-002'],
  ['KF-DOC-002', 'KF-DOC-002'],
  // KF-DOC-003: one immutable document policy; transfer, acceptance and publication need
  // scoped technical authority plus any quality authority that policy requires.
  ['KF-DOC-AUTH', 'KF-DOC-003'],
  ['KF-DOC-POLICY', 'KF-DOC-003'],
  // KF-DOC-004: a Proposal Overlay is append-only and applying one is a human-authorized act.
  ['KF-DOC-PROPOSAL', 'KF-DOC-004'],
  // KF-DOC-005: every publication has one append-only receipt binding what authorized it.
  ['KF-DOC-PUBLISH', 'KF-DOC-005'],
  // The financial ladder, each enforced under its own id.
  ['KF-FIN-001', 'KF-FIN-001'],
  ['KF-FIN-002', 'KF-FIN-002'],
  ['KF-FIN-003', 'KF-FIN-003'],
  ['KF-CHG-001', 'KF-CHG-001'],
  ['KF-DEC-001', 'KF-DEC-001'],
  ['KF-PROJ-002', 'KF-PROJ-002'],
  ['KF-WORK-001', 'KF-WORK-001'],
];

/**
 * Families that are local conditions, not implementations of a declared invariant.
 *
 * A missing target, an unparseable payload, a malformed digest: real refusals a caller must
 * act on, and none of them is one of the fifteen. Listing them explicitly is the point — an
 * unclassified code fails the suite, so "local" has to be asserted rather than assumed.
 */
const LOCAL_FAMILIES: readonly string[] = [
  'KF-DOC-CLASS', // classification arithmetic on a document target
  'KF-DOC-FRAG', // fragment shape
  'KF-DOC-TARGET', // the action named no usable document target
  'KF-FIN-TARGET', // the action named no work order
  'KF-WORK-TARGET', // the action named no work execution
  'KF-VER', // test execution and result shape
  'KF-QMS', // nonconformity and CAPA closure preconditions
  'KF-COMPILER', // the compiler process itself failed
  'KF-MISSING', // a required record was not found
];

function declaredRules(): ReadonlyMap<string, string> {
  const yaml = readFileSync(join(ROOT, 'ontology', 'rules.yaml'), 'utf8');
  const rules = new Map<string, string>(
    [
      ...yaml.matchAll(/- id:\s*(KF-[A-Z0-9-]+)[\s\S]*?implementation:\s*\[([^\]]*)\]/g),
    ].map((match) => [match[1]!, match[2]!]),
  );
  expect(rules.size, 'no invariants parsed out of ontology/rules.yaml').toBeGreaterThan(5);
  return rules;
}

/** Every KF-* refusal code that appears in shipped source, tests excluded. */
function refusalCodesInSource(): readonly string[] {
  const output = execFileSync(
    'bash',
    [
      '-c',
      // Shipped source only, which the `--exclude` flags do and `grep -v dist` did not:
      // excluding built output alone would have counted a code appearing nowhere but a test
      // as enforced, and "enforced" is precisely what the third assertion below establishes.
      `grep -rhoP "'KF-[A-Z0-9-]+'" packages apps --include='*.ts' ` +
        `--exclude='*.test.ts' --exclude-dir=dist | tr -d "'" | sort -u`,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const codes = output.split('\n').filter((line) => line.startsWith('KF-'));
  expect(codes.length, 'no refusal codes found in source').toBeGreaterThan(20);
  return codes;
}

/** Longest matching family prefix, so KF-DOC-BASIS is read before KF-DOC. */
function classify(code: string): { rule?: string; local: boolean } {
  const byLength = [...FAMILY_IMPLEMENTS].sort((a, b) => b[0].length - a[0].length);
  const implemented = byLength.find(([family]) => code.startsWith(family));
  const local = [...LOCAL_FAMILIES]
    .sort((a, b) => b.length - a.length)
    .find((family) => code.startsWith(family));
  // Longest wins overall: a local family that is more specific than an implementing one
  // (KF-FIN-TARGET against KF-FIN-001) must not be swallowed by it.
  if (implemented !== undefined && local !== undefined) {
    return local.length > implemented[0].length
      ? { local: true }
      : { rule: implemented[1], local: false };
  }
  if (implemented !== undefined) return { rule: implemented[1], local: false };
  return { local: local !== undefined };
}

describe('every refusal code is traceable to a rule, or explicitly is not one', () => {
  it('classifies every code the source can raise', () => {
    const unclassified = refusalCodesInSource().filter((code) => {
      const verdict = classify(code);
      return verdict.rule === undefined && !verdict.local;
    });
    expect(
      unclassified,
      'these refusal codes belong to no declared invariant and are not listed as local, so ' +
        'nobody can say whether the rule they were meant to enforce is enforced',
    ).toEqual([]);
  });

  it('points every mapped family at a rule the ontology actually declares', () => {
    const declared = declaredRules();
    const dangling = FAMILY_IMPLEMENTS.filter(([, rule]) => !declared.has(rule)).map(
      ([family, rule]) => `${family} -> ${rule}`,
    );
    expect(dangling, 'these families claim to implement invariants that do not exist').toEqual(
      [],
    );
  });

  it('leaves no invariant claiming to be a precondition with nothing raising it', () => {
    // A rule whose `implementation:` list includes `action_precondition` promises a caller
    // sees a coded refusal. If nothing raises anything in its family, that promise is prose —
    // which spec §27.1 calls nonconforming, and which decision 0001 already flags as the
    // first of its known gaps.
    //
    // WHAT THIS DOES AND DOES NOT CATCH, because the difference was measured rather than
    // assumed. It greps for the code in shipped source, so it fires when a rule has NO
    // implementation at all — delete `assertAllocationsFit` and KF-FIN-003 has nowhere left
    // to appear. It does NOT fire when an implementation exists but nothing dispatches to it:
    // unregistering that same function while leaving it in the file kept this green, because
    // the string is still there. Reachability is not decidable from a grep, so the orphan
    // case is pinned directly by the assertion below rather than claimed here.
    const declared = declaredRules();
    const codes = refusalCodesInSource();
    const enforced = new Set(
      codes.map((code) => classify(code).rule).filter((rule): rule is string => rule !== undefined),
    );

    const promisedButSilent = [...declared.entries()]
      .filter(([, implementation]) => implementation.includes('action_precondition'))
      .map(([rule]) => rule)
      .filter((rule) => !enforced.has(rule));

    expect(
      promisedButSilent,
      'these invariants declare an action_precondition and nothing in the source raises a ' +
        'refusal for them, so a caller who violates one gets a database error or nothing',
    ).toEqual([]);
  });

  it('dispatches the payment-allocation precondition from the action that carries allocations', () => {
    // The orphan case the grep above cannot see, pinned where it matters — and it matters
    // because this wiring was wrong on the first attempt. Allocations travel in
    // `authorize_payment`'s payload; `assertAllocationsFit` was registered against
    // `record_payment_settlement`, whose payload has no `allocations` key. It would have
    // returned at its first line on every call and enforced nothing, while the registration
    // and the KF-FIN-003 refusals inside it made the rule look implemented from every angle
    // an automated check can see.
    expect(Object.keys(WORK_CONTROL_PRECONDITIONS)).toContain('authorize_payment');
    expect(
      Object.keys(WORK_CONTROL_PRECONDITIONS),
      'a precondition registered against an action whose payload it cannot read is worse ' +
        'than none: it reports coverage and provides none',
    ).not.toContain('record_payment_settlement');
  });
});
