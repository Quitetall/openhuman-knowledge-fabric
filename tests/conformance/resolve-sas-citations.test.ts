/**
 * KF-SAS-RQ-184 / SAS §100.12: `scripts/resolve-sas-citations.mjs` resolves `KF-SAS-RQ-nnn`
 * citations in any file or directory — another repository included — against the normative
 * projection, and fails on one that names nothing.
 *
 * Fixtures first, because the three outcomes (resolved, retired, unresolved) and the four exit
 * statuses are the tool's contract and each needs a case that can only pass one way. Then this
 * repository's own documentation, which is the largest body of citations there is: every one of
 * them must resolve, so the tool is also a gate on this tree.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'resolve-sas-citations.mjs');

interface Report {
  schema: string;
  projection: { revision: string; sha256: string };
  citations: number;
  resolved: number;
  retired: number;
  unresolved: number;
  problems: Array<{ file: string; id: string; line: number; status: string }>;
  exit_code: number;
}

function resolveCitations(args: string[], cwd = ROOT) {
  const run = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

let fixture: string;
let projection: string;
let revisions: string;

beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), 'kf-citations-'));
  projection = join(fixture, 'NORMATIVE.json');
  revisions = join(fixture, 'revisions');
  mkdirSync(revisions);
  writeFileSync(
    projection,
    JSON.stringify({
      schema: 'oh.war/sas-normative/v1',
      revision: '9.9.9-fixture',
      sha256: 'f'.repeat(64),
      source: 'fixture.md',
      sentences: [
        { sentence: 'KF-SAS-RQ-001. The Fabric SHALL be one graph.' },
        { sentence: 'KF-SAS-RQ-002. Visibility SHALL be enforced in the database.' },
        { sentence: 'SHALL states a requirement.' },
      ],
    }),
  );
  writeFileSync(
    join(revisions, '9.9.8.toml'),
    '[requirements]\nKF-SAS-RQ-001 = "one graph"\nKF-SAS-RQ-050 = "gone since"\n',
  );

  const repo = join(fixture, 'other-repo');
  mkdirSync(join(repo, 'warrants'), { recursive: true });
  mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
  mkdirSync(join(repo, 'clean'), { recursive: true });
  mkdirSync(join(repo, 'empty'), { recursive: true });
  writeFileSync(
    join(repo, 'warrants', 'WAR.md'),
    'Implements sas://KF-SAS-RQ-001 and KF-SAS-RQ-002.\nAlso KF-SAS-RQ-050.\n',
  );
  writeFileSync(join(repo, 'warrants', 'notes.txt'), 'line one\nsee KF-SAS-RQ-999 here\n');
  writeFileSync(join(repo, 'node_modules', 'dep', 'README.md'), 'KF-SAS-RQ-998\n');
  writeFileSync(
    join(repo, 'clean', 'ok.md'),
    'Cites KF-SAS-RQ-002 only; OW-SAS-RQ-001 is not ours.\n',
  );
  writeFileSync(join(repo, 'empty', 'none.md'), 'no citations\n');
});

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

const fixtureArgs = () => ['--projection', projection, '--revisions', revisions];

describe('resolve-sas-citations.mjs (KF-SAS-RQ-184)', () => {
  it('reports each unresolved and retired citation by file and line, and exits 1', () => {
    const run = resolveCitations([...fixtureArgs(), '--json', join(fixture, 'other-repo')]);
    expect(run.status).toBe(1);
    const report = JSON.parse(run.stdout) as Report;
    expect(report.projection.revision).toBe('9.9.9-fixture');
    expect({ ...report, problems: undefined, projection: undefined }).toMatchObject({
      citations: 5,
      resolved: 3,
      retired: 1,
      unresolved: 1,
    });
    expect(
      report.problems.map((problem) => [problem.id, problem.status, problem.line]).sort(),
    ).toEqual([
      ['KF-SAS-RQ-050', 'retired', 2],
      ['KF-SAS-RQ-999', 'unresolved', 2],
    ]);
    // node_modules is not the citing repository's own text.
    expect(run.stdout).not.toContain('KF-SAS-RQ-998');
  });

  it('prints path:line: id status for people', () => {
    const run = resolveCitations([...fixtureArgs(), join(fixture, 'other-repo', 'warrants')]);
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/notes\.txt:2: KF-SAS-RQ-999 unresolved/);
    expect(run.stdout).toMatch(/WAR\.md:2: KF-SAS-RQ-050 retired/);
    expect(run.stdout).toMatch(/revision 9\.9\.9-fixture .*1 unresolved/);
  });

  it('exits 0 when every citation resolves, and ignores other namespaces', () => {
    const run = resolveCitations([...fixtureArgs(), join(fixture, 'other-repo', 'clean')]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('1 citation(s)');
  });

  it('a retired citation alone is reported but not fatal', () => {
    const only = join(fixture, 'retired-only.md');
    writeFileSync(only, 'KF-SAS-RQ-050\n');
    const run = resolveCitations([...fixtureArgs(), only]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('KF-SAS-RQ-050 retired');
  });

  it('refuses to report success when it found nothing to check, unless told that is expected', () => {
    const empty = join(fixture, 'other-repo', 'empty');
    expect(resolveCitations([...fixtureArgs(), empty]).status).toBe(3);
    expect(resolveCitations([...fixtureArgs(), '--allow-none', empty]).status).toBe(0);
  });

  it('exits 2 on a missing path, an unreadable projection, or a projection that states nothing', () => {
    expect(resolveCitations([...fixtureArgs(), join(fixture, 'no-such-dir')]).status).toBe(2);
    expect(resolveCitations([]).status).toBe(2);
    const blank = join(fixture, 'blank.json');
    writeFileSync(blank, JSON.stringify({ schema: 'oh.war/sas-normative/v1', sentences: [] }));
    expect(resolveCitations(['--projection', blank, fixture]).status).toBe(2);
    expect(resolveCitations(['--projection', join(fixture, 'nope.json'), fixture]).status).toBe(2);
  });

  it("resolves every citation in this repository's own docs against the committed projection", () => {
    const run = resolveCitations(['--json', 'docs/decisions', 'docs/warrants', 'CONTRIBUTING.md']);
    const report = JSON.parse(run.stdout) as Report;
    expect(report.citations, 'no citations reached the resolver').toBeGreaterThan(100);
    expect(report.problems).toEqual([]);
    expect(run.status).toBe(0);
  });
});
