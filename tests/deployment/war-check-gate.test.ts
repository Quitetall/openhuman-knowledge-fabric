/**
 * `scripts/war-check-gate.mjs` turns `war check --generated --json` into the CI verdict of the
 * `sas` job (KF-SAS-RQ-017, RQ-181). It tolerates an ERROR only through a dated, exact
 * owner-pending entry, so every way it could wave something through is planted here and must
 * fail. The fixtures are shaped like a real report from war at the pinned commit.
 *
 * What this cannot check: that war itself detects drift. That was proved against the pinned build
 * by hand-editing NORMATIVE.md and the SAS (see the commit that added this file), and the CI job
 * runs the real binary on every change.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'war-check-gate.mjs');
const REVISION = 'docs/sas/revisions/0.1.0-draft.7.toml';

interface Diagnostic {
  severity: string;
  rule: string;
  file: string | null;
  message: string;
}

const base = (): Diagnostic[] => [
  { severity: 'pass', rule: 'sas-normative.complete', file: null, message: 'every section' },
  {
    severity: 'pass',
    rule: 'sas-normative.drift',
    file: null,
    message: 'NORMATIVE.md matches a fresh compilation',
  },
  {
    severity: 'pass',
    rule: 'sas-normative.drift',
    file: null,
    message: 'NORMATIVE.json matches a fresh compilation',
  },
  {
    severity: 'warn',
    rule: 'sas.proposed-unaccepted',
    file: 'docs/sas/KF_Software_Architecture_Specification.md',
    message: 'proposed',
  },
  { severity: 'error', rule: 'authority.unsigned', file: REVISION, message: 'no signed response' },
];

const entry = (overrides: Record<string, string> = {}) => ({
  subject: 'SAS-0.1.0-draft.7',
  rule: 'authority.unsigned',
  file: REVISION,
  recorded: '2026-09-24',
  review_by: '2026-10-31',
  pending_on: 'the owner',
  reason: 'accepted without a signed response; signing is the owner act',
  ...overrides,
});

const scratch = mkdtempSync(join(tmpdir(), 'kf-war-gate-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;

function gate(
  diagnostics: Diagnostic[],
  entries: object[],
  warExit: number,
  today = '2026-09-24',
  schema = 'kf/sas-owner-pending/v1',
) {
  const id = counter++;
  const report = join(scratch, `report-${id}.json`);
  const register = join(scratch, `register-${id}.json`);
  writeFileSync(
    report,
    JSON.stringify({ schema: 'oh.war/report/v1', command: 'check', diagnostics }),
  );
  writeFileSync(register, JSON.stringify({ schema, entries }));
  const run = spawnSync(
    process.execPath,
    [SCRIPT, report, '--war-exit', String(warExit), '--register', register, '--today', today],
    { encoding: 'utf8' },
  );
  return { status: run.status, out: run.stdout + run.stderr };
}

describe('war-check-gate.mjs (KF-SAS-RQ-017, RQ-181)', () => {
  it('passes today’s shape: drift compared, one error excused by an exact, current entry', () => {
    const run = gate(base(), [entry()], 2);
    expect(run.out).toContain('PASS');
    expect(run.status).toBe(0);
  });

  it('fails an error nobody listed', () => {
    const run = gate(base(), [], 2);
    expect(run.status).toBe(1);
    expect(run.out).toContain('not owner-pending');
  });

  it('an entry excuses one rule in one file, never the same rule elsewhere', () => {
    const other = [...base(), { ...base()[4]!, file: 'docs/sas/revisions/0.1.0-draft.9.toml' }];
    const run = gate(other, [entry()], 2);
    expect(run.status).toBe(1);
    expect(run.out).toContain('0.1.0-draft.9');
  });

  it('fails once review_by has passed', () => {
    const run = gate(base(), [entry()], 2, '2026-11-01');
    expect(run.status).toBe(1);
    expect(run.out).toContain('review_by 2026-10-31 has passed');
  });

  it('never excuses drift, even when an entry names it', () => {
    const drifted = base().map((diagnostic) =>
      diagnostic.message.startsWith('NORMATIVE.md')
        ? { ...diagnostic, severity: 'error', file: 'docs/sas/generated/NORMATIVE.md' }
        : diagnostic,
    );
    const run = gate(
      drifted,
      [entry(), entry({ rule: 'sas-normative.drift', file: 'docs/sas/generated/NORMATIVE.md' })],
      2,
    );
    expect(run.status).toBe(1);
    expect(run.out).toContain('no passing sas-normative.drift for NORMATIVE.md');
    expect(run.out).toContain('can never be owner-pending');
  });

  it('fails a report that compared nothing', () => {
    const run = gate(base().slice(3), [entry()], 2);
    expect(run.status).toBe(1);
    expect(run.out).toContain('sas-normative.complete');
  });

  it('fails a stale entry that matches no finding', () => {
    const run = gate(
      base(),
      [entry(), entry({ subject: 'SAS-x', file: 'docs/sas/revisions/x.toml' })],
      2,
    );
    expect(run.status).toBe(1);
    expect(run.out).toContain('matches no finding');
  });

  it('fails an unknown severity, and a status that disagrees with the report', () => {
    const unknown = gate(
      [...base(), { severity: 'unknown', rule: 'x.y', file: null, message: '' }],
      [entry()],
      2,
    );
    expect(unknown.status).toBe(1);
    expect(gate(base(), [entry()], 0).status).toBe(1);
    const clean = base().slice(0, 4);
    expect(gate(clean, [], 2).out).toContain('the report and the status disagree');
  });

  it('refuses input that is not a war check report, and a register of the wrong schema', () => {
    expect(gate(base(), [entry()], 2, '2026-09-24', 'something/else').status).toBe(1);
    const bad = join(scratch, 'bad.json');
    writeFileSync(bad, '{"schema":"oh.war/report/v1","command":"compile"}');
    const run = spawnSync(process.execPath, [SCRIPT, bad, '--war-exit', '0'], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status).toBe(2);
  });

  it('the committed register is the one the job reads, and it is exact (non-vacuous)', () => {
    const register = JSON.parse(
      readFileSync(join(ROOT, 'docs', 'sas', 'owner-pending.json'), 'utf8'),
    ) as { entries: Array<{ rule: string; file: string }> };
    expect(register.entries.some((candidate) => candidate.file === REVISION)).toBe(true);
    for (const candidate of register.entries) expect(candidate.file).not.toMatch(/[*?]/);
  });
});
