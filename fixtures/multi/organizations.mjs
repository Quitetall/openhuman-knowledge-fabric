// Every fixture organization of the multi-organization stack, as the isolation test and the web
// walk see it: who can sign in, what was loaded (in the --sample load), and what that content
// says — so a probe word can be chosen that one organization holds and no other does.
//
// Six organizations from four corpora: Véracier Industries (EDiTh; only when its corpus is on
// this machine, since its sample is not committed), Redwood Inference (EnterpriseRAG-Bench),
// The Agent Company (TheAgentCompany), and DRBench's Lee's Market, MediConn Solutions and
// Elexion Automotive.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { stackSettings } from '../lib/stack.mjs';

const run = promisify(execFile);
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function textOf(file) {
  if (/\.(md|txt|csv)$/i.test(file)) return readFile(file, 'utf8');
  if (/\.(docx|odt)$/i.test(file)) {
    const { stdout } = await run('pandoc', ['-t', 'plain', '--wrap=none', file], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  }
  return '';
}

/** What a loaded document says: its title and the text KF indexes for it. */
async function documentTexts(loadables) {
  const out = [];
  for (const d of loadables) {
    const source = d.derived?.file ?? d.file;
    out.push({ key: d.key, title: d.title, text: `${d.title}\n${await textOf(source)}` });
  }
  return out;
}

async function redwood() {
  const { fixture } = await import('../enterprise-rag-bench/fixture.mjs');
  const f = await fixture({ sample: true });
  return {
    id: f.corpus,
    personasCorpus: f.corpus,
    legalName: f.company.legal_name,
    people: f.people,
    strong: f.founder,
    documents: await documentTexts(f.documents),
  };
}

async function agentCompany() {
  const { fixture } = await import('../theagentcompany/fixture.mjs');
  const f = await fixture({ sample: true });
  return {
    id: f.corpus,
    personasCorpus: f.corpus,
    legalName: f.company.legal_name,
    people: f.people,
    strong: f.founder,
    documents: await documentTexts(f.documents),
  };
}

async function drbench() {
  const { SAMPLE_DIR, companiesIn, fixtureOf } = await import('../drbench/fixture.mjs');
  const out = [];
  for (const company of await companiesIn(SAMPLE_DIR)) {
    const f = fixtureOf(company, SAMPLE_DIR);
    out.push({
      id: f.corpus,
      personasCorpus: f.personasCorpus,
      legalName: f.company.legal_name,
      people: f.people,
      strong: f.founder,
      documents: await documentTexts(f.documents),
    });
  }
  return out;
}

async function veracier() {
  const corpus = process.env.KF_VERACIER_CORPUS ?? '/mnt/4tb/data/veracier';
  if (!existsSync(path.join(corpus, 'text', 'manifest.json'))) return [];
  const overlay = path.join(FIXTURES, 'veracier', 'overlay');
  const read = async (name) => JSON.parse(await readFile(path.join(overlay, name), 'utf8'));
  const people = await read('people.json');
  const sample = new Set((await read('sample.json')).doc_ids);
  const documents = [];
  for (const d of (await read('documents.json')).filter((x) => sample.has(x.doc_id))) {
    const text = await readFile(path.join(corpus, 'text', d.entity, `${d.path}.txt`), 'utf8');
    documents.push({ key: d.doc_id, title: d.title, text: `${d.title}\n${text}` });
  }
  // Its governed records are indexed too; their words count as this organization's.
  documents.push({
    key: 'records',
    title: '',
    text: await readFile(path.join(overlay, 'records.json'), 'utf8'),
  });
  return [
    {
      id: 'veracier',
      personasCorpus: 'veracier',
      legalName: (await read('company.json')).legal_name,
      people,
      strong: people.find((p) => p.persona === 'ceo').key,
      documents,
    },
  ];
}

/**
 * The organizations whose ids file the stack's state directory holds (i.e. that were loaded),
 * each with only the documents that load recorded (KF's content rules refuse a few).
 */
export async function organizations(settings = stackSettings()) {
  const all = [...(await veracier()), await redwood(), await agentCompany(), ...(await drbench())];
  const out = [];
  for (const o of all) {
    const file = path.join(settings.state, `${o.id}-ids.json`);
    if (!existsSync(file)) continue;
    const loaded = JSON.parse(await readFile(file, 'utf8')).documents ?? {};
    out.push({
      ...o,
      documents: o.documents.filter(
        (d) => d.key === 'records' || loaded[d.key]?.artifactId !== undefined,
      ),
    });
  }
  return out;
}

const fold = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * The stack's own English stemmer: the lexemes `to_tsvector('english', …)` makes of each text,
 * read on the owner connection (a pure function of the text; no record is touched).
 */
async function stemmer(settings) {
  const { createPool, withTransaction } = await import('@kf/database');
  process.env.PGPASSWORD ??= 'dev-only-not-a-secret';
  const pool = createPool({ connectionString: settings.ownerUrl, maxConnections: 1 });
  const lexemes = async (texts) => {
    const out = new Set();
    // A tsvector holds at most 1 MB; each document is cut into pieces well under it.
    const pieces = texts.flatMap((t) => t.match(/[\s\S]{1,200000}/g) ?? []);
    for (let i = 0; i < pieces.length; i += 50) {
      const rows = await withTransaction(pool, (tx) =>
        tx.query(
          `select distinct l.lexeme from unnest($1::text[]) as t(body),
                  unnest(to_tsvector('english', t.body)) as l`,
          [pieces.slice(i, i + 50)],
        ),
      );
      for (const r of rows) out.add(r.lexeme);
    }
    return out;
  };
  const stems = async (words) => {
    const rows = await withTransaction(pool, (tx) =>
      tx.query(
        `select w.word, coalesce(array_agg(l.lexeme) filter (where l.lexeme is not null), '{}') as stems
           from unnest($1::text[]) as w(word)
           left join lateral unnest(to_tsvector('english', w.word)) as l on true
          group by w.word`,
        [words],
      ),
    );
    return new Map(rows.map((r) => [r.word, r.stems]));
  };
  return { lexemes, stems, end: () => pool.end() };
}

/**
 * For every organization, words only it says — as the search engine sees words: a candidate (a
 * word of seven letters or more from its documents' titles, then their text) is kept when its
 * English stems are among the organization's own lexemes and among no other organization's, and
 * when no other organization's titles or people's names contain it (search also matches titles
 * by substring). Deterministic: documents in load order, first `count`.
 */
export async function probeTable(orgs, { settings = stackSettings(), count = 3 } = {}) {
  const pg = await stemmer(settings);
  try {
    const own = new Map();
    for (const o of orgs)
      own.set(
        o.id,
        await pg.lexemes([...o.documents.map((d) => d.text), ...o.people.map((p) => p.name)]),
      );
    const table = new Map();
    for (const o of orgs) {
      const others = orgs.filter((x) => x !== o);
      const elsewhere = new Set(others.flatMap((x) => [...own.get(x.id)]));
      const titles = fold(
        others
          .flatMap((x) => [...x.documents.map((d) => d.title), ...x.people.map((p) => p.name)])
          .join('\n'),
      );
      const candidates = [];
      for (const source of [(d) => d.title, (d) => d.text])
        for (const d of o.documents)
          for (const w of fold(source(d)).split(/[^a-z]+/))
            if (w.length >= 7 && !candidates.includes(w)) candidates.push(w);
      const stems = await pg.stems(candidates.slice(0, 4000));
      const words = [];
      for (const w of candidates.slice(0, 4000)) {
        const s = stems.get(w) ?? [];
        if (s.length === 0 || titles.includes(w)) continue;
        if (!s.every((x) => own.get(o.id).has(x)) || s.some((x) => elsewhere.has(x))) continue;
        words.push(w);
        if (words.length === count) break;
      }
      table.set(o.id, words);
    }
    return table;
  } finally {
    await pg.end();
  }
}
