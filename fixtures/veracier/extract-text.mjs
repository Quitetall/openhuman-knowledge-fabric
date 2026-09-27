#!/usr/bin/env node
// Véracier corpus text extraction (fixture tooling; not part of any runtime).
//
//   node fixtures/veracier/extract-text.mjs [--corpus /mnt/4tb/data/veracier] [--out <dir>]
//        [--jobs 6] [--only <doc_id,...>]
//
// Reads MASTER_INDEX.csv, and for every distinct PDF writes <out>/<entity>/<filename>.txt plus a
// per-document sidecar <…>.json, then an aggregate <out>/manifest.json sorted by doc path.
//
// Method per document, from the index's `format` column, checked against the bytes:
//   searchable → `pdftotext -layout`. If a page yields fewer than MIN_PAGE_CHARS visible
//                characters it is OCR'd instead (recorded as `searchable+ocr`).
//   scanned    → every page rendered with `pdftoppm -r 300 -gray` and OCR'd by tesseract.
//   mixed      → per page: text layer when it has MIN_PAGE_CHARS, otherwise OCR.
// OCR languages are the document's `language` column (fr/en → fra+eng). Pages are joined with a
// form feed, as pdftotext does, so page boundaries survive.
//
// Deterministic: tesseract runs single-threaded (OMP_THREAD_LIMIT=1) with fixed flags and the
// tessdata named by TESSDATA_PREFIX, so the same inputs give the same bytes. Resumable: a
// sidecar whose pdf_sha256 and extractor version match is kept and the document is skipped.
// A failure is recorded in the sidecar (`error`) and does not stop the run; the exit code is
// 1 when any document failed.
//
// What this does not do: judge OCR quality. `chars` and `ocr_pages` are recorded so a reader
// can see which documents are thin, but a page of confident nonsense passes as text.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCsv } from './lib/csv.mjs';

const EXTRACTOR_VERSION = 'veracier-extract/1';
const MIN_PAGE_CHARS = 40;
const LANG = { fr: 'fra', en: 'eng', de: 'deu', it: 'ita', es: 'spa' };

function args(argv) {
  const out = {
    corpus: '/mnt/4tb/data/veracier',
    out: '',
    jobs: 6,
    only: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      return next;
    };
    if (a === '--corpus') out.corpus = v();
    else if (a === '--out') out.out = v();
    else if (a === '--jobs') out.jobs = Number(v());
    else if (a === '--only') out.only = new Set(v().split(','));
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.out) out.out = path.join(out.corpus, 'text');
  if (!Number.isInteger(out.jobs) || out.jobs < 1 || out.jobs > 8) {
    throw new Error('--jobs must be 1..8 (the workstation is shared)');
  }
  return out;
}

function run(cmd, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, {
      env: { ...process.env, OMP_THREAD_LIMIT: '1', ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else
        reject(
          new Error(
            `${cmd} exited ${code}: ${Buffer.concat(err).toString('utf8').trim().slice(0, 300)}`,
          ),
        );
    });
  });
}

const visible = (s) => s.replace(/\s+/g, '').length;

function tessLangs(language) {
  const codes = language
    .split('/')
    .map((l) => LANG[l.trim()])
    .filter(Boolean);
  if (codes.length === 0) throw new Error(`no tesseract language for '${language}'`);
  return [...new Set(codes)].join('+');
}

async function pageCount(pdf) {
  const info = (await run('pdfinfo', [pdf])).toString('utf8');
  const m = /^Pages:\s+(\d+)/m.exec(info);
  if (!m) throw new Error('pdfinfo reported no page count');
  return Number(m[1]);
}

async function textLayer(pdf, page) {
  const buf = await run('pdftotext', [
    '-layout',
    '-enc',
    'UTF-8',
    '-f',
    `${page}`,
    '-l',
    `${page}`,
    pdf,
    '-',
  ]);
  return buf.toString('utf8').replace(/\f+$/, '');
}

async function ocrPage(pdf, page, langs, work, tessdata) {
  const stem = path.join(work, `p${page}`);
  await run('pdftoppm', [
    '-r',
    '300',
    '-gray',
    '-png',
    '-singlefile',
    '-f',
    `${page}`,
    '-l',
    `${page}`,
    pdf,
    stem,
  ]);
  const buf = await run(
    'tesseract',
    [`${stem}.png`, 'stdout', '-l', langs, '--psm', '3', '--oem', '1'],
    {
      env: { TESSDATA_PREFIX: tessdata },
    },
  );
  await rm(`${stem}.png`, { force: true });
  return buf.toString('utf8').replace(/\f+$/, '');
}

async function extractOne(doc, opts) {
  const pdf = path.join(opts.corpus, 'by_entity', doc.entity, doc.filename);
  const outTxt = path.join(opts.out, doc.entity, `${doc.filename}.txt`);
  const outJson = path.join(opts.out, doc.entity, `${doc.filename}.json`);
  const bytes = await readFile(pdf);
  const pdfSha = createHash('sha256').update(bytes).digest('hex');
  if (existsSync(outJson) && existsSync(outTxt)) {
    const prior = JSON.parse(await readFile(outJson, 'utf8'));
    if (prior.pdf_sha256 === pdfSha && prior.extractor === EXTRACTOR_VERSION && !prior.error) {
      return { ...prior, skipped: true };
    }
  }
  const langs = tessLangs(doc.language);
  const tessdata = process.env.TESSDATA_PREFIX ?? '/mnt/4tb/data/tessdata';
  const work = await mkdtemp(path.join(tmpdir(), 'veracier-ocr-'));
  const record = {
    doc_id: doc.doc_id,
    entity: doc.entity,
    filename: doc.filename,
    format: doc.format,
    language: doc.language,
    extractor: EXTRACTOR_VERSION,
    pdf_sha256: pdfSha,
    pdf_bytes: bytes.length,
  };
  try {
    const pages = await pageCount(pdf);
    const texts = [];
    let ocrPages = 0;
    for (let p = 1; p <= pages; p += 1) {
      let text = doc.format === 'scanned' ? '' : await textLayer(pdf, p);
      if (visible(text) < MIN_PAGE_CHARS) {
        text = await ocrPage(pdf, p, langs, work, tessdata);
        ocrPages += 1;
      }
      texts.push(text);
    }
    const method =
      ocrPages === 0
        ? 'pdftotext'
        : ocrPages === pages
          ? 'ocr'
          : doc.format === 'searchable'
            ? 'searchable+ocr'
            : 'mixed';
    const body = `${texts.join('\f')}\n`;
    const textSha = createHash('sha256').update(body).digest('hex');
    Object.assign(record, {
      method,
      pages,
      ocr_pages: ocrPages,
      ocr_languages: ocrPages > 0 ? langs : null,
      chars: body.length,
      text_sha256: textSha,
    });
    await mkdir(path.dirname(outTxt), { recursive: true });
    await writeFile(`${outTxt}.tmp`, body);
    await rename(`${outTxt}.tmp`, outTxt);
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  await mkdir(path.dirname(outJson), { recursive: true });
  await writeFile(outJson, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

async function main() {
  const opts = args(process.argv.slice(2));
  const rows = parseCsv(await readFile(path.join(opts.corpus, 'MASTER_INDEX.csv'), 'utf8'));
  const byPath = new Map();
  for (const row of rows) {
    const key = `${row.entity}/${row.filename}`;
    if (!byPath.has(key)) byPath.set(key, row);
  }
  let docs = [...byPath.values()].sort((a, b) =>
    `${a.entity}/${a.filename}`.localeCompare(`${b.entity}/${b.filename}`),
  );
  if (opts.only) docs = docs.filter((d) => opts.only.has(d.doc_id));
  const results = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < docs.length) {
      const doc = docs[next];
      next += 1;
      const r = await extractOne(doc, opts);
      results.push(r);
      done += 1;
      if (r.error) console.error(`FAIL ${doc.entity}/${doc.filename}: ${r.error}`);
      if (done % 25 === 0 || done === docs.length) console.error(`${done}/${docs.length}`);
    }
  };
  await Promise.all(Array.from({ length: opts.jobs }, worker));
  results.sort((a, b) => `${a.entity}/${a.filename}`.localeCompare(`${b.entity}/${b.filename}`));
  if (!opts.only) {
    const manifest = results.map(({ skipped: _skipped, ...r }) => r);
    const counts = {};
    for (const r of manifest)
      counts[r.error ? 'error' : r.method] = (counts[r.error ? 'error' : r.method] ?? 0) + 1;
    await writeFile(
      path.join(opts.out, 'manifest.json'),
      `${JSON.stringify({ extractor: EXTRACTOR_VERSION, documents: manifest.length, counts, entries: manifest }, null, 2)}\n`,
    );
    process.stdout.write(`${JSON.stringify(counts)}\n`);
  }
  const failed = results.filter((r) => r.error).length;
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
});
