// Text for the files KF's parser cannot read itself, shared by the DRBench and TheAgentCompany
// extractors.
//
// KF parses DOCX, ODT, Markdown and plain text (pandoc, packages/documents). Everything else a
// fixture loads is ingested as itself — the record — followed by a derived text artifact that
// names it (`derived_from`), and it is the text KF indexes. Methods, deterministic and local:
//
//   pdf              pdftotext -layout; a document whose text layer has fewer than 40 visible
//                    characters per page is OCR'd instead (pdftoppm 300 dpi + tesseract eng)
//   xlsx, pptx, csv  pandoc -t gfm (pandoc 3 reads all three; an xlsx pandoc cannot open is
//                    re-saved by LibreOffice first)
//   ods, odp         LibreOffice headless → xlsx / pptx, then pandoc
//   png, jpg, jpeg   tesseract eng (ImageMagick-normalized first when tesseract cannot open it)
//   jsonl            DRBench's mail and chat exports, rendered as one message per section
//
// `plan(file)` says what a file is and whether it needs extraction; `extract(file)` returns
// `{ method, text }`. Nothing here writes outside the directory it is given.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const BUFFER = 256 * 1024 * 1024;

export const MEDIA_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  csv: 'text/csv',
  md: 'text/markdown',
  txt: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jsonl: 'application/x-ndjson',
};

/** Formats KF's own parser reads: ingested once, no derived text. */
export const PARSED_BY_KF = new Set(['docx', 'odt', 'md', 'txt']);

export function extensionOf(file) {
  return path.extname(file).slice(1).toLowerCase();
}

export function plan(file) {
  const ext = extensionOf(file);
  const mediaType = MEDIA_TYPES[ext];
  if (mediaType === undefined) return { supported: false, ext };
  return { supported: true, ext, mediaType, needsText: !PARSED_BY_KF.has(ext) };
}

async function pandoc(from, file) {
  const { stdout } = await run('pandoc', ['-f', from, '-t', 'gfm', '--wrap=none', file], {
    maxBuffer: BUFFER,
  });
  return stdout;
}

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kf-fixture-extract-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function libreoffice(file, to) {
  return withTemp(async (dir) => {
    // Its own profile directory, so a LibreOffice the person has open is never touched.
    await run(
      'soffice',
      [
        `-env:UserInstallation=file://${dir}/profile`,
        '--headless',
        '--convert-to',
        to,
        '--outdir',
        dir,
        file,
      ],
      { maxBuffer: BUFFER, timeout: 120_000 },
    );
    const converted = (await readdir(dir)).find((f) => f.endsWith(`.${to}`));
    if (converted === undefined) throw new Error(`LibreOffice did not convert ${file} to ${to}`);
    return pandoc(to, path.join(dir, converted));
  });
}

async function tesseract(image) {
  const { stdout } = await run('tesseract', [image, '-', '-l', 'eng', '--psm', '3'], {
    maxBuffer: BUFFER,
    env: { ...process.env, OMP_THREAD_LIMIT: '1' },
  });
  return stdout;
}

/**
 * An image tesseract cannot open (TheAgentCompany has an AVIF named `.png`) is normalized by
 * ImageMagick to an 8-bit grey PNG first.
 */
async function ocrImage(image) {
  try {
    return { method: 'ocr:image', text: await tesseract(image) };
  } catch {
    return withTemp(async (dir) => {
      const normalized = path.join(dir, 'normalized.png');
      await run(
        'magick',
        [image, '-alpha', 'remove', '-colorspace', 'Gray', '-depth', '8', normalized],
        {
          maxBuffer: BUFFER,
        },
      );
      return { method: 'ocr:image(normalized)', text: await tesseract(normalized) };
    });
  }
}

/** The media type of the bytes where the extension lies (an AVIF image named `.png`). */
export function sniffMediaType(bytes, declared) {
  if (bytes.length >= 12 && bytes.toString('latin1', 4, 12) === 'ftypavif') return 'image/avif';
  return declared;
}

async function pdf(file) {
  const { stdout } = await run('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-'], {
    maxBuffer: BUFFER,
  });
  const { stdout: info } = await run('pdfinfo', [file], { maxBuffer: BUFFER });
  const pages = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1] ?? '1');
  const visible = stdout.replace(/\s+/g, '').length;
  if (visible >= 40 * pages) return { method: 'pdftotext', text: stdout };
  return withTemp(async (dir) => {
    await run('pdftoppm', ['-r', '300', '-png', file, path.join(dir, 'page')], {
      maxBuffer: BUFFER,
    });
    const images = (await readdir(dir)).filter((f) => f.endsWith('.png')).sort();
    const parts = [];
    for (const image of images) parts.push(await tesseract(path.join(dir, image)));
    return { method: `ocr:${images.length}p`, text: parts.join('\n\f\n') };
  });
}

/**
 * DRBench's mail (Roundcube) and chat (Mattermost) exports: one JSON object per line — `user`,
 * `email`, `team`, `channel`, `post`, `version` — rendered as readable Markdown: the people, then
 * each mail or post. Account passwords the exports carry for the benchmark's sandbox are never
 * rendered.
 */
export function renderJsonl(content) {
  const users = [];
  const teams = [];
  const channels = [];
  const messages = [];
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    const m = JSON.parse(line);
    if (m.type === 'user') {
      const u = m.user ?? m;
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
      users.push(
        `- ${name || u.username} (${u.email ?? u.username})${u.position ? `, ${u.position}` : ''}`,
      );
    } else if (m.type === 'team') {
      teams.push(`- ${m.team.display_name}: ${m.team.purpose ?? m.team.header ?? ''}`);
    } else if (m.type === 'channel') {
      channels.push(`- #${m.channel.name} (${m.channel.team}): ${m.channel.purpose ?? ''}`);
    } else if (m.type === 'email') {
      const list = (v) => (Array.isArray(v) ? v.join(', ') : (v ?? ''));
      messages.push(
        `## ${m.subject ?? '(no subject)'}`,
        '',
        `**From:** ${m.from_name ? `${m.from_name} <${m.from}>` : (m.from ?? '')}  `,
        `**To:** ${list(m.to)}  `,
        ...(m.cc && list(m.cc) !== '' ? [`**Cc:** ${list(m.cc)}  `] : []),
        `**Date:** ${m.date ?? ''}`,
        '',
        String(m.body ?? ''),
        '',
      );
    } else if (m.type === 'post') {
      const p = m.post;
      const when =
        p.create_at === undefined || p.create_at === null
          ? 'undated'
          : `${new Date(Number(p.create_at)).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
      messages.push(
        `**${p.user}** in #${p.channel} (${p.team}), ${when}:`,
        '',
        String(p.message),
        '',
      );
    }
  }
  return [
    ...(teams.length > 0 ? ['# Teams', '', ...teams, ''] : []),
    ...(channels.length > 0 ? ['# Channels', '', ...channels, ''] : []),
    ...(users.length > 0 ? ['# People', '', ...users, ''] : []),
    '# Messages',
    '',
    ...messages,
  ].join('\n');
}

export async function extract(file) {
  const ext = extensionOf(file);
  switch (ext) {
    case 'pdf':
      return pdf(file);
    case 'xlsx':
      // DRBench's workbooks name their sheets `xl//xl/worksheets/…`, which pandoc's reader cannot
      // follow; LibreOffice re-saves such a workbook in the standard layout first.
      try {
        return { method: 'pandoc:xlsx', text: await pandoc('xlsx', file) };
      } catch {
        return { method: 'libreoffice:xlsx+pandoc', text: await libreoffice(file, 'xlsx') };
      }
    case 'pptx':
    case 'csv':
      return { method: `pandoc:${ext}`, text: await pandoc(ext, file) };
    case 'ods':
      return { method: 'libreoffice:xlsx+pandoc', text: await libreoffice(file, 'xlsx') };
    case 'odp':
      return { method: 'libreoffice:pptx+pandoc', text: await libreoffice(file, 'pptx') };
    case 'png':
    case 'jpg':
    case 'jpeg':
      return ocrImage(file);
    case 'jsonl':
      return { method: 'jsonl:markdown', text: renderJsonl(await readFile(file, 'utf8')) };
    default:
      throw new Error(`no extraction for .${ext}`);
  }
}
