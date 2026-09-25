#!/usr/bin/env node
// DRBench → a manifest and text tree the fixture loader reads.
//
//   hf download ServiceNow/drbench --repo-type dataset --local-dir <corpus>/hf
//   node fixtures/drbench/extract.mjs [--corpus /mnt/4tb/data/drbench] [--jobs 6]
//
// Every task's environment (config/env.json: the files, mail and chat its sandbox is seeded
// with) is one file each, keyed `<task>-<file dir>`; a file KF cannot parse gets its text under
// <corpus>/text/ (fixtures/lib/extract-text.mjs). Writes <corpus>/manifest.json with the files,
// the tasks (question, asker, insight files) and the company personas, resumably.

import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { countBy, extractFiles } from '../lib/extract-files.mjs';
import { companyOf } from './overlay-source.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const corpus = flag('--corpus', process.env.KF_DRBENCH_CORPUS ?? '/mnt/4tb/data/drbench');
const jobs = Number(flag('--jobs', '6'));
const root = path.join(corpus, 'hf', 'data');
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

/** What a mail or chat export is about, and the addresses on its mails. */
function describeJsonl(content) {
  const about = [];
  const addresses = new Set();
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    const m = JSON.parse(line);
    if (m.type === 'email') {
      about.push(m.subject ?? '');
      for (const a of [m.from, ...(m.to ?? []), ...(m.cc ?? [])])
        if (a) addresses.add(a.toLowerCase());
    } else if (m.type === 'team') about.push(m.team.display_name ?? '');
    else if (m.type === 'channel') about.push(m.channel.display_name ?? m.channel.name ?? '');
  }
  return { about: about.join(' | '), addresses: [...addresses].sort() };
}

const tasks = [];
const entries = [];
const missing = [];
for (const task of (await readdir(path.join(root, 'tasks'))).sort()) {
  const config = path.join(root, 'tasks', task, 'config');
  if (!existsSync(path.join(config, 'task.json'))) continue;
  const t = await readJson(path.join(config, 'task.json'));
  const env = await readJson(path.join(config, 'env.json'));
  const info = existsSync(path.join(root, 'tasks', task, 'info.json'))
    ? await readJson(path.join(root, 'tasks', task, 'info.json'))
    : {};
  const company = companyOf(t.company_info.name);
  const files = [];
  for (const f of env.env_files) {
    const rel = f.source.replace(/^drbench\/data\//, '');
    const dir = path.basename(path.dirname(rel));
    const key = `${task}-${dir}`;
    if (!existsSync(path.join(root, rel))) {
      missing.push({ task, key, source: f.source });
      continue;
    }
    const entry = {
      key,
      path: rel,
      task,
      company: company.slug,
      app: f.app,
      qa_type: f.qa_type,
      destination: f.destination,
    };
    if (rel.endsWith('.jsonl'))
      Object.assign(entry, describeJsonl(await readFile(path.join(root, rel), 'utf8')));
    entries.push(entry);
    files.push(key);
  }
  tasks.push({
    task,
    company: company.slug,
    question: t.dr_question,
    asker: {
      name: t.persona.name,
      email: t.persona.email,
      role: t.persona.role,
      department: t.persona.department,
      seniority: t.persona.seniority,
    },
    domain: info.domain ?? t.persona.domain ?? null,
    difficulty: info.difficulty ?? null,
    files,
  });
}
const personas = {};
for (const [name, c] of Object.entries((await import('./overlay-source.mjs')).COMPANIES)) {
  const s = await readJson(path.join(root, 'contexts', 'company_structures', c.structure));
  personas[c.slug] = { name, company_info: s.company_info, personas: s.personas };
}
const manifestFile = path.join(corpus, 'manifest.json');
const previous = existsSync(manifestFile)
  ? new Map((await readJson(manifestFile)).files.map((f) => [f.key, f]))
  : new Map();
const { rows, failures } = await extractFiles(entries, {
  root,
  textRoot: path.join(corpus, 'text'),
  jobs,
  previous,
});
const manifest = {
  source: 'huggingface.co/datasets/ServiceNow/drbench data/tasks/*/config/env.json',
  files: rows,
  tasks,
  companies: personas,
  missing,
  failures,
  stats: {
    tasks: tasks.length,
    files: rows.length,
    by_company: countBy(rows, (r) => r.company),
    by_format: countBy(rows, (r) => r.format),
    by_method: countBy(rows, (r) => r.text?.method?.replace(/:\d+p$/, '') ?? 'parsed by KF'),
    by_qa_type: countBy(rows, (r) => r.qa_type),
    thin_text: rows.filter((r) => r.text !== null && r.text.chars < 40).map((r) => r.path),
    missing: missing.length,
    failures: failures.length,
  },
};
await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(manifest.stats)}\n`);
if (failures.length > 0) process.exitCode = 1;
