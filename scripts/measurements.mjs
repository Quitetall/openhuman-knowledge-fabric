#!/usr/bin/env node
/**
 * Derive the repository's perishable counts, so no document has to state one.
 *
 * The specification used to write these numbers into prose. They rotted: it claimed 88
 * migrations against 91, 168 tables against 174, 438 policies against 463, and the same wrong
 * figures had been copied into the dogfood host document and into a Warrant's compilation basis,
 * where each rotted independently. A disclaimer saying counts are perishable did not prevent any
 * of it; it only meant nobody was surprised.
 *
 * Transclusion into the specification would have been the obvious repair and is the wrong one.
 * §94.2 digests that document's exact bytes and acceptance freezes the digest, so substituting a
 * count at build time would break an accepted revision every time a migration landed. A signed
 * artifact cannot be a generated one. So the numbers live here, the specification cites this file
 * rather than quoting it, and the specification's bytes never move for a reason that is not a
 * decision.
 *
 * SOURCE COUNTS ONLY. A runtime count — how many tables a live database forces row-level security
 * on — cannot be derived from a checkout, and §103.3 keeps that distinction. Those stay in prose
 * with their measurement date and host, because there is nothing here that could check them.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

function walk(dir, predicate, found = []) {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist')
        continue;
      walk(rel, predicate, found);
    } else if (predicate(entry.name, rel)) found.push(rel);
  }
  return found;
}

const migrations = walk('database/migrations', (name) => name.endsWith('.sql')).sort();

/**
 * Statements in the migrations' UP sections only.
 *
 * The per-file truncation is the whole method and §103.3 records why. 124 `drop table`
 * statements exist in this repository and every one is in a down-section, so a count that reads
 * whole files reports a schema that is created and then destroyed. Truncating the concatenation
 * instead of each file is worse and quieter: the first down-marker ends the stream and every
 * count after it reads zero, which looks like a finding rather than a mistake.
 */
const upSections = migrations.map((file) => {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const down = source.indexOf('-- migrate:down');
  return down === -1 ? source : source.slice(0, down);
});

const countStatements = (pattern) =>
  upSections.reduce((total, section) => total + (section.match(pattern)?.length ?? 0), 0);

const decisions = walk('docs/decisions', (name) => /^\d{4}-.*\.md$/.test(name)).sort();
const decisionStatus = decisions.map((file) => {
  const source = readFileSync(join(ROOT, file), 'utf8');
  return /^[-*]\s+\*\*Status:\*\*\s*proposed/im.test(source) ? 'proposed' : 'accepted';
});

/**
 * Entries in one ontology document.
 *
 * Counted as top-level list items rather than by looking for `id:`, because the documents do not
 * agree on style: `action-types.yaml` writes `- id: create_initiative` and `relation-types.yaml`
 * writes `- { id: contains, ... }`. A pattern keyed on `id:` matched the first and silently
 * returned zero for the second — a wrong answer that reads like an empty file.
 */
const ontology = (file) => {
  const source = readFileSync(join(ROOT, `ontology/${file}`), 'utf8');
  return (source.match(/^ {2}- /gm) ?? []).length;
};

const sas = readFileSync(join(ROOT, 'docs/sas/KF_Software_Architecture_Specification.md'), 'utf8');

const measures = [
  ['migrations', migrations.length, 'files under `database/migrations/`'],
  ['tables created', countStatements(/create table/gi), 'in migration up-sections'],
  ['row-security policies', countStatements(/create policy/gi), 'in migration up-sections'],
  ['definer functions', countStatements(/security definer/gi), 'in migration up-sections'],
  ['action types', ontology('action-types.yaml'), 'declared in `ontology/action-types.yaml`'],
  ['object types', ontology('object-types.yaml'), 'declared in `ontology/object-types.yaml`'],
  ['relation types', ontology('relation-types.yaml'), 'declared in `ontology/relation-types.yaml`'],
  [
    'decision records',
    decisions.length,
    `under \`docs/decisions/\` — ${decisionStatus.filter((s) => s === 'accepted').length} accepted, ${decisionStatus.filter((s) => s === 'proposed').length} proposed`,
  ],
  [
    'architecture requirements',
    new Set(sas.match(/KF-SAS-RQ-\d{3}/g) ?? []).size,
    'distinct identifiers in §106',
  ],
  [
    'test files',
    walk('tests', (name) => name.endsWith('.test.ts')).length +
      walk('apps', (name) => name.endsWith('.test.ts')).length +
      walk('packages', (name) => name.endsWith('.test.ts')).length,
    '`*.test.ts` under `tests/`, `apps/` and `packages/`',
  ],
];

const body = `<!-- GENERATED by scripts/measurements.mjs — do not hand-edit; the gate fails on drift. -->

# Measured counts

Derived from this checkout, every time the gate runs. No document states these numbers; documents
cite this file. A figure here cannot be stale without the build failing, which is the property the
prose version never had.

These are **source counts** in the sense of §103.3 — derived from the repository, and they move
when it moves. A **runtime count**, measured against a live database, cannot be derived from a
checkout and is not here; §38 and §40 carry those with their measurement date and host.

| Measure | Count | Derived from |
| --- | ---: | --- |
${measures.map(([name, count, from]) => `| ${name} | ${count} | ${from} |`).join('\n')}
`;

/**
 * A zero is a broken derivation, not an empty repository.
 *
 * The relation-type count was zero on first run because the pattern did not match that file's
 * style, and it printed as a fact. Nothing downstream could have told it from the truth. This
 * repository has none of these things in zero quantity, so refusing is always the right answer
 * and a future measure that legitimately can be zero should say so here, deliberately.
 */
const empty = measures.filter(([, count]) => count === 0).map(([name]) => name);
if (empty.length > 0) {
  process.stderr.write(
    `refusing to write a measurement of zero for: ${empty.join(', ')}.\n` +
      'A zero here has always meant the derivation is broken, never that the repository is empty.\n',
  );
  process.exit(1);
}

writeFileSync(join(ROOT, 'generated/measurements.md'), body);
process.stdout.write(`generated/measurements.md — ${measures.length} measures\n`);
