#!/usr/bin/env node
// Write the DRBench overlay from the extracted benchmark (extract.mjs first):
//
//   overlay/people.json    each company's people with role, clearance and ceiling
//   overlay/stats.json     counts by company, format, classification and grants
//   sample/                the committed sample: the files of SAMPLE_TASKS (manifest.json,
//                          files/ originals, text/ extracted), a few hundred kilobytes
//
//   node fixtures/drbench/generate-overlay.mjs [--corpus <dir>] [--check]

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { countBy } from '../lib/extract-files.mjs';
import { readJson } from '../lib/loader.mjs';
import { DEFAULT_DATA, HERE, companiesIn } from './fixture.mjs';
import { SAMPLE_TASKS } from './overlay-source.mjs';

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const args = process.argv.slice(2);
const check = args.includes('--check');
const i = args.indexOf('--corpus');
const corpus = i >= 0 ? args[i + 1] : DEFAULT_DATA;

const manifest = await readJson(path.join(corpus, 'manifest.json'));
const companies = await companiesIn(corpus);
const all = companies.flatMap((c) => c.documents.map((d) => ({ ...d, companyName: c.name })));
const stats = {
  tasks: manifest.tasks.length,
  files: all.length,
  missing_from_dataset: manifest.missing.map((m) => m.source),
  by_company: countBy(all, (d) => d.companyName),
  by_format: countBy(all, (d) => d.format),
  by_classification: countBy(all, (d) => d.classification),
  by_company_and_classification: countBy(all, (d) => `${d.companyName} ${d.classification}`),
  by_qa_type: countBy(all, (d) => d.qa_type),
  by_method: manifest.stats.by_method,
  grants: all.reduce(
    (n, d) => n + d.readers.length * (d.text === null || d.format === 'jsonl' ? 1 : 2),
    0,
  ),
  people: Object.fromEntries(companies.map((c) => [c.name, c.people.length])),
};
const people = Object.fromEntries(companies.map((c) => [c.company.slug, c.people]));
const sampleTasks = manifest.tasks.filter((t) => SAMPLE_TASKS.includes(t.task));
const sampleKeys = new Set(sampleTasks.flatMap((t) => t.files));
const sampleRows = manifest.files.filter((f) => sampleKeys.has(f.key));
const outputs = new Map([
  ['overlay/people.json', json(people)],
  ['overlay/stats.json', json(stats)],
  [
    'sample/manifest.json',
    json({
      source: manifest.source,
      files: sampleRows,
      tasks: sampleTasks,
      companies: manifest.companies,
    }),
  ],
]);
for (const row of sampleRows) {
  if (row.format !== 'jsonl')
    outputs.set(
      path.join('sample', 'files', row.path),
      await readFile(path.join(corpus, 'hf', 'data', row.path)),
    );
  if (row.text !== null)
    outputs.set(
      path.join('sample', row.text.file),
      await readFile(path.join(corpus, row.text.file)),
    );
}
const drift = [];
if (!check) await rm(path.join(HERE, 'sample'), { recursive: true, force: true });
for (const [rel, content] of outputs) {
  const file = path.join(HERE, rel);
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (check) {
    if (!existsSync(file) || !(await readFile(file)).equals(bytes)) drift.push(rel);
  } else {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
}
process.stdout.write(
  `${JSON.stringify({ files: stats.files, sample: sampleRows.length, grants: stats.grants, by_classification: stats.by_classification })}\n`,
);
if (drift.length > 0) {
  process.stderr.write(`drift from the committed overlay: ${drift.join(', ')}\n`);
  process.exitCode = 1;
}
