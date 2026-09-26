#!/usr/bin/env node
// TheAgentCompany's ownCloud drive → a manifest and text tree the fixture loader reads.
//
//   node fixtures/theagentcompany/extract.mjs [--corpus /mnt/4tb/data/theagentcompany] [--jobs 6]
//
// The drive is the pre-baked data of the benchmark's ownCloud image (its repository keeps only
// the Dockerfile; servers/owncloud/Makefile `backup` shows the data lives in the image). Get it
// without running the image:
//
//   docker pull ghcr.io/theagentcompany/servers-owncloud:latest
//   id=$(docker create ghcr.io/theagentcompany/servers-owncloud:latest)
//   docker cp "$id:/var/www/html/data/theagentcompany" <corpus>/owncloud-data; docker rm "$id"
//
// and clone https://github.com/TheAgentCompany/TheAgentCompany into <corpus>/repo-direct for the
// task definitions (the eval). Writes <corpus>/manifest.json and <corpus>/text/…, resumably.

import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { countBy, extractFiles, sha256 } from '../lib/extract-files.mjs';
import { plan } from '../lib/extract-text.mjs';
import { included } from './overlay-source.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const corpus = flag('--corpus', process.env.KF_TAC_CORPUS ?? '/mnt/4tb/data/theagentcompany');
const jobs = Number(flag('--jobs', '6'));
const root = path.join(corpus, 'owncloud-data', 'files');

async function walk(dir, rel = '') {
  const out = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...(await walk(dir, r)));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

const all = (await walk(root)).sort();
const skipped = [];
const entries = [];
for (const rel of all) {
  if (!included(rel) || !plan(rel).supported) {
    skipped.push(rel);
    continue;
  }
  // A key from the path: the drive holds the same bytes in several folders (the same 10-K under
  // Financials/ and Data Analysis/), and each copy is its own file.
  entries.push({ key: `f${sha256(Buffer.from(rel)).slice(0, 16)}`, path: rel });
}
const manifestFile = path.join(corpus, 'manifest.json');
const previous = existsSync(manifestFile)
  ? new Map(JSON.parse(await readFile(manifestFile, 'utf8')).files.map((f) => [f.key, f]))
  : new Map();
const { rows, failures } = await extractFiles(entries, {
  root,
  textRoot: path.join(corpus, 'text'),
  jobs,
  previous,
});
const manifest = {
  source:
    'ghcr.io/theagentcompany/servers-owncloud:latest /var/www/html/data/theagentcompany/files',
  files: rows,
  skipped,
  failures,
  stats: {
    files: rows.length,
    by_format: countBy(rows, (r) => r.format),
    by_method: countBy(rows, (r) => r.text?.method?.replace(/:\d+p$/, '') ?? 'parsed by KF'),
    thin_text: rows.filter((r) => r.text !== null && r.text.chars < 40).map((r) => r.path),
    skipped: skipped.length,
    failures: failures.length,
  },
};
await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(manifest.stats)}\n`);
if (failures.length > 0) process.exitCode = 1;
