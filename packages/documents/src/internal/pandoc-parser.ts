import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { digestBytes } from '@kf/canonicalization';
import {
  documentConversionLossDigest,
  documentProjectionDigest,
  DocumentParseRefused,
  PANDOC_PROJECTION_CONTRACT,
  type DocumentParser,
  type ParsedDocument,
} from './parse-contract.js';
import { projectionFromPandoc } from './pandoc-projection.js';
import { preparePandocTextSource } from './pandoc-nul.js';
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
/** Every document class is an artifact of kind `document`; the class lives on the document. */
export function artifactKindForDocumentClass(documentClass: string): string {
  return documentClass === 'specification' || documentClass === 'report' ? 'document' : 'other';
}

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_PANDOC_JSON_BYTES = 64 * 1024 * 1024;

/**
 * Limits on the pandoc child, all of which a hostile source could otherwise choose for us.
 *
 * Measured on pandoc 3.10.2: a 10 KB gfm source of 5 000 nested blockquotes drove the process
 * to 8.5 GB RSS, and 30 000 nested link brackets ran past 120 s. The ingest and import paths
 * parse before their transaction opens (preparse.ts); an act with no pre-parse still parses
 * inside the attach_evidence transaction, holding a connection and row locks for as long as it
 * runs. The byte cap on the SOURCE says nothing about either input: both are tiny. So the child gets a heap ceiling (GHC RTS `-M`, which makes pandoc exit rather than
 * swap the host), a wall-clock deadline that SIGKILLs, and a cap on how much stderr we keep.
 */
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_HEAP_MIB = 512;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

/**
 * Where to look for pandoc when no absolute path is configured: a fixed system PATH, the same
 * one the Liminal adapter hands its sandbox, and never the inherited `PATH` — a writable
 * directory early on a service account's PATH would otherwise choose what parses evidence.
 */
const TRUSTED_BINARY_DIRECTORIES = ['/usr/local/bin', '/usr/bin', '/bin'] as const;

export interface PandocParserOptions {
  /** Absolute path to pandoc. Defaults to `KF_PANDOC_PATH`, else the first trusted system dir. */
  readonly pandocPath?: string;
  /** Wall-clock deadline per parse; the child is SIGKILLed when it passes. */
  readonly timeoutMs?: number;
  /** GHC heap ceiling handed to pandoc as `+RTS -M<n>m -RTS`. */
  readonly maxHeapMiB?: number;
  /** stderr kept for the error message; the rest is discarded, never buffered. */
  readonly maxStderrBytes?: number;
}

interface PandocLimits {
  readonly pandocPath: string;
  readonly timeoutMs: number;
  readonly maxHeapMiB: number;
  readonly maxStderrBytes: number;
}

function positive(value: number | undefined, envName: string, fallback: number): number {
  const fromEnv = process.env[envName];
  const selected = value ?? (fromEnv === undefined ? fallback : Number(fromEnv));
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new Error(`${envName} must be a positive integer`);
  }
  return selected;
}

function resolvePandocPath(configured: string | undefined): string {
  const explicit = configured ?? process.env['KF_PANDOC_PATH'];
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) throw new Error('KF_PANDOC_PATH must be an absolute path');
    return explicit;
  }
  for (const directory of TRUSTED_BINARY_DIRECTORIES) {
    const candidate = `${directory}/pandoc`;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; try the next trusted directory.
    }
  }
  throw new Error(
    `pandoc not found in ${TRUSTED_BINARY_DIRECTORIES.join(':')}; set KF_PANDOC_PATH to its absolute path`,
  );
}

interface PandocRun {
  readonly code: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
}

/**
 * Run pandoc once under every limit. Settles exactly once: whichever of close, error, the
 * output cap or the deadline arrives first decides, and the rest are ignored.
 */
function runPandoc(
  limits: PandocLimits,
  args: readonly string[],
  input?: Buffer,
): Promise<PandocRun> {
  return new Promise((resolve, reject) => {
    // `--sandbox` stops a reader from touching the filesystem or network (docx/odt can carry
    // image and include references). The `+RTS ... -RTS` block is read by the GHC runtime, not
    // by pandoc, so its position is free; it goes last to keep pandoc's own argv readable.
    const child = spawn(
      limits.pandocPath,
      ['--sandbox', ...args, '+RTS', `-M${String(limits.maxHeapMiB)}m`, '-RTS'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      action();
    };
    const refuse = (reason: DocumentParseRefused['reason'], message: string): void => {
      child.kill('SIGKILL');
      settle(() => reject(new DocumentParseRefused(reason, message)));
    };
    const deadline = setTimeout(() => {
      refuse('timeout', `pandoc exceeded the ${String(limits.timeoutMs)} ms parse deadline`);
    }, limits.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PANDOC_JSON_BYTES) {
        refuse('output_limit', 'pandoc output exceeded 64 MiB safety limit');
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const room = limits.maxStderrBytes - stderrBytes;
      if (room <= 0) return;
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      stderr.push(kept);
      stderrBytes += kept.length;
    });
    child.once('error', (error) => settle(() => reject(error)));
    child.once('close', (code) => {
      settle(() =>
        resolve({
          code,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr).toString('utf8').trim(),
        }),
      );
    });
    // A child killed mid-write closes stdin under us; that EPIPE is the kill, not a new fault.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

/**
 * The pandoc BINARY version, which is not the same thing as `pandoc-api-version`.
 *
 * `pandoc-api-version` is the pandoc-types AST SCHEMA version. It moves only when the shape of
 * the AST changes, so a run of pandoc releases can share one value while differing in how they
 * parse the same bytes — the schema is not a proxy for the program.
 *
 * An earlier version of this comment claimed pandoc 3.1.3 (CI) and 3.10.2 (this workstation)
 * "both stamped their parses 1.23.1.2". Measured, they do not: 3.1.3 emits `1.23.1` and 3.10.2
 * emits `1.23.1.2`. The general point stands and the example was wrong, which is worth leaving
 * written down — pandoc-types happened to move between those two releases, and picking a pair
 * where it had not would have been luck rather than reasoning.
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
const cachedBinaryVersions = new Map<string, Promise<string>>();

function pandocBinaryVersion(limits: PandocLimits): Promise<string> {
  // Keyed by path: two parsers configured with two pandocs must not share one answer.
  const cached = cachedBinaryVersions.get(limits.pandocPath);
  if (cached !== undefined) return cached;
  const pending = runPandoc(limits, ['--version']).then(({ code, stdout }) => {
    if (code !== 0) throw new Error(`pandoc --version exited ${String(code)}`);
    // First line is `pandoc 3.10.2`, sometimes `pandoc.exe 3.1.3` on Windows builds.
    const first = stdout.toString('utf8').split('\n')[0] ?? '';
    const version = /^\s*pandoc(?:\.exe)?\s+(\S+)/.exec(first)?.[1];
    if (version === undefined) {
      throw new Error(`could not read a version out of pandoc --version: ${first.trim()}`);
    }
    return version;
  });
  cachedBinaryVersions.set(limits.pandocPath, pending);
  // A rejection must not be cached, or one transient spawn failure poisons the process.
  pending.catch(() => cachedBinaryVersions.delete(limits.pandocPath));
  return pending;
}

async function pandocJson(
  limits: PandocLimits,
  bytes: Buffer,
  format: string,
): Promise<PandocDocument> {
  const { code, stdout, stderr } = await runPandoc(
    limits,
    [`--from=${format}`, '--to=json'],
    bytes,
  );
  if (code !== 0) {
    // GHC's RTS reports an exhausted `-M` heap as exit 251 with "Heap exhausted" on stderr.
    // That is the source's doing, not the host's, so it is a refusal rather than a fault.
    if (code === 251 || /heap exhausted/i.test(stderr)) {
      throw new DocumentParseRefused(
        'memory',
        `pandoc exceeded the ${String(limits.maxHeapMiB)} MiB heap ceiling`,
      );
    }
    throw new DocumentParseRefused('parser_failed', `pandoc exited ${String(code)}: ${stderr}`);
  }
  try {
    return JSON.parse(stdout.toString('utf8')) as PandocDocument;
  } catch (error: unknown) {
    throw new Error('pandoc returned invalid JSON', { cause: error });
  }
}

export class PandocDocumentParser implements DocumentParser {
  readonly #options: PandocParserOptions;
  #limits: PandocLimits | undefined;

  constructor(options: PandocParserOptions = {}) {
    this.#options = options;
  }

  /** Resolved on first parse, not at construction: a host that never parses needs no pandoc. */
  #resolvedLimits(): PandocLimits {
    this.#limits ??= Object.freeze({
      pandocPath: resolvePandocPath(this.#options.pandocPath),
      timeoutMs: positive(this.#options.timeoutMs, 'KF_PANDOC_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
      maxHeapMiB: positive(
        this.#options.maxHeapMiB,
        'KF_PANDOC_MAX_HEAP_MIB',
        DEFAULT_MAX_HEAP_MIB,
      ),
      maxStderrBytes: positive(
        this.#options.maxStderrBytes,
        'KF_PANDOC_MAX_STDERR_BYTES',
        DEFAULT_MAX_STDERR_BYTES,
      ),
    });
    return this.#limits;
  }

  async parse(bytes: Buffer, mediaType: string): Promise<ParsedDocument | undefined> {
    const format = PANDOC_FORMATS[mediaType];
    if (format === undefined) return undefined;
    if (bytes.length === 0) throw new Error('document source is empty');
    if (bytes.length > MAX_SOURCE_BYTES) throw new Error('document source exceeds 20 MiB limit');
    const limits = this.#resolvedLimits();
    const input = preparePandocTextSource(bytes, format);
    const document = await pandocJson(limits, input.bytes, format);
    const projection = projectionFromPandoc(document);
    const { atoms } = projection;
    const conversionLoss = Object.freeze([...input.losses, ...projection.conversionLoss]);
    const apiVersion = Array.isArray(document['pandoc-api-version'])
      ? document['pandoc-api-version'].join('.')
      : 'unknown';
    const binaryVersion = await pandocBinaryVersion(limits);
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
      lossDigest: documentConversionLossDigest(conversionLoss),
      contentDigest: documentProjectionDigest(PANDOC_PROJECTION_CONTRACT, claims, conversionLoss),
    };
  }
}
