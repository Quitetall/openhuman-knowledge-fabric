// The DRBench fixture as data: three companies, each its own organization, with their people and
// the files of their tasks from a manifest (the extracted benchmark under the data directory, or
// the committed sample), each classified and granted as overlay-source.mjs decides.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadableFile } from '../lib/file-corpus.mjs';
import { readJson } from '../lib/loader.mjs';
import {
  COMPANIES,
  CORPUS,
  KEY_PREFIX,
  artifactKindOf,
  classify,
  peopleOf,
  personKey,
  readersOf,
} from './overlay-source.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SAMPLE_DIR = path.join(HERE, 'sample');
export const DEFAULT_DATA = process.env.KF_DRBENCH_CORPUS ?? '/mnt/4tb/data/drbench';

export const rootOf = (dir) =>
  dir === SAMPLE_DIR ? path.join(dir, 'files') : path.join(dir, 'hf', 'data');

/** What a file is about, for classification: its name, and a mail or chat's subjects/teams. */
export function aboutOf(row) {
  return [path.basename(row.destination ?? row.path), row.about ?? ''].join(' | ');
}

function titleOf(row) {
  const name = path.basename(row.destination ?? row.path);
  if (row.app === 'email')
    return `Mail: ${(row.about ?? '').split(' | ')[0] || name} · ${row.task}`;
  if (row.app === 'mattermost')
    return `Chat: ${(row.about ?? '').split(' | ').slice(0, 2).join(', ') || name} · ${row.task}`;
  return `${name} · ${row.task}`;
}

/** Every company's people and documents in a manifest directory. */
export async function companiesIn(dir) {
  const manifest = await readJson(path.join(dir, 'manifest.json'));
  const out = [];
  for (const [name, company] of Object.entries(COMPANIES)) {
    const tasks = manifest.tasks.filter((t) => t.company === company.slug);
    const people = peopleOf(company, [
      ...manifest.companies[company.slug].personas,
      ...tasks.map((t) => t.asker),
    ]);
    const byEmail = new Map(people.map((p) => [p.corpus_email?.toLowerCase(), p.key]));
    const askersOf = new Map();
    for (const t of tasks)
      for (const key of t.files)
        askersOf.set(key, [...(askersOf.get(key) ?? []), personKey(t.asker.name)]);
    const documents = manifest.files
      .filter((r) => r.company === company.slug)
      .map((row) => {
        const { classification, rule } = classify(aboutOf(row));
        const doc = {
          ...row,
          classification,
          classification_rule: rule,
          askers: askersOf.get(row.key) ?? [],
          participants: (row.addresses ?? []).map((a) => byEmail.get(a)).filter(Boolean),
        };
        doc.readers = readersOf(doc, people);
        return doc;
      });
    out.push({ name, company, people, tasks, documents });
  }
  return out;
}

/** The loader's fixture for one company. */
export function fixtureOf({ name, company, people, documents }, dir) {
  const office = people.find((p) => p.persona === 'records');
  return {
    corpus: `${CORPUS}-${company.slug}`,
    personasCorpus: CORPUS,
    keyPrefix: `${KEY_PREFIX}:${company.slug}`,
    company: { legal_name: company.legal_name, kind: 'company' },
    people,
    founder: office.key,
    office: office.key,
    authorityReason: (p) =>
      `${name} authority matrix DRB-GOV-2026-01: ${p.name}, ${p.title} (${p.seniority}), acts as ` +
      `${p.role} cleared to ${p.clearance}` +
      (p.ceiling === p.clearance ? '' : `, organization-wide reading capped at ${p.ceiling}`),
    documents: documents.map((doc) => {
      const describe = (row) => ({
        title: titleOf(row),
        artifactKind: artifactKindOf(row.format, row.app),
        reason:
          `${name} research estate (DRBench ${row.task}, ${row.qa_type} file ${row.key}): ` +
          `${row.destination}, classified ${doc.classification} (${doc.classification_rule})`,
        grantReason: (person) =>
          `Need-to-know DRB-SEC-01: ${person.name}, ${person.title}, ` +
          (doc.askers.includes(person.key) ? `researches ${row.task}` : 'is on this mail'),
      });
      if (doc.format === 'jsonl') {
        // A mail or chat export is loaded as its rendered transcript: the export itself carries
        // the benchmark sandbox's account passwords, which KF's content rules would refuse.
        return loadableFile(
          {
            ...doc,
            path: doc.text.file,
            mediaType: 'text/markdown',
            sha256: doc.text.sha256,
            text: null,
          },
          {
            root: dir,
            dataDir: dir,
            classification: doc.classification,
            readers: doc.readers,
            describe,
          },
        );
      }
      return loadableFile(doc, {
        root: rootOf(dir),
        dataDir: dir,
        classification: doc.classification,
        readers: doc.readers,
        describe,
      });
    }),
  };
}
