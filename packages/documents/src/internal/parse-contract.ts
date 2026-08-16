import { canonicalize, digest, digestBytes, type JsonValue } from '@kf/canonicalization';

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

export class DocumentParseIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentParseIntegrityError';
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
      digest(claim) === atomDigest,
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
      digest(source) === sourceDigestClaim,
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
    digest(conversionLoss) === lossDigest,
    'loss digest does not match conversion-loss preimages',
  );
  const projectionContract = parseNonEmpty(parsed['projectionContract'], 'projectionContract');
  const atomClaims = atoms.map(({ digest: _digest, ...claim }) => claim);
  const contentDigest = parseSha256(parsed['contentDigest'], 'projection digest');
  parseIntegrity(
    digest({ projectionContract, atoms: atomClaims, conversionLoss }) === contentDigest,
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
