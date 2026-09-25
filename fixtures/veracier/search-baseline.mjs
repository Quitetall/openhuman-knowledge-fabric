#!/usr/bin/env node
// Search-quality baseline over the Véracier fixture: the benchmark's executive questions, run
// through KF's own search as the person who asks each one.
//
//   node fixtures/veracier/search-baseline.mjs [--corpus /mnt/4tb/data/veracier]
//        [--out fixtures/veracier/reports]
//
// Needs the full fixture loaded (`pnpm fixture:veracier`). For every question in ANSWER_KEY.json
// it signs in as the asker (their own Keycloak account, their own context), calls `GET /search`
// exactly as the web application does, and scores the first ten DOCUMENTS returned: a PDF and its
// extracted text are one document, found by either. Two query forms, both applied to every
// question the same way and neither tuned on the answers:
//
//   verbatim   the question as the executive wrote it. KF's lexical search ANDs every term
//              (websearch_to_tsquery), so this measures what a person typing a sentence gets.
//   keywords   the question's content words (stopwords of fr/en/de/es/it removed, deduplicated,
//              in order) joined with `or`, the websearch operator KF already supports.
//
// Ground truth, per question: the files ANSWER_KEY.json lists when it lists any (its `trap`
// entries excluded); otherwise the index rows for that question whose label is not a negative
// one (NEGATIVE_LABELS below — distractors, near-misses and "reference" background). The report
// states, per question, how many of those the asker may read at all: a document they are not
// granted is withheld from them by design, and recall over it measures access control, not search.
//
// The seam for semantic ranking (LAMU): `GET /search` already returns a `semantic` list when the
// API is started with KF_RETRIEVAL_SOCKET. This script scores `lexical.hits` as `lexical` and,
// when present, `semantic.hits` as `semantic`, with the same ground truth and the same cut-off, so
// a later run with the engine attached adds a column rather than a new method.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './lib/csv.mjs';
import { PersonaSession } from './lib/kf.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const K = 10;

/** Labels that mark a row as NOT an answer to its question. */
export const NEGATIVE_LABELS = new Set([
  'NOT_RELEVANT',
  'NOISE',
  'NO',
  'NOT_EXPIRING',
  'NOT_AT_RISK',
  'NO_CLASSIFIED',
  'NOT_AEROSPACE',
  'NO_SUPPORT',
  'NO_MATCH',
  'WRONG_VERSION',
  'REFERENCE',
]);

const STOPWORDS = new Set(
  // fr
  (
    'a au aux avec ce ces cette dans de des du elle en est et il ils je la le les leur lui ' +
    'mais me mes mon ne nos notre nous on ou par pas pour qu que quel quelle quels quelles qui ' +
    'sa se ses son sont sur ta te tes ton tu un une vos votre vous y ont sommes etre faut il ' +
    'doit peut sont quelles-sont est-ce ete avons avez sous entre depuis sans tout tous toute ' +
    // en
    'the a an and or of to in on for with by from at as is are was were be been being this ' +
    'that these those which what who whom whose how why when where do does did have has had ' +
    'not no our we i you your their they it its any all can could should would will shall ' +
    'need there here than then them into over under about per haven hasn ' +
    // de
    'der die das und oder ein eine einer eines dem den des zu im in mit von fur für ist sind ' +
    'nicht auf bei wie was wer wo sich es wir sie ihr unsere bereit ' +
    // es / it
    'el los las y o un una del al con para por es son que il lo gli e di da che per non sono'
  ).split(/\s+/),
);

export function keywordQuery(question) {
  const words = question
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, ' ')
    .split(/[^a-z0-9-]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w) && !/^-+$/.test(w));
  return [...new Set(words)].join(' or ');
}

function walk(value, out) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) walk(v, out);
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) if (k !== 'trap') walk(v, out);
  }
  return out;
}

/** Ground-truth document ids for one question. */
export function groundTruth(question, spec, rows, docIdByPath, docIdsByBase) {
  const listed = walk(spec.ground_truth ?? {}, []);
  if (listed.length > 0) {
    const ids = new Set();
    for (const entry of listed) {
      const base = entry.split('/').pop();
      const byPath = [...docIdByPath].filter(([p]) => p.endsWith(`/${entry}`)).map(([, id]) => id);
      for (const id of byPath.length > 0 ? byPath : (docIdsByBase.get(base) ?? [])) ids.add(id);
    }
    return { source: 'answer key', ids: [...ids].sort() };
  }
  // A file that answers several questions has one index row per question, each with its own
  // doc_id; the fixture knows the file by the first. So a row is resolved through its path.
  const ids = rows
    .filter((r) => r.question_id === question && !NEGATIVE_LABELS.has(r.classification))
    .map((r) => docIdByPath.get(`${r.entity}/${r.filename}`) ?? r.doc_id);
  return { source: 'index labels', ids: [...new Set(ids)].sort() };
}

function parseArgs(argv) {
  const out = {
    corpus: process.env.KF_VERACIER_CORPUS ?? '/mnt/4tb/data/veracier',
    out: path.join(HERE, 'reports'),
    state: process.env.KF_VERACIER_STATE ?? path.join(homedir(), '.local', 'state', 'kf-veracier'),
    personas:
      process.env.KF_VERACIER_PERSONAS ??
      path.join(homedir(), '.config', 'kf', 'veracier-personas.txt'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--corpus') out.corpus = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return out;
}

const RANK = { public: 0, internal: 1, confidential: 2, restricted: 3 };

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const overlay = path.join(HERE, 'overlay');
  const people = JSON.parse(await readFile(path.join(overlay, 'people.json'), 'utf8'));
  const documents = JSON.parse(await readFile(path.join(overlay, 'documents.json'), 'utf8'));
  const ids = JSON.parse(await readFile(path.join(opts.state, 'veracier-ids.json'), 'utf8'));
  const answers = JSON.parse(await readFile(path.join(opts.corpus, 'ANSWER_KEY.json'), 'utf8'));
  const rows = parseCsv(await readFile(path.join(opts.corpus, 'MASTER_INDEX.csv'), 'utf8'));
  const passwords = new Map(
    (await readFile(opts.personas, 'utf8'))
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('#'))
      .map((l) => l.split('\t').slice(0, 2)),
  );

  const docIdByPath = new Map(documents.map((d) => [`${d.entity}/${d.path}`, d.doc_id]));
  const docIdsByBase = new Map();
  for (const d of documents) {
    const base = d.path.split('/').pop();
    docIdsByBase.set(base, [...(docIdsByBase.get(base) ?? []), d.doc_id]);
  }
  const docOfArtifact = new Map();
  for (const [docId, entry] of Object.entries(ids.documents)) {
    if (entry.artifactId) docOfArtifact.set(entry.artifactId, docId);
    if (entry.textArtifactId) docOfArtifact.set(entry.textArtifactId, docId);
  }
  const byDoc = new Map(documents.map((d) => [d.doc_id, d]));
  const oidc = {
    issuer: `${process.env.KF_VERACIER_KEYCLOAK ?? 'http://localhost:18080'}/realms/knowledge-fabric`,
    clientId: 'knowledge-fabric-web',
    redirectUri: `http://localhost:${process.env.KF_VERACIER_WEB_PORT ?? '3100'}/auth/callback`,
  };
  const apiOrigin = `http://127.0.0.1:${process.env.KF_VERACIER_API_PORT ?? '4100'}`;
  const sessions = new Map();
  const sessionOf = (person) => {
    if (!sessions.has(person.key)) {
      sessions.set(
        person.key,
        new PersonaSession({
          oidc,
          apiOrigin,
          person,
          password: passwords.get(person.username),
          organizationId: ids.organizationId,
          assignmentId: ids.people[person.key].assignmentId,
        }),
      );
    }
    return sessions.get(person.key);
  };
  const mayRead = (person, doc) =>
    RANK[doc.classification] <= RANK[person.clearance] &&
    (RANK[doc.classification] <= RANK[person.ceiling] || doc.readers.includes(person.key));

  const results = [];
  for (const [question, spec] of Object.entries(answers)) {
    const asker = people.find((p) => p.asker === spec.asker);
    const truth = groundTruth(question, spec, rows, docIdByPath, docIdsByBase);
    const readable = truth.ids.filter((id) => byDoc.has(id) && mayRead(asker, byDoc.get(id)));
    const variants = {
      verbatim: spec.question.slice(0, 512),
      keywords: keywordQuery(spec.question),
    };
    const row = {
      question,
      asker: asker.name,
      asker_key: asker.key,
      truth_source: truth.source,
      truth: truth.ids.length,
      readable: readable.length,
    };
    for (const [variant, q] of Object.entries(variants)) {
      const res = await sessionOf(asker).request(
        'GET',
        `/search?q=${encodeURIComponent(q)}&limit=200`,
      );
      for (const [list, hits] of [
        ['lexical', res.body.lexical?.hits ?? []],
        ['semantic', res.body.semantic?.hits ?? null],
      ]) {
        if (hits === null) continue;
        const top = [];
        for (const hit of hits) {
          const doc = docOfArtifact.get(hit.objectId);
          if (doc !== undefined && !top.includes(doc)) top.push(doc);
          if (top.length === K) break;
        }
        const found = truth.ids.filter((id) => top.includes(id)).length;
        row[`${variant}_${list}_hits@${K}`] = found;
        row[`${variant}_${list}_recall@${K}`] =
          truth.ids.length === 0 ? null : Number((found / truth.ids.length).toFixed(4));
        row[`${variant}_${list}_total`] = res.body.lexical?.total ?? hits.length;
      }
      row[`${variant}_withheld`] = res.body.withheldCount;
    }
    results.push(row);
    process.stderr.write(`${question} done\n`);
  }

  const mean = (key) => {
    const values = results.map((r) => r[key]).filter((v) => typeof v === 'number');
    return values.length === 0
      ? null
      : Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(4));
  };
  const summary = {
    k: K,
    questions: results.length,
    documents: documents.length,
    mean_verbatim_lexical_recall: mean(`verbatim_lexical_recall@${K}`),
    mean_keywords_lexical_recall: mean(`keywords_lexical_recall@${K}`),
    mean_keywords_lexical_recall_upper_bound: Number(
      (
        results.reduce((a, r) => a + (r.truth === 0 ? 0 : Math.min(K, r.truth) / r.truth), 0) /
        results.filter((r) => r.truth > 0).length
      ).toFixed(4),
    ),
    semantic: results.some((r) => `verbatim_semantic_recall@${K}` in r)
      ? 'present'
      : 'not configured',
  };
  await mkdir(opts.out, { recursive: true });
  await writeFile(
    path.join(opts.out, 'search-baseline.json'),
    `${JSON.stringify({ summary, results }, null, 2)}\n`,
  );
  const lines = [
    '# Véracier search baseline — recall@10, lexical',
    '',
    'Generated by `node fixtures/veracier/search-baseline.mjs` against the full fixture (every',
    'question asked through `GET /search` as its asker). Do not edit by hand; re-run it.',
    '',
    `- questions: ${summary.questions}; documents: ${summary.documents}; cut-off: ${K} documents`,
    `- mean recall@${K}, verbatim question: **${summary.mean_verbatim_lexical_recall}**`,
    `- mean recall@${K}, keyword query (\`or\`): **${summary.mean_keywords_lexical_recall}**`,
    `- ceiling on mean recall@${K} (min(10, |truth|)/|truth|): ${summary.mean_keywords_lexical_recall_upper_bound}`,
    `- semantic ranking: ${summary.semantic}`,
    '',
    `| question | asker | truth (source) | readable by asker | verbatim hits@${K} | verbatim recall | keywords hits@${K} | keywords recall | withheld (keywords) |`,
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...results.map((r) =>
      [
        r.question,
        r.asker,
        `${r.truth} (${r.truth_source})`,
        r.readable,
        r[`verbatim_lexical_hits@${K}`],
        r[`verbatim_lexical_recall@${K}`],
        r[`keywords_lexical_hits@${K}`],
        r[`keywords_lexical_recall@${K}`],
        r.keywords_withheld,
      ]
        .map((v) => (v === null || v === undefined ? '—' : String(v)))
        .join(' | ')
        .replace(/^/, '| ')
        .concat(' |'),
    ),
    '',
  ];
  await writeFile(path.join(opts.out, 'search-baseline.md'), lines.join('\n'));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
