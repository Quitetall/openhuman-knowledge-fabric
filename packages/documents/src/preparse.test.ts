import { describe, expect, it, vi } from 'vitest';
import { digestBytes } from '@kf/canonicalization';
import { DocumentParseIntegrityError, type DocumentParser } from './internal/parse-contract.js';
import {
  boundPreparse,
  preparseDocument,
  withPreparsedDocuments,
  type PreparsedDocument,
} from './internal/preparse.js';

const BYTES = Buffer.from('# Title\n');
const OTHER = Buffer.from('# Other title\n');

/** A parser that declines every source: the smallest honest parse there is. */
const declining: DocumentParser = { parse: vi.fn(async () => undefined) };

describe('a pre-parse is bound to its bytes and cannot be forged', () => {
  it('is used for the exact bytes and media type it was computed over', async () => {
    const preparsed = await preparseDocument(declining, BYTES, 'text/markdown');
    expect(preparsed.sourceDigest).toBe(digestBytes(BYTES));
    await withPreparsedDocuments([preparsed], async () => {
      expect(boundPreparse(Buffer.from(BYTES), 'text/markdown')).toEqual({ parsed: undefined });
    });
  });

  it('refuses, inside a scope, bytes no pre-parse was computed over', async () => {
    const preparsed = await preparseDocument(declining, BYTES, 'text/markdown');
    await withPreparsedDocuments([preparsed], async () => {
      expect(() => boundPreparse(OTHER, 'text/markdown')).toThrow(DocumentParseIntegrityError);
      expect(() => boundPreparse(BYTES, 'text/plain')).toThrow(/exact bytes/);
    });
  });

  it('leaves the in-transaction parse in place when no scope is open', () => {
    expect(boundPreparse(BYTES, 'text/markdown')).toBeUndefined();
  });

  it('refuses a look-alike that preparseDocument did not make', async () => {
    const forged: PreparsedDocument = Object.freeze({
      sourceDigest: digestBytes(OTHER),
      mediaType: 'text/markdown',
      parsed: undefined,
    });
    await expect(withPreparsedDocuments([forged], async () => 'ran')).rejects.toThrow(
      /must come from preparseDocument/,
    );
  });

  it('digests the bytes the parser was handed, not a buffer the caller changes afterwards', async () => {
    const mutable = Buffer.from(BYTES);
    const parser: DocumentParser = {
      async parse() {
        mutable.fill(0x41);
        return undefined;
      },
    };
    const preparsed = await preparseDocument(parser, mutable, 'text/markdown');
    expect(preparsed.sourceDigest).toBe(digestBytes(BYTES));
  });
});
