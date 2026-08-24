import { spawn } from 'node:child_process';
import { digest, digestBytes } from '@kf/canonicalization';
import {
  PANDOC_PROJECTION_CONTRACT,
  type DocumentParser,
  type ParsedDocument,
} from './parse-contract.js';
import { projectionFromPandoc } from './pandoc-projection.js';
import type { PandocDocument } from './pandoc-types.js';

const PANDOC_FORMATS: Readonly<Record<string, string>> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'text/markdown': 'gfm',
  'text/plain': 'markdown',
};

const EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
};

/** Browser MIME detection is inconsistent for Markdown/text; extension provides safe fallback. */
export function mediaTypeForDocumentFile(
  fileName: string,
  declaredMediaType?: string,
): string | undefined {
  const extension = /\.([^.]+)$/.exec(fileName)?.[1]?.toLowerCase();
  const fromExtension = extension === undefined ? undefined : EXTENSION_MEDIA_TYPES[extension];
  if (fromExtension !== undefined) return fromExtension;
  return declaredMediaType !== undefined && PANDOC_FORMATS[declaredMediaType] !== undefined
    ? declaredMediaType
    : undefined;
}

/** Map controlled-document semantics onto evidence-vault artifact vocabulary. */
export function artifactKindForDocumentClass(documentClass: string): string {
  if (documentClass === 'specification') return 'specification';
  if (documentClass === 'report') return 'report';
  return 'other';
}

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_PANDOC_JSON_BYTES = 64 * 1024 * 1024;

/**
 * The pandoc BINARY version, which is not the same thing as `pandoc-api-version`.
 *
 * `pandoc-api-version` is the pandoc-types AST SCHEMA version. It moves only when the shape of
 * the AST changes, so a long run of pandoc releases share one value while differing in how they
 * parse the same bytes. This host runs pandoc 3.10.2 and CI runs 3.1.3 — dozens of releases
 * apart — and both stamped their parses `1.23.1.2`.
 *
 * That matters because `contentDigest` is derived from the atoms and used as a content address
 * (`compiled-views/sha256/<digest>`). If two hosts parse one document differently, the record
 * has to be able to say which produced which, and until now it could not. The column comment on
 * `content.document_parse` already claimed `parser_version` "identifies only upstream Pandoc";
 * this makes that true instead of aspirational.
 *
 * Resolved once per process and cached: it cannot change under a running process, and paying a
 * subprocess spawn per parsed document to re-learn a constant would be silly.
 */
let cachedBinaryVersion: Promise<string> | undefined;

function pandocBinaryVersion(): Promise<string> {
  cachedBinaryVersion ??= new Promise<string>((resolve, reject) => {
    const child = spawn('pandoc', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`pandoc --version exited ${String(code)}`));
        return;
      }
      // First line is `pandoc 3.10.2`, sometimes `pandoc.exe 3.1.3` on Windows builds.
      const first = Buffer.concat(stdout).toString('utf8').split('\n')[0] ?? '';
      const version = /^\s*pandoc(?:\.exe)?\s+(\S+)/.exec(first)?.[1];
      if (version === undefined) {
        reject(new Error(`could not read a version out of pandoc --version: ${first.trim()}`));
        return;
      }
      resolve(version);
    });
  });
  // A rejection must not be cached, or one transient spawn failure poisons the process.
  cachedBinaryVersion.catch(() => {
    cachedBinaryVersion = undefined;
  });
  return cachedBinaryVersion;
}

async function pandocJson(bytes: Buffer, format: string): Promise<PandocDocument> {
  return new Promise((resolve, reject) => {
    const child = spawn('pandoc', [`--from=${format}`, '--to=json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PANDOC_JSON_BYTES) {
        child.kill('SIGKILL');
        reject(new Error('pandoc output exceeded 64 MiB safety limit'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `pandoc exited ${String(code)}: ${Buffer.concat(stderr).toString('utf8').trim()}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')) as PandocDocument);
      } catch (error: unknown) {
        reject(new Error('pandoc returned invalid JSON', { cause: error }));
      }
    });
    child.stdin.end(bytes);
  });
}

export class PandocDocumentParser implements DocumentParser {
  async parse(bytes: Buffer, mediaType: string): Promise<ParsedDocument | undefined> {
    const format = PANDOC_FORMATS[mediaType];
    if (format === undefined) return undefined;
    if (bytes.length === 0) throw new Error('document source is empty');
    if (bytes.length > MAX_SOURCE_BYTES) throw new Error('document source exceeds 20 MiB limit');
    const document = await pandocJson(bytes, format);
    const { atoms, conversionLoss } = projectionFromPandoc(document);
    const apiVersion = Array.isArray(document['pandoc-api-version'])
      ? document['pandoc-api-version'].join('.')
      : 'unknown';
    const binaryVersion = await pandocBinaryVersion();
    const claims = atoms.map(({ digest: _digest, ...claim }) => claim);
    return {
      parser: 'pandoc',
      // Both, because they answer different questions and only one of them was being recorded.
      // The binary version says which program parsed this; the api version says which AST shape
      // it emitted. Kept in one field rather than migrating the column: nothing parses this
      // string — it is carried opaquely to the document view — so widening it costs nothing and
      // a schema change would.
      parserVersion: `${binaryVersion}+api.${apiVersion}`,
      projectionContract: PANDOC_PROJECTION_CONTRACT,
      sourceDigest: digestBytes(bytes),
      atoms,
      conversionLoss,
      lossDigest: digest(conversionLoss),
      contentDigest: digest({
        projectionContract: PANDOC_PROJECTION_CONTRACT,
        atoms: claims,
        conversionLoss,
      }),
    };
  }
}
