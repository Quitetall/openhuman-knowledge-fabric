#!/usr/bin/env node
// Write the TheAgentCompany overlay from the extracted drive (extract.mjs first):
//
//   overlay/people.json    the roster with role, clearance and ceiling (from overlay-source.mjs)
//   overlay/stats.json     the drive's counts by format, classification, method and grants
//   sample/                the committed sample: manifest.json, files/ (originals), text/
//
//   node fixtures/theagentcompany/generate-overlay.mjs [--corpus <dir>] [--check]

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { countBy } from '../lib/extract-files.mjs';
import { readJson } from '../lib/loader.mjs';
import { DEFAULT_DATA, HERE, documentsIn } from './fixture.mjs';
import { PEOPLE, SAMPLE_PATHS } from './overlay-source.mjs';

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const args = process.argv.slice(2);
const check = args.includes('--check');
const i = args.indexOf('--corpus');
const corpus = i >= 0 ? args[i + 1] : DEFAULT_DATA;

const manifest = await readJson(path.join(corpus, 'manifest.json'));
const documents = await documentsIn(corpus);
const stats = {
  files: documents.length,
  skipped: manifest.skipped.length,
  by_format: countBy(documents, (d) => d.format),
  by_classification: countBy(documents, (d) => d.classification),
  by_method: manifest.stats.by_method,
  derived_texts: documents.filter((d) => d.text !== null).length,
  grants: documents.reduce((n, d) => n + d.readers.length * (d.text === null ? 1 : 2), 0),
  people: PEOPLE.length,
};
const sampleRows = manifest.files.filter((f) => SAMPLE_PATHS.includes(f.path));
const missing = SAMPLE_PATHS.filter((p) => !sampleRows.some((r) => r.path === p));
if (missing.length > 0) throw new Error(`sample files not in the drive: ${missing.join(', ')}`);
const outputs = new Map([
  ['overlay/people.json', json(PEOPLE)],
  ['overlay/stats.json', json(stats)],
  ['sample/manifest.json', json({ source: manifest.source, files: sampleRows })],
]);
const files = new Map();
for (const row of sampleRows) {
  files.set(
    path.join('sample', 'files', row.path),
    await readFile(path.join(corpus, 'owncloud-data', 'files', row.path)),
  );
  if (row.text !== null)
    files.set(path.join('sample', row.text.file), await readFile(path.join(corpus, row.text.file)));
}
const drift = [];
if (!check) {
  await rm(path.join(HERE, 'sample'), { recursive: true, force: true });
}
for (const [rel, content] of [...outputs, ...files]) {
  const file = path.join(HERE, rel);
  if (check) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    if (!existsSync(file) || !(await readFile(file)).equals(bytes)) drift.push(rel);
  } else {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}
process.stdout.write(
  `${JSON.stringify({ files: stats.files, sample: sampleRows.length, grants: stats.grants })}\n`,
);
if (drift.length > 0) {
  process.stderr.write(`drift from the committed overlay: ${drift.join(', ')}\n`);
  process.exitCode = 1;
}
