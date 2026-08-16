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
    const claims = atoms.map(({ digest: _digest, ...claim }) => claim);
    return {
      parser: 'pandoc',
      parserVersion: apiVersion,
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
