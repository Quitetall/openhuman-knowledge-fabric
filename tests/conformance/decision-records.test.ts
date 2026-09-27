/**
 * KF-SAS-RQ-182: architectural decisions SHALL be recorded with their measurement and rejected
 * options, and a superseded record SHALL be retained in full.
 *
 * From ADR 0034 the house shape names both: `## Options rejected` and `## How we will know`
 * (0034-0037 all carry them; 0028 has the first as "Options rejected, with what killed each").
 * Nothing held it, so the next record could drop either and read as complete. Records before
 * 0034 are grandfathered: they state the same content under other headings, or do not, and a
 * decision record is not rewritten to satisfy a rule made after it (CONTRIBUTING.md).
 *
 * What this cannot check: that the rejected options were real, or that "How we will know" names
 * something measurable. A heading with a body is the automatable half; reading it is review.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const DECISIONS = join(ROOT, 'docs', 'decisions');
const SAS = join(ROOT, 'docs', 'sas', 'KF_Software_Architecture_Specification.md');

/** The first record the named sections bind. Lowering it rewrites history; raising it hides one. */
const FIRST_BOUND = 34;

/** Heading prefixes that must each open a section with a non-empty body. */
const REQUIRED = ['Options rejected', 'How we will know'] as const;

/** Which required sections a record lacks, or has with nothing under them. */
function missingSections(markdown: string): string[] {
  const lines = markdown.split('\n');
  return REQUIRED.filter((prefix) => {
    const start = lines.findIndex((line) => line.startsWith(`## ${prefix}`));
    if (start < 0) return true;
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^#{1,2} /.test(line));
    const body = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
    return body === '';
  });
}

const records = readdirSync(DECISIONS)
  .map((name) => ({ name, number: /^(\d{4})-.+\.md$/.exec(name)?.[1] }))
  .filter((entry): entry is { name: string; number: string } => entry.number !== undefined)
  .sort((left, right) => left.name.localeCompare(right.name));

describe('decision records state their rejected options and their measurement (KF-SAS-RQ-182)', () => {
  const bound = records.filter((record) => Number(record.number) >= FIRST_BOUND);

  it('reads the records, and at least the four that set the shape are bound (non-vacuous)', () => {
    expect(records.length).toBeGreaterThanOrEqual(37);
    expect(bound.map((record) => record.number)).toEqual(
      expect.arrayContaining(['0034', '0035', '0036', '0037']),
    );
  });

  it('allocates each number once', () => {
    const numbers = records.map((record) => record.number);
    expect(numbers.filter((number, index) => numbers.indexOf(number) !== index)).toEqual([]);
  });

  it.each(bound.map((record) => [record.name] as const))(
    '%s has "Options rejected" and "How we will know", each with a body',
    (name) => {
      expect(missingSections(readFileSync(join(DECISIONS, name), 'utf8'))).toEqual([]);
    },
  );

  it('catches a missing section and an empty one (planted)', () => {
    expect(missingSections('# ADR\n## Decision\nx\n## How we will know\nmeasure y\n')).toEqual([
      'Options rejected',
    ]);
    expect(
      missingSections(
        '# ADR\n## Options rejected, with what killed each\n\n## How we will know\nz\n',
      ),
    ).toEqual(['Options rejected']);
    expect(
      missingSections('## Options rejected\na\n### Option A\nb\n## How we will know\nc\n'),
    ).toEqual([]);
  });
});

describe('a superseded or amended record is retained in full (KF-SAS-RQ-182)', () => {
  it('every record the SAS §96 supersession table names still exists', () => {
    const sas = readFileSync(SAS, 'utf8');
    const start = sas.indexOf('## 96. Decision records');
    const end = sas.indexOf('**KF-SAS-RQ-182.**', start);
    expect(start, 'SAS §96 not found; this check would compare nothing').toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const table = sas
      .slice(start, end)
      .split('\n')
      .filter((line) => line.startsWith('|'))
      .join('\n');
    const cited = [...new Set([...table.matchAll(/\b(00\d\d)\b/g)].map((match) => match[1]!))];
    expect(cited, 'the supersession table names no records').toEqual(
      expect.arrayContaining(['0008', '0009', '0011', '0022']),
    );
    const present = new Set(records.map((record) => record.number));
    expect(cited.filter((number) => !present.has(number))).toEqual([]);
  });
});
