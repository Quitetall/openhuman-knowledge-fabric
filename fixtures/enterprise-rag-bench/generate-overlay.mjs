#!/usr/bin/env node
// Write the EnterpriseRAG-Bench overlay from the extracted corpus (extract.py first):
//
//   overlay/people.json     the directory's 167 people with role, clearance and ceiling
//   overlay/stats.json      the selection's counts by source, classification and grants
//   sample/                 the committed sample: manifest.jsonl + each document's content
//
//   node fixtures/enterprise-rag-bench/generate-overlay.mjs [--corpus <dir>] [--check]
//
// Deterministic: a second run writes the same bytes; `--check` regenerates in memory and fails
// on any difference. The sample is every document a small set of questions expects (the first
// two of each question type whose ground truth is at most three documents) plus the first three
// documents, by key, of every (source type, classification) pair of the selection.

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, readJsonLines } from '../lib/loader.mjs';
import { DEFAULT_DATA, HERE, documentsIn } from './fixture.mjs';
import { peopleFromDirectory } from './overlay-source.mjs';

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function sampleQuestions(questions) {
  const chosen = [];
  const perType = new Map();
  for (const q of [...questions].sort((a, b) => a.question_id.localeCompare(b.question_id))) {
    const n = perType.get(q.question_type) ?? 0;
    if (n >= 2 || q.expected_doc_ids.length > 3) continue;
    perType.set(q.question_type, n + 1);
    chosen.push(q.question_id);
  }
  return chosen;
}

async function build(corpus) {
  const directory = await readJson(path.join(corpus, 'directory.json'));
  const people = peopleFromDirectory(directory);
  if (new Set(people.map((p) => p.key)).size !== people.length)
    throw new Error('two directory entries share a key');
  const documents = await documentsIn(corpus, people);
  const questions = await readJsonLines(path.join(corpus, 'questions.jsonl'));
  const selection = await readJson(path.join(corpus, 'selection.json'));

  const count = (f) => {
    const out = {};
    for (const d of documents) out[f(d)] = (out[f(d)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(out).sort());
  };
  const stats = {
    selection: selection.rule,
    documents: documents.length,
    expected_documents: selection.expected_documents,
    by_source_type: count((d) => d.source_type),
    by_classification: count((d) => d.classification),
    by_source_and_classification: count((d) => `${d.source_type} ${d.classification}`),
    grants: documents.reduce((n, d) => n + d.readers.length, 0),
    people: people.length,
    people_by_tier: Object.fromEntries(
      Object.entries(
        people.reduce((acc, p) => ({ ...acc, [p.tier]: (acc[p.tier] ?? 0) + 1 }), {}),
      ).sort(),
    ),
  };

  const sampleIds = new Set();
  const chosenQuestions = sampleQuestions(questions);
  for (const q of questions)
    if (chosenQuestions.includes(q.question_id))
      for (const id of q.expected_doc_ids) sampleIds.add(id);
  const perPair = new Map();
  for (const d of documents) {
    const pair = `${d.source_type} ${d.classification}`;
    const n = perPair.get(pair) ?? 0;
    if (n < 3) {
      perPair.set(pair, n + 1);
      sampleIds.add(d.doc_id);
    }
  }
  const sample = documents.filter((d) => sampleIds.has(d.doc_id));
  const files = new Map();
  for (const d of sample)
    files.set(path.join('docs', d.source_type, `${d.key}.md`), await readFile(d.file));
  const manifest = sample
    .map((d) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries({
            bytes: d.bytes,
            doc_id: d.doc_id,
            expected: d.expected,
            file: path.join('docs', d.source_type, `${d.key}.md`),
            key: d.key,
            sha256: d.sha256,
            source_path: d.source_path,
            source_type: d.source_type,
            title: d.title,
          }),
        ),
      ),
    )
    .join('\n');
  const sampleQuestionsFile = questions
    .filter((q) => chosenQuestions.includes(q.question_id))
    .map((q) => JSON.stringify(q))
    .join('\n');
  return {
    outputs: new Map([
      [path.join('overlay', 'people.json'), json(people)],
      [path.join('overlay', 'stats.json'), json(stats)],
      [path.join('sample', 'manifest.jsonl'), `${manifest}\n`],
      [path.join('sample', 'questions.jsonl'), `${sampleQuestionsFile}\n`],
    ]),
    files,
    stats,
    sample: sample.length,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const i = args.indexOf('--corpus');
  const corpus = i >= 0 ? args[i + 1] : DEFAULT_DATA;
  const { outputs, files, stats, sample } = await build(corpus);
  const drift = [];
  for (const [rel, content] of outputs) {
    const file = path.join(HERE, rel);
    if (check) {
      if (!existsSync(file) || (await readFile(file, 'utf8')) !== content) drift.push(rel);
    } else {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
  }
  const docsDir = path.join(HERE, 'sample', 'docs');
  if (check) {
    for (const [rel, bytes] of files) {
      const file = path.join(HERE, 'sample', rel);
      if (!existsSync(file) || !(await readFile(file)).equals(bytes)) drift.push(`sample/${rel}`);
    }
  } else {
    await rm(docsDir, { recursive: true, force: true });
    for (const [rel, bytes] of files) {
      const file = path.join(HERE, 'sample', rel);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
    }
  }
  if (check && existsSync(docsDir)) {
    for (const source of await readdir(docsDir)) {
      for (const name of await readdir(path.join(docsDir, source))) {
        if (!files.has(path.join('docs', source, name)))
          drift.push(`sample/docs/${source}/${name}`);
      }
    }
  }
  process.stdout.write(
    `${JSON.stringify({ documents: stats.documents, sample, grants: stats.grants, by_classification: stats.by_classification })}\n`,
  );
  if (drift.length > 0) {
    process.stderr.write(`drift from the committed overlay: ${drift.join(', ')}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
