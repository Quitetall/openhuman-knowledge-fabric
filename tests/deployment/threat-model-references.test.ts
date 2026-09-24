/**
 * The threat model's open items still describe what is actually true.
 *
 * The path-resolution half of this file moved to `docs-references.test.ts`, which checks every
 * repo-relative citation across the whole documentation tree rather than this one document —
 * the same guard, generalised, and one fewer near-duplicate to keep in step.
 *
 * What is left is the part that is specific to this document and cannot be generalised: its
 * open-items table is the only place in the repository that says which risks are accepted and
 * which are merely unbuilt, and the difference between those two is not visible in code.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const THREAT_MODEL = join(ROOT, 'docs', 'threat-model', 'README.md');

describe('the threat model records what is accepted and what is merely unbuilt', () => {
  it('describes open item 5 as the half that code cannot close', () => {
    // This assertion previously required that NO alert unit shipped, because the threat model
    // called item 5 "a genuine gap" and an undelivered `OnFailure=` was the gap. The unit now
    // ships — and the test failing on the commit that added it is exactly what forced the
    // document to be rewritten in the same commit rather than a later one.
    //
    // What it holds now is the residue: the unit exists and is tested, so the document must no
    // longer call it missing, and must still say that nobody has received one. A delivery path
    // that passes every check and reaches an abandoned channel is the failure this cannot
    // detect, and the document is the only place that can say so.
    const body = readFileSync(THREAT_MODEL, 'utf8');
    expect(
      existsSync(join(ROOT, 'deploy', 'systemd', 'kf-alert@.service')),
      'the alert unit is gone; the threat model still describes it as shipped',
    ).toBe(true);
    expect(
      existsSync(join(ROOT, 'deploy', 'systemd', 'kf-alert-heartbeat.timer')),
      'the heartbeat timer is gone, so a dead alert path is undetectable again',
    ).toBe(true);
    expect(
      body,
      'the threat model must still record that no person has received an alert; that is host ' +
        'evidence and shipping the unit did not supply it',
    ).toContain('nobody has yet received one');
    expect(
      body,
      'the threat model no longer states that the alert carries no log content, which is the ' +
        'data-boundary rule the payload assertion enforces',
    ).toContain('carries no log content');
  });
});

/**
 * KF-SAS-RQ-170: every documented control SHALL cite the artifact that proves it.
 *
 * `docs-references.test.ts` resolves every path a document cites, which says nothing about a
 * control that cites no path at all. The T8 row "the shell scripts resolve credentials the same
 * way" read `—` in its "Proven by" cell while `tests/backup-restore/script-credentials.test.ts`
 * had proved it all along: a control that looked unproven, and a gate that could not tell.
 */
interface ProofCell {
  table: string;
  control: string;
  cell: string;
}

/** Every "Proven by" cell in every table of a Markdown document, with its row's control. */
function provenByCells(markdown: string): ProofCell[] {
  const cells: ProofCell[] = [];
  let heading = '(no heading)';
  let column = -1;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('#')) heading = line.replace(/^#+\s*/, '');
    if (!line.startsWith('|')) {
      column = -1;
      continue;
    }
    const row = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const header = row.findIndex((cell) => /^proven by$/i.test(cell));
    if (header >= 0) {
      column = header;
      continue;
    }
    if (column < 0 || row.every((cell) => /^:?-+:?$/.test(cell))) continue;
    cells.push({ table: heading, control: row[0] ?? '', cell: row[column] ?? '' });
  }
  return cells;
}

/** What is wrong with each cell, given a path-existence predicate; empty when all cite proof. */
function unprovenControls(cells: ProofCell[], exists: (path: string) => boolean): string[] {
  const problems: string[] = [];
  let previous: { table: string; proven: boolean } | undefined;
  for (const { table, control, cell } of cells) {
    const where = `${table} / "${control.slice(0, 60)}"`;
    if (cell === 'same') {
      if (previous?.table !== table || !previous.proven) {
        problems.push(`${where}: "same" with no proven row above it in this table`);
      }
      continue;
    }
    const paths = [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
    if (paths.length === 0) problems.push(`${where}: cites no path ("${cell}")`);
    for (const path of paths) {
      if (!exists(path)) problems.push(`${where}: \`${path}\` does not exist`);
    }
    previous = { table, proven: paths.length > 0 && paths.every(exists) };
  }
  return problems;
}

describe('every control in the threat model cites a proof that exists (KF-SAS-RQ-170)', () => {
  const cells = provenByCells(readFileSync(THREAT_MODEL, 'utf8'));
  const exists = (path: string) => existsSync(join(ROOT, path));

  it('reads the tables (non-vacuous)', () => {
    expect(cells.length).toBeGreaterThan(50);
  });

  it('has no row whose "Proven by" is empty, a dash, or a path that is gone', () => {
    expect(unprovenControls(cells, exists)).toEqual([]);
  });

  it('catches the three ways a row goes unproven (planted)', () => {
    const planted = [
      '## T0',
      '| Control | Where | Proven by |',
      '| --- | --- | --- |',
      '| a | `x` | — |',
      '| b | `x` | same |',
      '| c | `x` | `tests/no-such-file.test.ts` |',
      '| d | `x` | `tests/deployment/threat-model-references.test.ts` |',
      '| e | `x` | same |',
    ].join('\n');
    const problems = unprovenControls(provenByCells(planted), exists);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('cites no path');
    expect(problems[1]).toContain('"same" with no proven row above it');
    expect(problems[2]).toContain('does not exist');
  });
});
