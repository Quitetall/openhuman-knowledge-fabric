/**
 * Parse before the transaction; use the parse inside it only if it is bound to the exact bytes.
 *
 * `attach_evidence` used to run pandoc inside the act's database transaction. pandoc is bounded
 * (a deadline, a heap ceiling), but for as long as it runs the transaction holds a pooled
 * connection and the rows the act already locked; thirty seconds of a hostile source was thirty
 * seconds of that. So every caller that has the bytes in hand — `POST /ingest`,
 * `POST /documents`, `kf ingest` — parses them BEFORE it opens the transaction, and the effect
 * inside it only checks and uses the result.
 *
 * What makes that safe:
 *
 *   IN-PROCESS ONLY  A pre-parse reaches the effect through an AsyncLocalStorage scope that the
 *                    caller opens around its transaction, never through the act's payload. An
 *                    HTTP body cannot name one, and nothing reads one from JSON.
 *   UNFORGEABLE      Only {@link preparseDocument} makes one; it is recorded in a module-private
 *                    WeakSet, and {@link withPreparsedDocuments} refuses any object that is not
 *                    in it. A look-alike built by other code is refused, not trusted.
 *   BOUND TO BYTES   The effect digests the bytes IT read from the store (after verifyUpload)
 *                    and uses a pre-parse only if that digest and media type are the ones the
 *                    parse was computed over. Inside a scope, no match is a refusal: the caller
 *                    promised a pre-parse, and parsing in the transaction anyway would bring back
 *                    exactly what this exists to remove. The parse result is also re-validated
 *                    against those bytes, as any parser output is.
 *   FALLBACK         With no scope open (the generic `/actions` route, dogfood loaders, an
 *                    older caller), the effect parses in the transaction as before.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { digestBytes } from '@kf/canonicalization';
import {
  DocumentParseIntegrityError,
  validateParsedDocument,
  type DocumentParser,
  type ParsedDocument,
} from './parse-contract.js';

export interface PreparsedDocument {
  /** SHA-256 of the exact bytes handed to the parser. */
  readonly sourceDigest: string;
  readonly mediaType: string;
  /** Undefined when the parser declines the media type (nothing to persist). */
  readonly parsed: ParsedDocument | undefined;
}

const minted = new WeakSet<PreparsedDocument>();
const scope = new AsyncLocalStorage<readonly PreparsedDocument[]>();

/**
 * Parse `bytes` now, outside any transaction. A refusal (`DocumentParseRefused`) propagates, so
 * a caller that pre-parses before storing the bytes refuses the source before a byte is stored.
 */
export async function preparseDocument(
  parser: DocumentParser,
  bytes: Buffer,
  mediaType: string,
): Promise<PreparsedDocument> {
  // The digest is taken over a private copy, and the parser is handed that same copy, so a
  // caller mutating its buffer mid-parse cannot make the digest describe other bytes.
  const copy = Buffer.from(bytes);
  const result = await parser.parse(copy, mediaType);
  const preparsed: PreparsedDocument = Object.freeze({
    sourceDigest: digestBytes(copy),
    mediaType,
    parsed: result === undefined ? undefined : validateParsedDocument(result, copy),
  });
  minted.add(preparsed);
  return preparsed;
}

/**
 * Run `fn` — the caller's transaction — with these pre-parses available to the effects inside
 * it. `undefined` or an empty list runs `fn` with no scope, which keeps the in-transaction parse.
 */
export function withPreparsedDocuments<T>(
  preparsed: readonly PreparsedDocument[] | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (preparsed === undefined || preparsed.length === 0) return fn();
  for (const document of preparsed) {
    if (!minted.has(document)) {
      return Promise.reject(
        new DocumentParseIntegrityError('a pre-parse must come from preparseDocument'),
      );
    }
  }
  return scope.run(Object.freeze([...preparsed]), fn);
}

/** The pre-parses in scope for the current async context, if a caller opened one. */
export function activePreparsedDocuments(): readonly PreparsedDocument[] | undefined {
  return scope.getStore();
}

/**
 * For the effect: the pre-parse bound to `sourceBytes`, `undefined` when no scope is open (so
 * the effect parses as before), and a refusal when a scope is open but nothing in it was
 * computed over these exact bytes.
 */
export function boundPreparse(
  sourceBytes: Buffer,
  mediaType: string,
): { readonly parsed: ParsedDocument | undefined } | undefined {
  const inScope = scope.getStore();
  if (inScope === undefined) return undefined;
  const sourceDigest = digestBytes(sourceBytes);
  const match = inScope.find(
    (document) => document.sourceDigest === sourceDigest && document.mediaType === mediaType,
  );
  if (match === undefined) {
    throw new DocumentParseIntegrityError(
      'a pre-parse was supplied, but none was computed over the exact bytes this act verified',
    );
  }
  return {
    parsed:
      match.parsed === undefined ? undefined : validateParsedDocument(match.parsed, sourceBytes),
  };
}
