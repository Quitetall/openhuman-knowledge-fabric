#!/usr/bin/env node
// Véracier overlay generator: the governed layer over the EDiTh corpus, written as data.
//
//   node fixtures/veracier/generate-overlay.mjs [--corpus /mnt/4tb/data/veracier] [--check]
//
// Reads MASTER_INDEX.csv, ANSWER_KEY.json and the extracted text (`<corpus>/text`, from
// extract-text.mjs) plus the hand-written decisions in overlay-source.mjs and records.mjs, and
// writes fixtures/veracier/overlay/{people,documents,records,sample}.json. Deterministic: the only
// randomness is a seeded generator (SEED below) choosing staff names, and every list is sorted, so
// the same inputs give byte-identical files. `--check` regenerates in memory and exits 1 when a
// committed file differs, which is what the fixture test runs when the corpus is present.
//
// What it does not do: read the PDFs, or judge a classification. The rules in overlay-source.mjs
// are the decision; this applies them, and the README's table is written from the same rules.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './lib/csv.mjs';
import {
  ASKERS,
  CLASSIFICATION_RULES,
  DEPARTMENT_FOLDERS,
  ENTITIES,
  LEGAL_NAME,
  NAME_POOLS,
  STAFF,
  USE_CASE_FOLDERS,
} from './overlay-source.mjs';
import { COUNTERPARTIES, RECORDS } from './records.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'overlay');
const SEED = 20260924;
const RANK = { public: 0, internal: 1, confidential: 2, restricted: 3 };
const SAMPLE_SIZE = 80;

/** mulberry32: small, seedable, and the same on every platform. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ascii = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, '');

function username(name) {
  return ascii(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.|\.$/g, '');
}

export function classify(entity, relPath) {
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.entity !== undefined && rule.entity !== entity) continue;
    if (relPath.startsWith(rule.match)) return rule;
  }
  throw new Error(`no classification rule for ${entity}/${relPath}`);
}

const LETTERHEAD =
  /(RCS|RC |TVA|HRB|Companies House|Delaware|Amtsgericht|^\s*V\s|Rue |Route |Avenue|Boulevard|Park|Zone |Strasse|France|Deutschland|United Kingdom|USA|Maroc|\b\d{5}\b|VRC-|\d{2}\/\d{2}\/\d{4})/;

/** The document's own heading: the first mostly-uppercase line after the letterhead. */
export function headingOf(text) {
  const lines = text.split(/\r?\n|\f/).slice(0, 60);
  for (const raw of lines) {
    const line = raw.trim().replace(/\s{2,}/g, ' ');
    if (line.length < 6 || line.length > 110 || !line.includes(' ')) continue;
    if (LETTERHEAD.test(line)) continue;
    const letters = line.replace(/[^A-Za-zÀ-ÿ]/g, '');
    if (letters.length < 5) continue;
    const upper = letters.replace(/[^A-ZÀ-Þ]/g, '').length;
    if (upper / letters.length < 0.7) continue;
    return line.replace(/[\s:;,/(–—-]+$/, '');
  }
  return undefined;
}

/** Kept in capitals when a heading is put into sentence case. */
const ACRONYMS = new Set(
  (
    'ISO NCR RNC CAPA FAI EASA FAA PMA ITAR EAR DDTC MOD NIS2 RSE CSE CSRD IFRS EN AS NDT PV CA AG ' +
    'SA SAS SARL GMBH UK US USA IP RH RGPD GDPR DPA NDA DGA DGAM DRSD OTAN NATO KPI RCC-M ASN ENF ' +
    'IATF FMEA PPAP NADCAP DEFCON CAC TVA PDG CEO CFO CTO COO CISO EDF SNCF AOG DOA POA QMS ERP'
  ).split(' '),
);

function titleCase(heading) {
  // Headings are set in capitals; a title reads better in sentence case, acronyms kept.
  return heading
    .split(' ')
    .map((w, i) => {
      if (/\d/.test(w) || ACRONYMS.has(w.replace(/[^A-Za-z0-9-]/g, '').toUpperCase())) return w;
      const lower = w.toLocaleLowerCase('fr');
      return i === 0 ? lower.charAt(0).toLocaleUpperCase('fr') + lower.slice(1) : lower;
    })
    .join(' ');
}

/**
 * A title from the document's own words: its heading, then the entity and the file's path. The
 * index's `description` column is NOT used: it is the benchmark author's annotation ("MSA with
 * change-of-control clause"), and putting it in the title would hand search the answer.
 */
function documentTitle(row, text) {
  const heading = text === undefined ? undefined : headingOf(text);
  const base = row.filename
    .split('/')
    .pop()
    .replace(/\.pdf$/, '')
    .replace(/_/g, ' ');
  const label = heading === undefined ? base : titleCase(heading);
  return `${label} — ${ENTITIES[row.entity].short} · ${row.filename}`;
}

function folderMatches(relPath, folders) {
  return folders.some((f) => f === '*' || relPath.startsWith(f));
}

function args(argv) {
  const out = { corpus: '/mnt/4tb/data/veracier', check: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--corpus') out.corpus = argv[++i];
    else if (argv[i] === '--check') out.check = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return out;
}

function buildPeople() {
  const random = prng(SEED);
  const pick = (list, used) => {
    for (let n = 0; n < 1000; n += 1) {
      const candidate = list[Math.floor(random() * list.length)];
      if (!used.has(candidate)) return candidate;
    }
    throw new Error('name pool exhausted');
  };
  const people = [];
  const usedNames = new Set();
  for (const [asker, spec] of Object.entries(ASKERS)) {
    people.push({ ...spec, asker, key: username(spec.name) });
    usedNames.add(spec.name);
  }
  const usedFirst = new Set();
  const usedLast = new Set();
  for (const post of STAFF) {
    let name = post.name;
    if (name === undefined) {
      const pool = NAME_POOLS[ENTITIES[post.entity].country];
      name = `${pick(pool[post.g ?? 'm'], usedFirst)} ${pick(pool.last, usedLast)}`;
      usedFirst.add(name.split(' ')[0]);
      usedLast.add(name.split(' ').slice(1).join(' '));
    }
    if (usedNames.has(name)) throw new Error(`duplicate person ${name}`);
    usedNames.add(name);
    const { name: _n, g: _g, ...rest } = post;
    people.push({ ...rest, name, key: username(name) });
  }
  for (const p of people) {
    if (p.scope === 'group' && p.ceiling === undefined) throw new Error(`${p.name}: no ceiling`);
    if (p.scope === 'entity') p.ceiling = 'public';
    p.username = p.key;
    p.email = `${p.key}@veracier.example`;
  }
  const keys = new Set();
  for (const p of people) {
    if (keys.has(p.key)) throw new Error(`duplicate key ${p.key}`);
    keys.add(p.key);
  }
  return people.sort((a, b) => a.key.localeCompare(b.key));
}

/** Who reads a document, beyond what their role reaches organization-wide. */
function readersOf(doc, people, askerKeysByQuestion) {
  const readers = new Set();
  const rel = doc.path;
  const top = rel.split('/')[0];
  const useCase = USE_CASE_FOLDERS[top];
  for (const p of people) {
    if (RANK[doc.classification] > RANK[p.clearance]) continue;
    // An organization-wide grant already reaches it: no object grant is recorded.
    if (RANK[doc.classification] <= RANK[p.ceiling]) continue;
    let reason;
    const home = [p.entity, ...(p.entities ?? [])];
    if (home.includes(doc.entity) || p.scope === 'group') {
      const own = home.includes(doc.entity);
      if (useCase !== undefined && own && useCase.includes(p.department)) reason = 'use-case team';
      else if (own && folderMatches(rel, DEPARTMENT_FOLDERS[p.department] ?? []))
        reason = 'department';
      else if (p.scope === 'group' && folderMatches(rel, DEPARTMENT_FOLDERS[p.department] ?? []))
        reason = 'group function';
    }
    if (reason === undefined) {
      for (const q of doc.questions) {
        if ((askerKeysByQuestion.get(q) ?? []).includes(p.key)) reason = `asker ${q}`;
      }
    }
    if (reason !== undefined) readers.add(p.key);
  }
  return [...readers].sort();
}

function selectSample(documents, required) {
  // The documents the records rest on (so --sample exercises every record act), then every
  // entity, top-level folder kind, language, format and classification not yet covered — greedy,
  // so each pick covers the most not yet covered — then a seeded fill of small files.
  const random = prng(SEED + 1);
  const features = (d) => [
    `entity:${d.entity}`,
    `folder:${d.path.split('/')[0].replace(/_\d+$/, '_uc')}`,
    `lang:${d.language}`,
    `format:${d.format}`,
    `class:${d.classification}`,
  ];
  const want = new Set(documents.flatMap(features));
  const chosen = new Set(required);
  for (const d of documents) {
    if (chosen.has(d.doc_id)) for (const f of features(d)) want.delete(f);
  }
  while (want.size > 0) {
    let best;
    let bestScore = 0;
    for (const d of documents) {
      if (chosen.has(d.doc_id)) continue;
      const score = features(d).filter((f) => want.has(f)).length * 10 - d.pdf_bytes / 4e6;
      if (score > bestScore) {
        best = d;
        bestScore = score;
      }
    }
    if (best === undefined) break;
    chosen.add(best.doc_id);
    for (const f of features(best)) want.delete(f);
  }
  const scanned = documents.filter((d) => d.format === 'scanned' && d.pdf_bytes < 6e6);
  for (const d of scanned.slice(0, 4)) chosen.add(d.doc_id);
  const rest = documents.filter((d) => !chosen.has(d.doc_id) && d.pdf_bytes < 3e6);
  while (chosen.size < SAMPLE_SIZE && rest.length > 0) {
    const [d] = rest.splice(Math.floor(random() * rest.length), 1);
    chosen.add(d.doc_id);
  }
  return [...chosen].sort();
}

async function build(opts) {
  const rows = parseCsv(await readFile(path.join(opts.corpus, 'MASTER_INDEX.csv'), 'utf8'));
  const answers = JSON.parse(await readFile(path.join(opts.corpus, 'ANSWER_KEY.json'), 'utf8'));
  const people = buildPeople();
  const keyOfAsker = new Map(people.filter((p) => p.asker).map((p) => [p.asker, p.key]));
  const askerKeysByQuestion = new Map();
  for (const [q, spec] of Object.entries(answers)) {
    const key = keyOfAsker.get(spec.asker);
    if (key === undefined) throw new Error(`asker ${spec.asker} of ${q} is not in ASKERS`);
    askerKeysByQuestion.set(q, [key]);
  }

  const byPath = new Map();
  for (const row of rows) {
    const id = `${row.entity}/${row.filename}`;
    const prior = byPath.get(id);
    if (prior === undefined) byPath.set(id, { ...row, questions: [row.question_id] });
    else prior.questions.push(row.question_id);
  }
  const textDir = path.join(opts.corpus, 'text');
  const documents = [];
  for (const row of [...byPath.values()].sort((a, b) =>
    `${a.entity}/${a.filename}`.localeCompare(`${b.entity}/${b.filename}`),
  )) {
    const sidecar = path.join(textDir, row.entity, `${row.filename}.json`);
    const txt = path.join(textDir, row.entity, `${row.filename}.txt`);
    if (!existsSync(sidecar) || !existsSync(txt)) {
      throw new Error(`no extracted text for ${row.entity}/${row.filename}; run extract-text.mjs`);
    }
    const extraction = JSON.parse(await readFile(sidecar, 'utf8'));
    if (extraction.error) throw new Error(`extraction failed for ${row.entity}/${row.filename}`);
    const text = await readFile(txt, 'utf8');
    const rule = classify(row.entity, row.filename);
    documents.push({
      doc_id: row.doc_id,
      entity: row.entity,
      path: row.filename,
      title: documentTitle(row, text),
      classification: rule.classification,
      classification_rule:
        rule.match === '' ? '(default)' : `${rule.entity ? `${rule.entity}:` : ''}${rule.match}`,
      language: row.language,
      format: row.format,
      pages: extraction.pages,
      pdf_sha256: extraction.pdf_sha256,
      pdf_bytes: extraction.pdf_bytes,
      text_method: extraction.method,
      text_sha256: extraction.text_sha256,
      questions: [...new Set(row.questions)].sort(),
    });
  }
  for (const d of documents) d.readers = readersOf(d, people, askerKeysByQuestion);
  const docIds = new Set(documents.map((d) => d.doc_id));
  const recordDocs = new Set(
    [...JSON.stringify(RECORDS).matchAll(/DOC-[0-9a-f]{8}/g)].map((m) => m[0]),
  );
  const sample = selectSample(documents, recordDocs);
  const peopleKeys = new Set(people.map((p) => p.key));
  const titles = new Map(documents.map((d) => [d.doc_id, d.title.split(' — ')[0]]));
  const withTitles = (value) =>
    typeof value === 'string'
      ? value.replace(/@title:(DOC-[0-9a-f]+)/g, (_m, id) => {
          if (!titles.has(id)) throw new Error(`@title of unknown document ${id}`);
          return titles.get(id);
        })
      : Array.isArray(value)
        ? value.map(withTitles)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withTitles(v)]))
          : value;
  const recordKeys = new Set();
  const records = RECORDS.map((raw) => {
    const r = withTitles(raw);
    if (recordKeys.has(r.ref)) throw new Error(`duplicate record key ${r.ref}`);
    recordKeys.add(r.ref);
    if (!peopleKeys.has(r.actor)) throw new Error(`record ${r.ref}: unknown actor ${r.actor}`);
    if (ENTITIES[r.entity] === undefined) throw new Error(`record ${r.ref}: unknown entity`);
    if (RANK[r.classification] === undefined) throw new Error(`record ${r.ref}: classification`);
    const refs = [
      ...JSON.stringify(r).matchAll(/"@(doc|text|textversion|rec|person|org):([^"]+)"/g),
    ];
    for (const [, kind, key] of refs) {
      const known =
        kind === 'rec'
          ? recordKeys.has(key)
          : kind === 'person'
            ? peopleKeys.has(key)
            : kind === 'org'
              ? COUNTERPARTIES.some((c) => c.key === key)
              : docIds.has(key);
      if (!known) throw new Error(`record ${r.ref}: unresolved @${kind}:${key}`);
    }
    for (const e of r.evidence ?? []) {
      if (!docIds.has(e)) throw new Error(`record ${r.ref}: unknown evidence document ${e}`);
    }
    // The record's team reads it the way it reads documents of that area; its author always does.
    const team = readersOf(
      { entity: r.entity, path: r.area, classification: r.classification, questions: [] },
      people,
      askerKeysByQuestion,
    );
    const actor = people.find((p) => p.key === r.actor);
    const readers = new Set(team);
    if (RANK[r.classification] > RANK[actor.ceiling]) readers.add(r.actor);
    return { ...r, readers: [...readers].sort() };
  });
  const stats = {
    documents: documents.length,
    people: people.length,
    grants: documents.reduce((n, d) => n + d.readers.length, 0),
    by_classification: Object.fromEntries(
      Object.keys(RANK).map((c) => [c, documents.filter((d) => d.classification === c).length]),
    ),
  };
  return {
    'company.json': {
      legal_name: LEGAL_NAME,
      entities: ENTITIES,
      source: 'EDiTh — Enterprise Digital Twin Benchmark (Apache-2.0), fictional',
    },
    'people.json': people,
    'documents.json': documents,
    'records.json': { counterparties: COUNTERPARTIES, records },
    'sample.json': { size: sample.length, doc_ids: sample },
    'stats.json': stats,
  };
}

async function main() {
  const opts = args(process.argv.slice(2));
  const files = await build(opts);
  await mkdir(OUT, { recursive: true });
  let drift = 0;
  for (const [name, value] of Object.entries(files)) {
    const body = `${JSON.stringify(value, null, 2)}\n`;
    const target = path.join(OUT, name);
    if (opts.check) {
      const current = existsSync(target) ? await readFile(target, 'utf8') : '';
      if (current !== body) {
        console.error(`drift: ${name}`);
        drift += 1;
      }
    } else {
      await writeFile(target, body);
    }
  }
  if (opts.check && drift > 0) process.exitCode = 1;
  process.stdout.write(`${JSON.stringify(files['stats.json'])}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  });
}
