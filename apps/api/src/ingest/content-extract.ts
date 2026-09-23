/**
 * The text a content scan must see that the stored bytes hide: the parts of a ZIP package
 * (DOCX, ODT, XLSX, PPTX, ODS and any other ZIP) and the Flate-compressed streams of a PDF.
 *
 * Every expansion here is BOUNDED before it happens, because the input is whatever a caller
 * chose to send and a scan that inflates a zip bomb is a denial of service with extra steps:
 *
 *   BUDGET  the whole file expands to at most {@link MAX_EXPANDED_BYTES} across every part.
 *   COUNT   at most {@link MAX_PARTS} ZIP entries or compressed PDF streams are read.
 *   RATIO   a part may not expand more than {@link MAX_RATIO}:1 once it is past
 *           {@link RATIO_FLOOR_BYTES} (a tiny, highly repetitive part is ordinary XML).
 *   DEPTH   a ZIP inside a ZIP is read, to {@link MAX_ZIP_DEPTH} levels, on the same budget.
 *
 * The inflater is handed `maxOutputLength`, so a limit is enforced by zlib while it inflates —
 * the declared sizes in a ZIP directory are checked first, but they are the attacker's claim and
 * are never what bounds the memory.
 *
 * A limit that fires is an {@link ExtractionRefused}: the caller refuses the file and names the
 * limit. A ZIP whose content cannot be read at all (encrypted entries, a compression method
 * other than stored/deflate, ZIP64, a directory that does not parse) is refused the same way —
 * a scan that cannot see inside cannot vouch for what is there. A PDF stream that does not
 * inflate is skipped, as every PDF reader skips it: this is a net for the common accident, and
 * a corrupt stream is nobody's secret.
 */

import { constants, inflateRawSync, inflateSync } from 'node:zlib';

export const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
export const MAX_PARTS = 10_000;
export const MAX_RATIO = 250;
export const RATIO_FLOOR_BYTES = 1024 * 1024;
export const MAX_ZIP_DEPTH = 3;

/** Which bound fired, so a refusal can say exactly why without quoting any content. */
export type ExtractionLimit =
  'expanded-size' | 'part-count' | 'compression-ratio' | 'encrypted' | 'unsupported' | 'malformed';

export class ExtractionRefused extends Error {
  constructor(
    readonly limit: ExtractionLimit,
    message: string,
    readonly part?: string,
  ) {
    super(message);
    this.name = 'ExtractionRefused';
  }
}

/** One piece of text to scan, and the part of the container it came from. */
export interface ExtractedPart {
  readonly part: string;
  readonly text: string;
  /**
   * The container's own syntax rather than text anybody wrote: a decoded PDF stream as bytes.
   * Held to the private-key rule only (see `scanContent`), while the strings it draws — a
   * separate part — get every rule.
   */
  readonly syntax: boolean;
}

/** Shared across one file, however deep the nesting goes. */
class Budget {
  #expanded = 0;
  #parts = 0;

  /** Claim one part; refuses when the count is spent. */
  part(name: string): void {
    this.#parts += 1;
    if (this.#parts > MAX_PARTS) {
      throw new ExtractionRefused(
        'part-count',
        `has more than ${String(MAX_PARTS)} compressed parts to scan`,
        name,
      );
    }
  }

  /** The most this part may expand to before a limit fires, given its compressed size. */
  ceiling(compressedBytes: number): number {
    const remaining = MAX_EXPANDED_BYTES - this.#expanded;
    const byRatio = Math.max(RATIO_FLOOR_BYTES, compressedBytes * MAX_RATIO);
    return Math.max(0, Math.min(remaining, byRatio));
  }

  /** Check a claimed or actual expansion against every limit, then (if actual) spend it. */
  check(name: string, compressedBytes: number, expandedBytes: number): void {
    if (expandedBytes > MAX_EXPANDED_BYTES - this.#expanded) {
      throw new ExtractionRefused(
        'expanded-size',
        `expands past the ${String(MAX_EXPANDED_BYTES / (1024 * 1024))} MiB scan budget`,
        name,
      );
    }
    if (expandedBytes > RATIO_FLOOR_BYTES && expandedBytes > compressedBytes * MAX_RATIO) {
      throw new ExtractionRefused(
        'compression-ratio',
        `expands more than ${String(MAX_RATIO)}:1, the shape of a decompression bomb`,
        name,
      );
    }
  }

  spend(bytes: number): void {
    this.#expanded += bytes;
  }
}

/**
 * Inflate under a hard output ceiling. Exceeding it throws inside zlib, before the output is
 * allocated past the ceiling; that is translated into whichever limit the ceiling stood for.
 */
function boundedInflate(
  name: string,
  compressed: Buffer,
  budget: Budget,
  raw: boolean,
): Buffer | undefined {
  const ceiling = budget.ceiling(compressed.length);
  let out: Buffer;
  try {
    const options = { maxOutputLength: Math.max(1, ceiling), finishFlush: constants.Z_SYNC_FLUSH };
    out = raw ? inflateRawSync(compressed, options) : inflateSync(compressed, options);
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') {
      // One byte past the ceiling is enough to name the limit it stood for.
      budget.check(name, compressed.length, ceiling + 1);
      // `check` always throws for ceiling + 1; this keeps the type system honest.
      throw new ExtractionRefused('expanded-size', 'expands past the scan budget', name);
    }
    return undefined;
  }
  budget.check(name, compressed.length, out.length);
  budget.spend(out.length);
  return out;
}

// --- ZIP -------------------------------------------------------------------------------------

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

export function isZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.readUInt32LE(0) === LOCAL_HEADER;
}

function malformed(message: string, part?: string): ExtractionRefused {
  return new ExtractionRefused('malformed', `is a ZIP whose ${message}`, part);
}

/** Printable, bounded: an entry name is chosen by whoever built the file. */
function safePartName(raw: string): string {
  const printable = raw.replace(/[^\x20-\x7e]/g, '?');
  return printable.length > 160 ? `${printable.slice(0, 157)}...` : printable;
}

interface ZipEntry {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

function centralDirectory(bytes: Buffer): ZipEntry[] {
  // The end record sits in the last 22 bytes plus at most a 65 535-byte comment.
  const floor = Math.max(0, bytes.length - 22 - 0xffff);
  let end = -1;
  for (let i = bytes.length - 22; i >= floor; i -= 1) {
    if (bytes.readUInt32LE(i) === END_OF_CENTRAL) {
      end = i;
      break;
    }
  }
  if (end < 0) throw malformed('end-of-directory record is missing');
  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  const offset = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    throw new ExtractionRefused('unsupported', 'is a ZIP64 archive, which the scan does not read');
  }
  if (count > MAX_PARTS) {
    throw new ExtractionRefused(
      'part-count',
      `has more than ${String(MAX_PARTS)} compressed parts to scan`,
    );
  }
  if (offset + size > end) throw malformed('directory lies outside the file');
  const entries: ZipEntry[] = [];
  let at = offset;
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== CENTRAL_HEADER) {
      throw malformed('directory entry does not parse');
    }
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const nameEnd = at + 46 + nameLength;
    if (nameEnd > end) throw malformed('directory entry name runs past the directory');
    entries.push({
      name: safePartName(bytes.toString('utf8', at + 46, nameEnd)),
      flags: bytes.readUInt16LE(at + 8),
      method: bytes.readUInt16LE(at + 10),
      compressedSize: bytes.readUInt32LE(at + 20),
      uncompressedSize: bytes.readUInt32LE(at + 24),
      localHeaderOffset: bytes.readUInt32LE(at + 42),
    });
    at = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function entryData(bytes: Buffer, entry: ZipEntry): Buffer {
  const at = entry.localHeaderOffset;
  if (at + 30 > bytes.length || bytes.readUInt32LE(at) !== LOCAL_HEADER) {
    throw malformed('local header does not parse', entry.name);
  }
  const start = at + 30 + bytes.readUInt16LE(at + 26) + bytes.readUInt16LE(at + 28);
  const stop = start + entry.compressedSize;
  if (stop > bytes.length) throw malformed('entry runs past the end of the file', entry.name);
  return bytes.subarray(start, stop);
}

/**
 * Tags whose end is a text boundary. Joining `</w:p><w:p>` with nothing would run the last digits
 * of one paragraph into the first of the next and invent a card number; joining the runs INSIDE
 * a paragraph with nothing is exactly right, because Word splits one number across several runs.
 */
const BOUNDARY_TAGS = new Set([
  'p',
  'h',
  'br',
  'cr',
  'tab',
  'tr',
  'tc',
  'td',
  'th',
  'row',
  'c',
  'si',
  'line-break',
  'list-item',
  'table-row',
  'table-cell',
  'span-break',
  's',
]);

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return XML_ENTITIES[body] ?? whole;
  });
}

/** The character data of an XML part, tags removed, text boundaries kept as newlines. */
export function xmlText(xml: string): string {
  const stripped = xml.replace(/<[^>]*>/g, (tag) => {
    const name = /^<\/?\s*(?:[\w.-]+:)?([\w.-]+)/.exec(tag)?.[1];
    return name !== undefined && BOUNDARY_TAGS.has(name) ? '\n' : '';
  });
  try {
    return decodeEntities(stripped);
  } catch {
    // A numeric entity outside Unicode; the undecoded text is still worth scanning.
    return stripped;
  }
}

function zipParts(bytes: Buffer, budget: Budget, prefix: string, depth: number): ExtractedPart[] {
  const parts: ExtractedPart[] = [];
  for (const entry of centralDirectory(bytes)) {
    if (entry.name.endsWith('/')) continue;
    const name = `${prefix}${entry.name}`;
    budget.part(name);
    if ((entry.flags & 0x1) !== 0) {
      throw new ExtractionRefused('encrypted', 'has an encrypted part the scan cannot read', name);
    }
    if (entry.method !== 0 && entry.method !== 8) {
      throw new ExtractionRefused(
        'unsupported',
        `has a part compressed with method ${String(entry.method)}, which the scan does not read`,
        name,
      );
    }
    // The directory's claim is checked before any byte is inflated; the inflater's ceiling
    // below is what actually holds if the claim is a lie.
    budget.check(name, entry.compressedSize, entry.uncompressedSize);
    const data = entryData(bytes, entry);
    let content: Buffer;
    if (entry.method === 0) {
      budget.check(name, data.length, data.length);
      budget.spend(data.length);
      content = data;
    } else {
      const inflated = boundedInflate(name, data, budget, true);
      if (inflated === undefined) throw malformed('part does not inflate', name);
      content = inflated;
    }
    if (content.length !== entry.uncompressedSize) {
      throw malformed('part is not the size its directory declares', name);
    }
    if (isZip(content)) {
      if (depth >= MAX_ZIP_DEPTH) {
        throw new ExtractionRefused(
          'unsupported',
          `nests ZIPs more than ${String(MAX_ZIP_DEPTH)} deep`,
          name,
        );
      }
      parts.push(...zipParts(content, budget, `${name}!/`, depth + 1));
      continue;
    }
    const latin1 = content.toString('latin1');
    parts.push({ part: name, text: latin1, syntax: false });
    if (/\.(xml|rels|xhtml|html?|svg)$/i.test(entry.name)) {
      parts.push({ part: name, text: xmlText(content.toString('utf8')), syntax: false });
    }
  }
  return parts;
}

// --- PDF -------------------------------------------------------------------------------------

export function isPdf(bytes: Buffer): boolean {
  // The header may follow a little leading junk; readers allow 1 KiB of it.
  return bytes.subarray(0, 1024).includes('%PDF-');
}

const PDF_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  '(': '(',
  ')': ')',
  '\\': '\\',
};

/** One `( … )` literal starting at `open`, decoded; returns the text and the index after it. */
function literalString(source: string, open: number): { text: string; next: number } {
  let depth = 1;
  let text = '';
  let i = open + 1;
  while (i < source.length && depth > 0) {
    const c = source[i]!;
    if (c === '\\') {
      const next = source[i + 1] ?? '';
      const octal = /^[0-7]{1,3}/.exec(source.slice(i + 1, i + 4))?.[0];
      if (octal !== undefined) {
        text += String.fromCharCode(Number.parseInt(octal, 8) & 0xff);
        i += 1 + octal.length;
      } else if (next === '\r' || next === '\n') {
        i += next === '\r' && source[i + 2] === '\n' ? 3 : 2;
      } else {
        text += PDF_ESCAPES[next] ?? next;
        i += 2;
      }
      continue;
    }
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (depth > 0) text += c;
    i += 1;
  }
  return { text, next: i };
}

/**
 * The strings a PDF draws, decoded from literal `( … )` and hex `< … >` form, one per line.
 *
 * The one exception is a `[ … ] TJ` array: that is one run of text split for kerning, so its
 * strings are joined — with nothing, or with a space where the adjustment is wide enough to be
 * one (TeX draws a space as a gap, not a glyph; without this `Card 4111…` reads `Card4111…` and
 * the digits lose the word boundary every rule anchors on). Any OTHER array keeps its strings
 * apart: a page-label or name tree is `[(1) 1 0 R (2) …]`, and joining those invents numbers.
 */
export function pdfStrings(source: string): string {
  const lines: string[] = [];
  let array: { joined: string; separate: string[] } | undefined;
  const emit = (text: string): void => {
    if (text === '') return;
    if (array === undefined) {
      lines.push(text);
      return;
    }
    array.joined += text;
    array.separate.push(text);
  };
  const closeArray = (drawn: boolean): void => {
    if (array === undefined) return;
    if (drawn) {
      if (array.joined !== '') lines.push(array.joined);
    } else {
      lines.push(...array.separate);
    }
    array = undefined;
  };
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    if (char === '(') {
      const { text, next } = literalString(source, i);
      emit(text);
      i = next;
      continue;
    }
    if (char === '<' && source[i + 1] === '<') {
      i += 2;
      continue;
    }
    if (char === '<') {
      const close = source.indexOf('>', i + 1);
      if (close < 0) break;
      const hex = source.slice(i + 1, close).replace(/[^0-9a-fA-F]/g, '');
      if (hex.length > 0) {
        emit(Buffer.from(hex.length % 2 === 0 ? hex : `${hex}0`, 'hex').toString('latin1'));
      }
      i = close + 1;
      continue;
    }
    if (array !== undefined && (char === '-' || char === '.' || (char >= '0' && char <= '9'))) {
      const number = /^-?\d*\.?\d+/.exec(source.slice(i, i + 32))?.[0];
      if (number !== undefined) {
        if (Number(number) <= -150 && array.joined !== '' && !array.joined.endsWith(' ')) {
          array.joined += ' ';
        }
        i += number.length;
        continue;
      }
    }
    if (char === '[') {
      closeArray(false);
      array = { joined: '', separate: [] };
    } else if (char === ']') {
      closeArray(/^\s*TJ\b/.test(source.slice(i + 1, i + 16)));
    }
    i += 1;
  }
  closeArray(false);
  return lines.join('\n');
}

const STREAM_KEYWORD = /stream\r?\n/g;

/**
 * Each FlateDecode stream, inflated under the budget. The stream's dictionary is the text since
 * the previous `obj`; its data runs for a direct `/Length` when that is present and plausible,
 * else to the next `endstream`. A stream with another filter (an image, ASCII85) is left alone.
 */
function pdfParts(bytes: Buffer, budget: Budget): ExtractedPart[] {
  const source = bytes.toString('latin1');
  // The strings outside every stream: a document's metadata and form-field values. Stream data
  // is cut out first, because compressed bytes read as syntax open a `(` that never closes.
  const outsideStreams = source.replace(/stream\r?\n[\s\S]*?endstream/g, '');
  const parts: ExtractedPart[] = [
    { part: 'strings', text: pdfStrings(outsideStreams), syntax: false },
  ];
  for (const match of source.matchAll(STREAM_KEYWORD)) {
    const keyword = match.index;
    // `endstream` ends in `stream`, and is followed by a newline often enough to match.
    if (source.slice(Math.max(0, keyword - 3), keyword) === 'end') continue;
    const objectStart = source.lastIndexOf(' obj', keyword);
    const dictionary = source.slice(
      objectStart < 0 ? Math.max(0, keyword - 4096) : objectStart,
      keyword,
    );
    const filter = /\/Filter\s*(?:\/(\w+)|\[\s*\/(\w+)\s*\])/.exec(dictionary);
    const filterName = filter?.[1] ?? filter?.[2];
    if (filterName !== 'FlateDecode' && filterName !== 'Fl') continue;
    // Pixels carry no text, and a flat-colour image is the one ordinary thing that compresses
    // past the ratio bound: a licence PDF under /usr/share tripped it before this line.
    if (/\/Subtype\s*\/Image\b/.test(dictionary)) continue;
    const dataStart = keyword + match[0].length;
    const declared = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dictionary)?.[1];
    let dataEnd = declared === undefined ? -1 : dataStart + Number(declared);
    if (dataEnd < dataStart || dataEnd > bytes.length) {
      dataEnd = source.indexOf('endstream', dataStart);
      if (dataEnd < 0) continue;
    }
    const name = `stream@${String(keyword)}`;
    budget.part(name);
    const inflated = boundedInflate(name, bytes.subarray(dataStart, dataEnd), budget, false);
    if (inflated === undefined) continue;
    const text = inflated.toString('latin1');
    parts.push(
      { part: name, text, syntax: true },
      { part: name, text: pdfStrings(text), syntax: false },
    );
  }
  return parts;
}

/**
 * The hidden text of `bytes`, or nothing when it is neither a ZIP nor a PDF. Throws
 * {@link ExtractionRefused} when a bound fires or a ZIP cannot be read.
 */
export function extractHiddenText(bytes: Buffer): ExtractedPart[] {
  const budget = new Budget();
  if (isZip(bytes)) return zipParts(bytes, budget, '', 1);
  if (isPdf(bytes)) return pdfParts(bytes, budget);
  return [];
}
