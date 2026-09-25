// The EnterpriseRAG-Bench fixture as data: its people (from the committed overlay) and its
// documents (from a manifest — the extracted selection under the data directory, or the
// committed sample), each with the classification and readers overlay-source.mjs decides.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, readJsonLines } from '../lib/loader.mjs';
import {
  ARTIFACT_KINDS,
  CORPUS,
  FOUNDER,
  KEY_PREFIX,
  LEGAL_NAME,
  OFFICE,
  classify,
  mailParticipants,
  nameKey,
  readersOf,
} from './overlay-source.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SAMPLE_DIR = path.join(HERE, 'sample');
export const DEFAULT_DATA = process.env.KF_ERB_CORPUS ?? '/mnt/4tb/data/enterprise-rag-bench';

const SOURCE_LABEL = {
  slack: 'Slack',
  gmail: 'Gmail',
  linear: 'Linear',
  google_drive: 'Google Drive',
  hubspot: 'HubSpot',
  fireflies: 'Fireflies',
  github: 'GitHub',
  jira: 'Jira',
  confluence: 'Confluence',
};

export async function loadPeople() {
  return readJson(path.join(HERE, 'overlay', 'people.json'));
}

/** The documents of a manifest in `dir` (`manifest.jsonl` + the files it names). */
export async function documentsIn(dir, people, manifest = 'manifest.jsonl') {
  const rows = await readJsonLines(path.join(dir, manifest));
  const byKey = new Map(people.map((p) => [p.key, p]));
  const byName = new Map(people.map((p) => [nameKey(p.name), p.key]));
  const documents = [];
  for (const row of rows) {
    const { classification, rule } = classify(row.source_path, byKey);
    const file = path.join(dir, row.file);
    const participants =
      row.source_type === 'gmail' ? mailParticipants(await readFile(file, 'utf8'), byName) : [];
    const doc = { ...row, classification, classification_rule: rule, file };
    doc.readers = readersOf(doc, people, { participants });
    documents.push(doc);
  }
  return documents;
}

/** The loader's view of one document. */
export function toLoadable(doc) {
  const source = SOURCE_LABEL[doc.source_type] ?? doc.source_type;
  const title = `${doc.title} — ${source}`.slice(0, 512);
  return {
    key: doc.key,
    title,
    classification: doc.classification,
    artifactKind: ARTIFACT_KINDS[doc.source_type] ?? 'document',
    mediaType: 'text/markdown',
    file: doc.file,
    sha256: doc.sha256,
    readers: doc.readers,
    reason:
      `Redwood Inference knowledge estate migration (EnterpriseRAG-Bench ${doc.doc_id}): ` +
      `${doc.source_path}, classified ${doc.classification} under rule ${doc.classification_rule}`,
    grantReason: (person) =>
      `Need-to-know RW-SEC-NTK-01: ${person.name}, ${person.title} (${person.department}), ` +
      `reads ${doc.source_path}`,
  };
}

export async function fixture({ sample, full = false, data = DEFAULT_DATA }) {
  const people = await loadPeople();
  const documents = await documentsIn(
    sample ? SAMPLE_DIR : data,
    people,
    full ? 'manifest-full.jsonl' : 'manifest.jsonl',
  );
  return {
    corpus: CORPUS,
    keyPrefix: KEY_PREFIX,
    company: { legal_name: LEGAL_NAME, kind: 'company' },
    people,
    founder: FOUNDER,
    office: OFFICE,
    authorityReason: (p) =>
      `Redwood Inference authority matrix RW-GOV-2026-01: ${p.name}, ${p.title} ` +
      `(${p.department}), acts as ${p.role} cleared to ${p.clearance}` +
      (p.ceiling === p.clearance ? '' : `, organization-wide reading capped at ${p.ceiling}`),
    documents: documents.map(toLoadable),
    raw: documents,
  };
}
