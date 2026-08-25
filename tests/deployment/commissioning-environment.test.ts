/**
 * The deployment contract names every variable commissioning reads.
 *
 * This test exists because of a defect that would have surfaced on the day a host was first
 * built, with somebody standing at a terminal. `kf-commissioning` reads seventeen environment
 * variables. `docs/deployment/private-host.md` — the document an operator follows — named
 * twelve of them, and two of the five it omitted were REQUIRED:
 *
 *   KF_REVERSE_PROXY_CONFIG   reverse_proxy_posture reads it
 *   KF_RELEASE_DIR            liminal_runtime_inventory reads it
 *
 * An unsupplied input makes its check `unverifiable`, and `unverifiable` fails exactly as
 * `unsatisfied` does. So following the document exactly produced 6/8 and two failures naming
 * variables the document had never mentioned. Nothing was wrong with the code or the checks;
 * the contract was incomplete, which is the failure mode ADR 0004 already records twice over
 * for pandoc and python3 — an environment assumed rather than described.
 *
 * The other three have defaults, and two of them decide verdicts: a certificate 25 days from
 * expiry satisfies `tls_termination` at the default 21 and fails at 30. A tunable that changes
 * a verdict and appears in no document is a silent policy.
 *
 * So: the table in `@kf/operations` is the source, `--help` renders it, and this holds the
 * document to it. It deliberately checks only that each name is PRESENT. Whether the
 * surrounding prose is right is a judgement no test should pretend to make — but a name that
 * appears nowhere cannot be right.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMMISSIONING_DEFAULTS,
  COMMISSIONING_ENVIRONMENT,
  commissioningUsage,
} from '@kf/operations';

const ROOT = join(import.meta.dirname, '..', '..');
const DOCUMENT = join(ROOT, 'docs', 'deployment', 'private-host.md');

describe('private-host.md names every variable kf-commissioning reads', () => {
  it('omits none of them', () => {
    const body = readFileSync(DOCUMENT, 'utf8');
    const missing = COMMISSIONING_ENVIRONMENT.filter((v) => !body.includes(v.env)).map(
      (v) => `${v.env} (${v.kind})`,
    );
    expect(
      missing,
      'kf-commissioning reads these and the deployment contract never mentions them. An ' +
        'operator following that document cannot supply what it does not name, and a required ' +
        'one going unsupplied makes its check unverifiable — which fails.',
    ).toEqual([]);
  });

  it('has something to check, so a passing run means something', () => {
    // Guarding the guard. If the table were emptied or the import silently resolved to an empty
    // array, the assertion above would pass by describing nothing at all.
    expect(COMMISSIONING_ENVIRONMENT.length).toBeGreaterThan(10);
    expect(COMMISSIONING_ENVIRONMENT.filter((v) => v.kind === 'required').length).toBeGreaterThan(
      5,
    );
  });

  it('declares each variable once, and points each key at one variable', () => {
    const names = COMMISSIONING_ENVIRONMENT.map((v) => v.env);
    expect(new Set(names).size, 'a variable is declared twice').toBe(names.length);

    const keys = COMMISSIONING_ENVIRONMENT.flatMap((v) => (v.key === undefined ? [] : [v.key]));
    expect(
      new Set(keys).size,
      'two variables supply the same CommissioningInputs field, so whichever is read last wins ' +
        'and the other is silently ignored',
    ).toBe(keys.length);
  });

  it('states defaults the code would actually use', () => {
    // The first version of the table wrote its defaults out by hand and one was already wrong:
    // it said KF_SHIPPED_UNIT_DIR defaults to `/opt/kf/deploy/systemd` when the default is
    // `deploy/systemd`. The wrong value was not nonsense — it is where the deployment installs
    // the units, which is what an operator should SET. A true fact in the field for a different
    // fact reads as correct to anyone checking casually, which is what makes it worth a test.
    //
    // Every tunable that a check reads must therefore point at COMMISSIONING_DEFAULTS rather
    // than restate it. KF_ALERT_DISPATCH is the one exception and is asserted below: no check
    // reads it, so there is no defaults entry to point at.
    for (const variable of COMMISSIONING_ENVIRONMENT) {
      if (variable.kind !== 'tunable') continue;
      if (variable.env === 'KF_ALERT_DISPATCH') {
        expect(variable.defaultsTo, 'the alert script must still declare a default').toBeTruthy();
        continue;
      }
      expect(
        variable.defaultKey,
        `${variable.env} restates its default instead of pointing at COMMISSIONING_DEFAULTS, ` +
          'so --help can state a value the code does not use',
      ).toBeDefined();
      expect(
        COMMISSIONING_DEFAULTS[variable.defaultKey!],
        `${variable.env} points at a COMMISSIONING_DEFAULTS entry that does not exist`,
      ).toBeDefined();
    }
  });

  it('renders usage that names every variable and both kinds', () => {
    const text = commissioningUsage();
    for (const variable of COMMISSIONING_ENVIRONMENT) {
      expect(text, `--help does not mention ${variable.env}`).toContain(variable.env);
    }
    // The two headings the operator scans for. A usage block that lists everything under one
    // heading does not tell them what they MUST set.
    expect(text).toContain('Required');
    expect(text).toContain('Optional');
  });
});
