// Search-quality baseline, shared by every corpus that brings questions: each question asked
// through KF's own `GET /search` as a person of the corpus's organization, recall@k scored over
// the documents returned (an original and its extracted text are one document, found by either).
//
// Two query forms, applied to every question the same way and tuned on none:
//   verbatim   the question as written: what a person typing a sentence gets
//   keywords   the question's content words joined with `or` (keywordQuery, the Véracier
//              baseline's function: stopwords of fr/en/de/es/it removed, deduplicated, in order),
//              cut to the API's 512-character limit at the last whole term (fit). Since
//              20260926100000 lexical search does not need every word and `or` is a word of no
//              weight, so the forms differ only in which words reach the query.
//
// Three lists are scored with the same truth and cut-off: `lexical`, `semantic` (present when the
// API runs with KF_RETRIEVAL_SOCKET) and `fused` — `ranked`, the one list the API serves first and
// the web application shows first (reciprocal rank fusion of the other two).
//
// `previous` (a committed `search-baseline.<date>.json` holding an earlier run's summary) is
// printed beside this run's numbers, so a report keeps the numbers it replaced.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { keywordQuery } from '../veracier/search-baseline.mjs';

export { keywordQuery };

/** The API's limit on `q` (SEARCH_QUERY_MAX_LENGTH). */
const MAX_QUERY = 512;

/**
 * A keyword query longer than the API accepts keeps its first terms: a task statement of a
 * hundred content words is cut, in order, at the last whole term that fits.
 */
export function fit(query) {
  if (query.length <= MAX_QUERY) return query;
  const terms = query.split(' or ');
  while (terms.length > 1 && terms.join(' or ').length > MAX_QUERY) terms.pop();
  return terms.join(' or ');
}

const round = (x) => (x === null ? null : Number(x.toFixed(4)));
const mean = (values) => {
  const v = values.filter((x) => typeof x === 'number');
  return v.length === 0 ? null : round(v.reduce((a, b) => a + b, 0) / v.length);
};

/**
 * questions: [{ id, type, asker, question, truth: [docKey], readable: number }]
 * sessionOf(askerKey) → PersonaSession; docOf(objectId) → docKey | undefined
 */
export async function scoreQuestions(questions, { sessionOf, docOf, k = 10 }) {
  const results = [];
  for (const q of questions) {
    const row = {
      id: q.id,
      type: q.type,
      asker: q.asker,
      truth: q.truth.length,
      readable: q.readable,
    };
    const variants = {
      verbatim: q.question.slice(0, MAX_QUERY),
      keywords: fit(keywordQuery(q.question)),
    };
    for (const [variant, query] of Object.entries(variants)) {
      if (query.trim() === '') continue;
      const res = await sessionOf(q.asker).request(
        'GET',
        `/search?q=${encodeURIComponent(query)}&limit=200`,
      );
      row[`${variant}_lexical_total`] = res.body.lexical?.total ?? 0;
      row[`${variant}_withheld`] = res.body.withheldCount ?? 0;
      row.fused_ranking ??= res.body.ranked?.ranking;
      for (const [list, hits] of [
        ['lexical', res.body.lexical?.hits ?? []],
        ['semantic', res.body.semantic?.hits ?? null],
        ['fused', res.body.ranked?.hits ?? null],
      ]) {
        if (hits === null) continue;
        const top = [];
        const topTitles = [];
        for (const hit of hits) {
          const doc = docOf(hit.objectId);
          if (doc !== undefined && !top.includes(doc)) {
            top.push(doc);
            topTitles.push(hit.title ?? hit.displayName ?? '');
          }
          if (top.length === k) break;
        }
        const found = q.truth.filter((id) => top.includes(id)).length;
        row[`${variant}_${list}_hits@${k}`] = found;
        row[`${variant}_${list}_recall@${k}`] =
          q.truth.length === 0 ? null : round(found / q.truth.length);
        row[`${variant}_${list}_returned`] = top.length;
        if (q.truth.length === 0) row[`${variant}_${list}_top3`] = topTitles.slice(0, 3);
      }
    }
    results.push(row);
    process.stderr.write(`${q.id} done\n`);
  }
  return results;
}

export function summarize(results, k = 10) {
  const lists = ['lexical', 'semantic', 'fused'].filter((l) =>
    results.some((r) => `verbatim_${l}_recall@${k}` in r || `keywords_${l}_recall@${k}` in r),
  );
  const ceiling = mean(
    results.filter((r) => r.truth > 0).map((r) => Math.min(k, r.truth) / r.truth),
  );
  const overall = { questions: results.length, ceiling };
  for (const l of lists)
    for (const v of ['verbatim', 'keywords'])
      overall[`${v}_${l}`] = mean(results.map((r) => r[`${v}_${l}_recall@${k}`]));
  const types = [...new Set(results.map((r) => r.type))].sort();
  const byType = types.map((type) => {
    const rs = results.filter((r) => r.type === type);
    const row = { type, questions: rs.length };
    for (const l of lists)
      for (const v of ['verbatim', 'keywords'])
        row[`${v}_${l}`] = mean(rs.map((r) => r[`${v}_${l}_recall@${k}`]));
    return row;
  });
  return {
    k,
    lists,
    overall,
    byType,
    semantic: lists.includes('semantic') ? 'present' : 'not configured',
    fusedRanking: results.find((r) => r.fused_ranking !== undefined)?.fused_ranking ?? null,
  };
}

const cell = (v) =>
  v === null || v === undefined ? '—' : Array.isArray(v) ? v.join('; ') : String(v);
const table = (header, rows) => [
  `| ${header.join(' | ')} |`,
  `| ${header.map(() => '---').join(' | ')} |`,
  ...rows.map((r) => `| ${r.map((c) => cell(c).replace(/\|/g, '\\|')).join(' | ')} |`),
];

/** An earlier run's summary, as committed beside the report (`search-baseline.<date>.json`). */
export async function readPrevious(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/**
 * This run's means beside earlier runs' that scored the same three lists, one row each, so a change
 * to the fused ranking is read against the numbers it replaced. `earlier` holds committed summaries
 * (`search-baseline.<date>.json`, with `date`, `commit` and `note`).
 */
function earlierRuns(summary, earlier) {
  if (earlier.length === 0) return [];
  const lists = ['lexical', 'semantic', 'fused'];
  const row = (label, ranking, overall) => [
    label,
    ranking ?? '—',
    ...lists.flatMap((l) => [overall?.[`verbatim_${l}`], overall?.[`keywords_${l}`]]),
  ];
  return [
    '## This run beside earlier runs of the same lists',
    '',
    ...table(
      ['run', 'fused ranking', ...lists.flatMap((l) => [`verbatim ${l}`, `keywords ${l}`])],
      [
        row('this run', summary.fusedRanking, summary.overall),
        ...earlier.map((run) =>
          row(`${run.date} (${run.commit})`, run.summary.fusedRanking, run.summary.overall),
        ),
      ],
    ),
    '',
    ...earlier.flatMap((run) => (run.note === undefined ? [] : [`${run.date}: ${run.note}`, ''])),
  ];
}

/** Writes `<out>/search-baseline.{md,json}`. */
export async function writeReport(
  out,
  { title, intro, results, summary, extra = [], previous = undefined, earlier = [] },
) {
  const k = summary.k;
  await mkdir(out, { recursive: true });
  await writeFile(
    path.join(out, 'search-baseline.json'),
    `${JSON.stringify({ summary, results }, null, 2)}\n`,
  );
  const columns = summary.lists.flatMap((l) => [`verbatim ${l}`, `keywords ${l}`]);
  const values = (row) =>
    summary.lists.flatMap((l) => [row[`verbatim_${l}`], row[`keywords_${l}`]]);
  const before = previous?.summary;
  const beforeLists = before?.lists ?? [];
  const beforeColumns = beforeLists.flatMap((l) => [
    `before: verbatim ${l}`,
    `before: keywords ${l}`,
  ]);
  const beforeValues = (row) =>
    row === undefined
      ? beforeLists.flatMap(() => [undefined, undefined])
      : beforeLists.flatMap((l) => [row[`verbatim_${l}`], row[`keywords_${l}`]]);
  const beforeType = (type) => before?.byType?.find((t) => t.type === type);
  const lines = [
    `# ${title}`,
    '',
    ...intro,
    '',
    `- questions: ${summary.overall.questions}; cut-off: ${k} documents; semantic ranking: ${summary.semantic}`,
    `- ceiling on mean recall@${k} (min(${k}, |truth|)/|truth|): ${cell(summary.overall.ceiling)}`,
    ...(summary.fusedRanking === null ? [] : [`- fused ranking: \`${summary.fusedRanking}\``]),
    ...(before === undefined
      ? []
      : [
          `- before: the run of ${previous.date} (${previous.commit}), whose summary is committed as`,
          `  \`search-baseline.${previous.date}.json\`: every word required as written, English stemming`,
          '  for every language, lexical and semantic served as two lists.',
        ]),
    '',
    `## Mean recall@${k}`,
    '',
    ...table(
      ['questions', ...columns, ...beforeColumns],
      [[summary.overall.questions, ...values(summary.overall), ...beforeValues(before?.overall)]],
    ),
    '',
    ...earlierRuns(summary, earlier),
    '## By question type',
    '',
    ...table(
      ['type', 'questions', ...columns, ...beforeColumns],
      summary.byType.map((t) => [
        t.type,
        t.questions,
        ...values(t),
        ...beforeValues(beforeType(t.type)),
      ]),
    ),
    '',
    ...extra,
    '## Per question',
    '',
    ...table(
      [
        'question',
        'type',
        'asker',
        'truth',
        'readable by asker',
        `verbatim hits@${k}`,
        'verbatim recall',
        'verbatim matches',
        `keywords hits@${k}`,
        'keywords recall',
        ...(summary.lists.includes('fused')
          ? ['verbatim fused recall', 'keywords fused recall']
          : []),
        'withheld (keywords)',
      ],
      results.map((r) => [
        r.id,
        r.type,
        r.asker,
        r.truth,
        r.readable,
        r[`verbatim_lexical_hits@${k}`],
        r[`verbatim_lexical_recall@${k}`],
        r.verbatim_lexical_total,
        r[`keywords_lexical_hits@${k}`],
        r[`keywords_lexical_recall@${k}`],
        ...(summary.lists.includes('fused')
          ? [r[`verbatim_fused_recall@${k}`], r[`keywords_fused_recall@${k}`]]
          : []),
        r.keywords_withheld,
      ]),
    ),
    '',
  ];
  await writeFile(path.join(out, 'search-baseline.md'), lines.join('\n'));
}
