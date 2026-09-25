// The TheAgentCompany fixture as data: the roster, and the drive's files from a manifest (the
// extracted drive under the data directory, or the committed sample), each classified and
// granted as overlay-source.mjs decides.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadableFile } from '../lib/file-corpus.mjs';
import { readJson } from '../lib/loader.mjs';
import {
  CORPUS,
  FOUNDER,
  KEY_PREFIX,
  LEGAL_NAME,
  OFFICE,
  PEOPLE,
  artifactKindOf,
  classify,
  readersOf,
} from './overlay-source.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SAMPLE_DIR = path.join(HERE, 'sample');
export const DEFAULT_DATA = process.env.KF_TAC_CORPUS ?? '/mnt/4tb/data/theagentcompany';

/** Every file of a manifest with its classification and readers. */
export async function documentsIn(dir) {
  const manifest = await readJson(path.join(dir, 'manifest.json'));
  return manifest.files.map((row) => {
    const { classification, rule } = classify(row.path);
    const doc = { ...row, classification, classification_rule: rule };
    doc.readers = readersOf(doc, PEOPLE);
    return doc;
  });
}

export function rootOf(dir) {
  return dir === SAMPLE_DIR ? path.join(dir, 'files') : path.join(dir, 'owncloud-data', 'files');
}

export async function fixture({ sample, data = DEFAULT_DATA }) {
  const dir = sample ? SAMPLE_DIR : data;
  const documents = await documentsIn(dir);
  const byKey = new Map(PEOPLE.map((p) => [p.key, p]));
  return {
    corpus: CORPUS,
    keyPrefix: KEY_PREFIX,
    company: { legal_name: LEGAL_NAME, kind: 'company' },
    people: PEOPLE,
    founder: FOUNDER,
    office: OFFICE,
    authorityReason: (p) =>
      `The Agent Company authority matrix TAC-GOV-2026-01: ${p.name}, ${p.title}, acts as ` +
      `${p.role} cleared to ${p.clearance}` +
      (p.ceiling === p.clearance ? '' : `, organization-wide reading capped at ${p.ceiling}`),
    documents: documents.map((doc) =>
      loadableFile(doc, {
        root: rootOf(dir),
        dataDir: dir,
        classification: doc.classification,
        readers: doc.readers,
        describe: (row) => ({
          title: row.path.replace(/^Documents\//, ''),
          artifactKind: artifactKindOf(row.path),
          reason:
            `The Agent Company ownCloud migration (TheAgentCompany drive): ${row.path}, ` +
            `classified ${doc.classification} under rule ${doc.classification_rule}`,
          grantReason: (person) =>
            `Need-to-know TAC-SEC-01: ${byKey.get(person.key).title} reads ${row.path}`,
        }),
      }),
    ),
    raw: documents,
  };
}
