/**
 * What never enters KF, decided from a path and from the bytes, before anything is stored.
 *
 * The standing policy: no PHI, bank details, tax identifiers or payroll secrets ever enter the
 * Fabric, and no credential does either. An ingest or a sync pointed at a home directory or a
 * repository checkout would otherwise copy `.env`, an SSH key and a payroll export as happily
 * as a drawing, and once the bytes are stored under a record the only remedy is erasure.
 *
 * Two layers, both refusing the WHOLE batch like every other planner refusal:
 *
 *   PATH  names that are credentials by convention — dotfiles and dot-directories (`.env`,
 *         `.git/`, `.ssh/`), `*.pem`, `*.key`, `id_rsa*` and its siblings, `*.kdbx`,
 *         `*.p12`/`*.pfx`. Cheap, and certain about what it matches.
 *   BYTES a private-key header, and text that is LIKELY an IBAN (country length + mod-97),
 *         a US SSN (the SSA's never-issued ranges excluded) or a payment card number (Luhn +
 *         a real issuer prefix). Each check is a validator, not a shape: a bare 9-digit or
 *         16-digit run is not refused unless its checksum holds.
 *
 * A refusal names the file, the rule and the line, and NEVER the matched text. A refusal is
 * printed, logged and returned over HTTP; echoing the secret there would leak it to exactly the
 * places this exists to keep it out of.
 *
 * WHAT THE BYTE SCAN SEES. Text, Markdown, CSV and JSON are scanned as stored. A ZIP package
 * (DOCX, ODT, XLSX, PPTX, ODS, a plain .zip) is opened and every part is scanned — XML parts
 * both as stored and as their character data, so a number Word split across runs is seen whole.
 * A PDF's FlateDecode streams are inflated and scanned, with the literal and hex strings they
 * draw decoded. All of it is bounded (`content-extract.ts`: 64 MiB expanded, 10 000 parts, a
 * 250:1 ratio past 1 MiB); a file that trips a bound, or a ZIP the scan cannot read (encrypted,
 * ZIP64, an exotic compression method), is refused and the bound is named.
 *
 * THE LIMIT, stated so nobody over-reads it: text a PDF draws through a font with a custom
 * encoding (CID/Identity-H, common for non-Latin text) is glyph ids, not characters, and an
 * encrypted PDF's streams are ciphertext; the scan sees neither. Images are pixels. This is a
 * net for the common accident, not a data-loss-prevention product.
 */

import { basename } from 'node:path';
import { ExtractionRefused, extractHiddenText, isPdf } from './content-extract.js';

export interface ContentRefusal {
  readonly path: string;
  readonly ruleId: string;
  readonly reason: string;
  /**
   * 1-based line of the first match, for a byte rule read from the file as stored; absent for a
   * path rule and for text extracted from a compressed part, where a line means nothing.
   */
  readonly line?: number;
  /** The ZIP entry or PDF stream the match or the bound was in, when there was one. */
  readonly part?: string;
}

interface PathRule {
  readonly id: string;
  readonly test: (name: string, segments: readonly string[]) => boolean;
  readonly reason: string;
}

const PATH_RULES: readonly PathRule[] = [
  {
    id: 'dotfile',
    // Any segment, so `.git/config` and `.ssh/known_hosts` are refused as well as `.env`.
    test: (_name, segments) => segments.some((s) => s.startsWith('.') && s !== '.' && s !== '..'),
    reason: 'dotfiles and dot-directories hold configuration and credentials, not records',
  },
  {
    id: 'pem',
    test: (name) => name.endsWith('.pem'),
    reason: 'a .pem file is a certificate or a private key',
  },
  { id: 'key-file', test: (name) => name.endsWith('.key'), reason: 'a .key file is a key' },
  {
    id: 'ssh-identity',
    test: (name) => /^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/.test(name),
    reason: 'an SSH identity file is a private key, or its public half named like one',
  },
  {
    id: 'password-database',
    test: (name) => name.endsWith('.kdbx'),
    reason: 'a password database',
  },
  {
    id: 'pkcs12',
    test: (name) => name.endsWith('.p12') || name.endsWith('.pfx'),
    reason: 'a PKCS#12 bundle carries a private key',
  },
];

/** The first path rule that claims `path`, or undefined. Paths may use `/` or the OS separator. */
export function deniedPathRule(path: string): ContentRefusal | undefined {
  const segments = path.toLowerCase().split(/[\\/]/).filter(Boolean);
  const name = basename(path).toLowerCase();
  for (const rule of PATH_RULES) {
    if (rule.test(name, segments)) {
      return { path, ruleId: rule.id, reason: rule.reason };
    }
  }
  return undefined;
}

// --- byte rules -----------------------------------------------------------------------------

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;

/** IBAN length per country (ISO 13616 registry), for the countries KF plausibly meets. */
const IBAN_LENGTH: Readonly<Record<string, number>> = {
  AD: 24,
  AE: 23,
  AT: 20,
  BE: 16,
  BG: 22,
  BH: 22,
  BR: 29,
  CH: 21,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  EE: 20,
  ES: 24,
  FI: 18,
  FO: 18,
  FR: 27,
  GB: 22,
  GI: 23,
  GL: 18,
  GR: 27,
  HR: 21,
  HU: 28,
  IE: 22,
  IL: 23,
  IS: 26,
  IT: 27,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  MC: 27,
  MT: 31,
  NL: 18,
  NO: 15,
  PL: 28,
  PT: 25,
  RO: 24,
  SA: 24,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  TR: 26,
};

const IBAN_CANDIDATE = /\b([A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30})\b/g;

/**
 * The candidate pattern is greedy and can run on into the next uppercase word, so the IBAN is
 * cut to its country's exact length rather than required to fill the whole match.
 */
function ibanValid(candidate: string): boolean {
  const compact = candidate.replace(/ /g, '');
  const length = IBAN_LENGTH[compact.slice(0, 2)];
  if (length === undefined || compact.length < length) return false;
  const iban = compact.slice(0, length);
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

const SSN_CANDIDATE = /\b(\d{3})-(\d{2})-(\d{4})\b/g;

function ssnValid(area: string, group: string, serial: string): boolean {
  // Never issued: area 000, 666 or 900-999; group 00; serial 0000.
  return (
    area !== '000' && area !== '666' && !area.startsWith('9') && group !== '00' && serial !== '0000'
  );
}

/** 13-19 digits, optionally grouped by single spaces or hyphens. */
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Issuer prefixes of the networks a payroll or expense export would carry. */
function plausibleIssuer(digits: string): boolean {
  const two = Number(digits.slice(0, 2));
  const four = Number(digits.slice(0, 4));
  const three = Number(digits.slice(0, 3));
  return (
    (digits.startsWith('4') && [13, 16, 19].includes(digits.length)) || // Visa
    (((two >= 51 && two <= 55) || (four >= 2221 && four <= 2720)) && digits.length === 16) ||
    ((two === 34 || two === 37) && digits.length === 15) || // Amex
    ((digits.startsWith('6011') || two === 65 || (three >= 644 && three <= 649)) &&
      digits.length >= 16) || // Discover
    (four >= 3528 && four <= 3589 && digits.length >= 16) // JCB
  );
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/**
 * The first byte rule `bytes` trips, or undefined: first the file as stored, then whatever a
 * ZIP or a PDF keeps compressed inside it. Read as latin1 so every byte maps to one character
 * and no decoding error can hide a match.
 *
 * A PDF's own syntax is held to the private-key rule only. Its body is mostly numbers separated
 * by single spaces — font width tables, coordinates, cross-reference offsets — and a run like
 * `556 556 556 556 556 5` is sixteen digits with a Mastercard prefix, which Luhn passes one time
 * in ten. Measured on 40 PDFs shipped under /usr/share on the workstation: the scan as it stood
 * refused 6 of them for a card number none of them contained, and every rule over the inflated
 * streams refused 14. The text a PDF DRAWS is its strings, and those get every rule; with that
 * split, all 40 pass and a card number typeset by pandoc is still caught.
 */
export function scanContent(path: string, bytes: Buffer): ContentRefusal | undefined {
  const pdf = isPdf(bytes);
  const stored = scanText(path, bytes.toString('latin1'), pdf ? 'keys' : 'all');
  if (stored !== undefined) return stored;
  let parts;
  try {
    parts = extractHiddenText(bytes);
  } catch (error: unknown) {
    if (!(error instanceof ExtractionRefused)) throw error;
    return {
      path,
      ruleId: `archive-${error.limit}`,
      reason: `${error.message}; the scan cannot vouch for what it cannot read`,
      ...(error.part === undefined ? {} : { part: error.part }),
    };
  }
  for (const { part, text, syntax } of parts) {
    const found = scanText(path, text, syntax ? 'keys' : 'all');
    if (found !== undefined) {
      const { line: _line, ...withoutLine } = found;
      return { ...withoutLine, part };
    }
  }
  return undefined;
}

function scanText(path: string, text: string, rules: 'all' | 'keys'): ContentRefusal | undefined {
  const key = PRIVATE_KEY.exec(text);
  if (key !== null) {
    return {
      path,
      ruleId: 'private-key',
      reason: 'contains a private key',
      line: lineOf(text, key.index),
    };
  }
  if (rules === 'keys') return undefined;
  for (const match of text.matchAll(IBAN_CANDIDATE)) {
    if (ibanValid(match[1]!)) {
      return {
        path,
        ruleId: 'iban',
        reason: 'contains what validates as an IBAN; bank details never enter KF',
        line: lineOf(text, match.index),
      };
    }
  }
  for (const match of text.matchAll(SSN_CANDIDATE)) {
    if (ssnValid(match[1]!, match[2]!, match[3]!)) {
      return {
        path,
        ruleId: 'us-ssn',
        reason:
          'contains what looks like a US social security number; tax identifiers never enter KF',
        line: lineOf(text, match.index),
      };
    }
  }
  for (const match of text.matchAll(CARD_CANDIDATE)) {
    // Greedy like the IBAN pattern: a card number followed by a year is one digit run, so every
    // card length is tried as a prefix rather than only the whole run.
    const run = match[0].replace(/[ -]/g, '');
    const digits = [13, 14, 15, 16, 17, 18, 19]
      .filter((length) => length <= run.length)
      .map((length) => run.slice(0, length))
      .find((prefix) => plausibleIssuer(prefix) && luhnValid(prefix));
    if (digits !== undefined) {
      return {
        path,
        ruleId: 'payment-card',
        reason: 'contains what validates as a payment card number',
        line: lineOf(text, match.index),
      };
    }
  }
  return undefined;
}

/**
 * One line per refusal, naming the file, the rule, and the line or the part — never the matched
 * text.
 */
export function formatContentRefusal(refusal: ContentRefusal): string {
  const where =
    refusal.part !== undefined
      ? ` (part ${refusal.part})`
      : refusal.line === undefined
        ? ''
        : ` (line ${String(refusal.line)})`;
  return `refusing ${refusal.path}${where}: rule ${refusal.ruleId} — ${refusal.reason}`;
}
