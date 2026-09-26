// Extract the text of a list of files into a text tree, resumably, with bounded parallelism;
// shared by the DRBench and TheAgentCompany extractors.
//
//   extractFiles(entries, { root, textRoot, jobs, previous })
//
// `entries` are `{ key, path }` with `path` relative to `root`. Each file gets its size and
// sha256; one KF cannot parse gets `<textRoot>/<path>.md` and `text: { file, method, sha256,
// chars }` (the file path relative to textRoot's parent). A file whose sha256 and extractor
// version match the `previous` manifest's entry is not extracted again.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mapLimit } from './kf.mjs';
import { extract, plan, sniffMediaType } from './extract-text.mjs';

export const EXTRACTOR_VERSION = 'kf-fixture-extract-1';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function extractFiles(entries, { root, textRoot, jobs = 6, previous = new Map() }) {
  const failures = [];
  let done = 0;
  const out = await mapLimit(entries, jobs, async (entry) => {
    const abs = path.join(root, entry.path);
    const bytes = await readFile(abs);
    const digest = sha256(bytes);
    const p = plan(abs);
    const row = {
      ...entry,
      format: p.ext,
      mediaType: sniffMediaType(bytes, p.mediaType),
      bytes: bytes.length,
      sha256: digest,
      text: null,
    };
    if (p.needsText) {
      const rel = `${entry.path}.md`;
      const target = path.join(textRoot, rel);
      const before = previous.get(entry.key);
      if (
        before?.sha256 === digest &&
        before?.text?.extractor === EXTRACTOR_VERSION &&
        existsSync(target)
      ) {
        row.text = before.text;
      } else {
        try {
          const { method, text } = await extract(abs);
          const body = Buffer.from(text.endsWith('\n') ? text : `${text}\n`, 'utf8');
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, body);
          row.text = {
            file: path.join(path.basename(textRoot), rel),
            method,
            sha256: sha256(body),
            chars: text.replace(/\s+/g, '').length,
            extractor: EXTRACTOR_VERSION,
          };
        } catch (error) {
          failures.push({ path: entry.path, error: String(error.message ?? error).slice(0, 300) });
        }
      }
    }
    done += 1;
    if (done % 100 === 0) process.stderr.write(`  ${done}/${entries.length}\n`);
    return row;
  });
  return { rows: out, failures };
}

/** Counts by a key function, sorted. */
export function countBy(rows, f) {
  const out = {};
  for (const r of rows) {
    const k = f(r);
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort());
}
