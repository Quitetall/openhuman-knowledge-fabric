import { canonicalize, digestBytes, taggedDigest, type JsonValue } from '@kf/canonicalization';

export type DocumentAtomKind =
  'heading' | 'paragraph' | 'list_item' | 'quote' | 'code' | 'table' | 'horizontal_rule';

export interface DocumentAtom {
  readonly ordinal: number;
  readonly kind: DocumentAtomKind;
  readonly level: number | null;
  readonly text: string;
  readonly attributes: Readonly<Record<string, JsonValue>>;
  readonly digest: string;
}

export interface ParsedDocument {
  readonly parser: string;
  readonly parserVersion: string;
  readonly projectionContract: string;
  /** SHA-256 over exact source bytes supplied to parser. */
  readonly sourceDigest: string;
  readonly atoms: readonly DocumentAtom[];
  readonly conversionLoss: readonly DocumentParseLoss[];
  /** JCS SHA-256 over conversionLoss, including every omitted-source preimage. */
  readonly lossDigest: string;
  /** JCS SHA-256 over projection contract, atom claims, and conversion-loss claims. */
  readonly contentDigest: string;
}

export interface DocumentParseLoss {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  /** Exact Pandoc JSON value whose omission or flattening produced this loss claim. */
  readonly source: JsonValue;
  readonly sourceDigest: string;
}

export interface DocumentParser {
  parse(bytes: Buffer, mediaType: string): Promise<ParsedDocument | undefined>;
}

export const PANDOC_PROJECTION_CONTRACT = 'kf.pandoc-atoms.v2';

/**
 * The digest formats of a parse receipt (KF-SAS-RQ-016), whatever parser produced it.
 *
 * `kf-document-parse-v2` is every receipt written since migration 20260925114000: each of its four
 * digests carries its own tag inside its preimage. `kf-document-parse-v1` names the earlier,
 * untagged receipt — atom `digest(claim)`, loss-source `digest(source)`, loss `digest(losses)`,
 * projection `digest({ projectionContract, atoms, conversionLoss })` — which recorded parses still
 * carry. The database records the format per parse (`content.document_parse.digest_format`), sets
 * it, and checks each new row's preimages under it; nothing in this process re-verifies a stored
 * v1 receipt, so what is here computes v2 only. A projection contract (`kf.pandoc-atoms.v2`) is the
 * parser's own vocabulary for what an atom is, and is a different axis from these.
 */
export const DOCUMENT_PARSE_DIGEST_FORMAT = 'kf-document-parse-v2';
export const DOCUMENT_ATOM_FORMAT = 'kf-document-atom-v1';
export const DOCUMENT_LOSS_SOURCE_FORMAT = 'kf-document-loss-source-v1';
export const DOCUMENT_CONVERSION_LOSS_FORMAT = 'kf-document-conversion-loss-v1';
export const DOCUMENT_PROJECTION_FORMAT = 'kf-document-projection-v1';

/** An atom without its digest: what the atom digest commits to. */
export type DocumentAtomClaim = Omit<DocumentAtom, 'digest'>;

/** The exact object whose RFC 8785 bytes are an atom's recorded preimage. */
export function documentAtomPreimage(claim: DocumentAtomClaim): Readonly<Record<string, unknown>> {
  return {
    format: DOCUMENT_ATOM_FORMAT,
    ordinal: claim.ordinal,
    kind: claim.kind,
    level: claim.level,
    text: claim.text,
    attributes: claim.attributes,
  };
}

export function documentAtomDigest(claim: DocumentAtomClaim): string {
  return taggedDigest(DOCUMENT_ATOM_FORMAT, {
    ordinal: claim.ordinal,
    kind: claim.kind,
    level: claim.level,
    text: claim.text,
    attributes: claim.attributes,
  });
}

/** The digest of the exact parser output a conversion loss dropped or flattened. */
export function documentLossSourceDigest(source: JsonValue): string {
  return taggedDigest(DOCUMENT_LOSS_SOURCE_FORMAT, { source });
}

/** The exact object whose RFC 8785 bytes are a parse's recorded loss preimage. */
export function documentConversionLossPreimage(
  conversionLoss: readonly DocumentParseLoss[],
): Readonly<Record<string, unknown>> {
  return { format: DOCUMENT_CONVERSION_LOSS_FORMAT, conversionLoss };
}

export function documentConversionLossDigest(conversionLoss: readonly DocumentParseLoss[]): string {
  return taggedDigest(DOCUMENT_CONVERSION_LOSS_FORMAT, { conversionLoss });
}

/** The exact object whose RFC 8785 bytes are a parse's recorded projection preimage. */
export function documentProjectionPreimage(
  projectionContract: string,
  atoms: readonly DocumentAtomClaim[],
  conversionLoss: readonly DocumentParseLoss[],
): Readonly<Record<string, unknown>> {
  return {
    format: DOCUMENT_PROJECTION_FORMAT,
    projectionContract,
    atoms: atoms.map(documentAtomPreimage),
    conversionLoss,
  };
}

/** A parse's `contentDigest`: the projection contract, every atom preimage, every loss. */
export function documentProjectionDigest(
  projectionContract: string,
  atoms: readonly DocumentAtomClaim[],
  conversionLoss: readonly DocumentParseLoss[],
): string {
  return taggedDigest(DOCUMENT_PROJECTION_FORMAT, {
    projectionContract,
    atoms: atoms.map(documentAtomPreimage),
    conversionLoss,
  });
}

export class DocumentParseIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentParseIntegrityError';
  }
}

/**
 * Why a parser declined a source, as opposed to failing to run.
 *
 * `timeout` and `memory` are the two a hostile source can reach on purpose: pandoc's Markdown
 * reader is super-linear on some inputs (5 000 nested blockquotes took 8.5 GB; 30 000 nested
 * link brackets ran past two minutes). Naming them lets a caller report "this document was
 * refused" instead of reporting a crashed worker, and lets a test pin which limit fired.
 */
export type DocumentParseRefusalReason = 'timeout' | 'memory' | 'output_limit' | 'parser_failed';

export class DocumentParseRefused extends Error {
  constructor(
    readonly reason: DocumentParseRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = 'DocumentParseRefused';
  }
}

const DOCUMENT_ATOM_KINDS = new Set<DocumentAtomKind>([
  'heading',
  'paragraph',
  'list_item',
  'quote',
  'code',
  'table',
  'horizontal_rule',
]);

function parseIntegrity(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DocumentParseIntegrityError(message);
}

function exactParseKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  parseIntegrity(
    actual.length === keys.length && actual.every((key, index) => key === keys[index]),
    `${field} has invalid fields`,
  );
}

function parseRecord(value: unknown, field: string): Readonly<Record<string, unknown>> {
  parseIntegrity(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${field} must be an object`,
  );
  return value as Readonly<Record<string, unknown>>;
}

function parseNonEmpty(value: unknown, field: string): string {
  parseIntegrity(typeof value === 'string' && value.trim() !== '', `${field} must be non-empty`);
  return value;
}

function parseSha256(value: unknown, field: string): string {
  parseIntegrity(
    typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
    `${field} must be a SHA-256 digest`,
  );
  return value;
}

export function parseJson(value: unknown, field: string): JsonValue {
  let canonical: string;
  try {
    canonical = canonicalize(value);
  } catch (error: unknown) {
    throw new DocumentParseIntegrityError(
      `${field} is not canonical JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return JSON.parse(canonical) as JsonValue;
}

/**
 * Recompute every parser-authored digest from exact source bytes and retained preimages.
 * Parser implementations are untrusted at this boundary; only this normalized receipt persists.
 */
export function validateParsedDocument(value: ParsedDocument, sourceBytes: Buffer): ParsedDocument {
  const parsed = parseRecord(value, 'parsed document');
  exactParseKeys(
    parsed,
    [
      'parser',
      'parserVersion',
      'projectionContract',
      'sourceDigest',
      'atoms',
      'conversionLoss',
      'lossDigest',
      'contentDigest',
    ],
    'parsed document',
  );
  const sourceDigest = parseSha256(parsed['sourceDigest'], 'source digest');
  parseIntegrity(
    digestBytes(sourceBytes) === sourceDigest,
    'source digest does not match exact parser bytes',
  );
  parseIntegrity(Array.isArray(parsed['atoms']), 'atoms must be an array');
  const atoms = parsed['atoms'].map((raw, index): DocumentAtom => {
    const atom = parseRecord(raw, `atom ${String(index + 1)}`);
    exactParseKeys(
      atom,
      ['ordinal', 'kind', 'level', 'text', 'attributes', 'digest'],
      `atom ${String(index + 1)}`,
    );
    parseIntegrity(atom['ordinal'] === index + 1, 'atom ordinals must be contiguous and one-based');
    parseIntegrity(
      typeof atom['kind'] === 'string' && DOCUMENT_ATOM_KINDS.has(atom['kind'] as DocumentAtomKind),
      `atom ${String(index + 1)} kind is invalid`,
    );
    parseIntegrity(
      atom['level'] === null ||
        (typeof atom['level'] === 'number' &&
          Number.isInteger(atom['level']) &&
          atom['level'] >= 1 &&
          atom['level'] <= 9),
      `atom ${String(index + 1)} level is invalid`,
    );
    parseIntegrity(
      typeof atom['text'] === 'string',
      `atom ${String(index + 1)} text must be a string`,
    );
    const attributes = parseRecord(atom['attributes'], `atom ${String(index + 1)} attributes`);
    const claim = {
      ordinal: atom['ordinal'],
      kind: atom['kind'] as DocumentAtomKind,
      level: atom['level'] as number | null,
      text: atom['text'],
      attributes: parseJson(attributes, `atom ${String(index + 1)} attributes`) as Readonly<
        Record<string, JsonValue>
      >,
    };
    const atomDigest = parseSha256(atom['digest'], `atom ${String(index + 1)} digest`);
    parseIntegrity(
      documentAtomDigest(claim) === atomDigest,
      `atom digest mismatch at ordinal ${String(index + 1)}`,
    );
    return Object.freeze({ ...claim, digest: atomDigest });
  });
  parseIntegrity(Array.isArray(parsed['conversionLoss']), 'conversionLoss must be an array');
  const conversionLoss = parsed['conversionLoss'].map((raw, index): DocumentParseLoss => {
    const loss = parseRecord(raw, `conversion loss ${String(index + 1)}`);
    exactParseKeys(
      loss,
      ['code', 'path', 'message', 'source', 'sourceDigest'],
      `conversion loss ${String(index + 1)}`,
    );
    const source = parseJson(loss['source'], `conversion loss ${String(index + 1)} source`);
    const sourceDigestClaim = parseSha256(
      loss['sourceDigest'],
      `conversion loss ${String(index + 1)} source digest`,
    );
    parseIntegrity(
      documentLossSourceDigest(source) === sourceDigestClaim,
      `conversion loss source digest mismatch at index ${String(index)}`,
    );
    return Object.freeze({
      code: parseNonEmpty(loss['code'], `conversion loss ${String(index + 1)} code`),
      path: parseNonEmpty(loss['path'], `conversion loss ${String(index + 1)} path`),
      message: parseNonEmpty(loss['message'], `conversion loss ${String(index + 1)} message`),
      source,
      sourceDigest: sourceDigestClaim,
    });
  });
  const lossDigest = parseSha256(parsed['lossDigest'], 'loss digest');
  parseIntegrity(
    documentConversionLossDigest(conversionLoss) === lossDigest,
    'loss digest does not match conversion-loss preimages',
  );
  const projectionContract = parseNonEmpty(parsed['projectionContract'], 'projectionContract');
  const atomClaims = atoms.map(({ digest: _digest, ...claim }) => claim);
  const contentDigest = parseSha256(parsed['contentDigest'], 'projection digest');
  parseIntegrity(
    documentProjectionDigest(projectionContract, atomClaims, conversionLoss) === contentDigest,
    'projection digest does not match parser receipt preimages',
  );
  return Object.freeze({
    parser: parseNonEmpty(parsed['parser'], 'parser'),
    parserVersion: parseNonEmpty(parsed['parserVersion'], 'parserVersion'),
    projectionContract,
    sourceDigest,
    atoms: Object.freeze(atoms),
    conversionLoss: Object.freeze(conversionLoss),
    lossDigest,
    contentDigest,
  });
}
