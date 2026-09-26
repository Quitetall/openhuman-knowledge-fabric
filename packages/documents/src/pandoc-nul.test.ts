import { describe, expect, it } from 'vitest';
import { digestOf } from '@kf/artifacts';
import { projectionFromPandoc } from './internal/pandoc-projection.js';
import { replaceNulCharacters } from './internal/pandoc-nul.js';
import {
  documentConversionLossDigest,
  documentProjectionDigest,
  DocumentParseIntegrityError,
  validateParsedDocument,
} from './internal/parse-contract.js';

/**
 * NUL in a parse (§52.1): replaced by U+FFFD and recorded, never stored and never dropped silently.
 * The database side (a NUL-bearing source is attached) is tests/database/document-parse-nul.test.ts.
 */

const NUL = '\u0000';

/** Put back what a claim says was replaced: the recorded runs, over the kept string. */
function restore(kept: string, ranges: readonly (readonly [number, number])[]): string {
  const characters = [...kept];
  for (const [start, length] of ranges) {
    for (let i = start; i < start + length; i += 1) characters[i] = NUL;
  }
  return characters.join('');
}

describe('replacing NUL in a pandoc parse', () => {
  it('records each string’s runs so the original is exact, a genuine U+FFFD included', () => {
    const original = `a${NUL}${NUL}b�c${NUL}\u{1F600}${NUL}`;
    const { document, losses } = replaceNulCharacters({
      blocks: [{ t: 'Para', c: [{ t: 'Str', c: original }] }],
      meta: { [`k${NUL}`]: { t: 'MetaString', c: 'v' } },
    });
    const kept = (document.blocks as { c: { c: string }[] }[])[0]!.c[0]!.c;
    expect(kept).toBe('a��b�c�\u{1F600}�');
    expect(losses).toHaveLength(2);
    const [inBlock, inKey] = losses;
    expect(inBlock).toMatchObject({
      code: 'nul_character_replaced',
      path: '/blocks/0/c/0/c',
      source: {
        replacement: 'U+FFFD',
        ranges: [
          [1, 2],
          [6, 1],
          [8, 1],
        ],
      },
    });
    const ranges = (inBlock!.source as { ranges: [number, number][] }).ranges;
    expect(restore(kept, ranges)).toBe(original);
    expect(inKey).toMatchObject({ path: '/meta/k�', source: { key: true, ranges: [[1, 1]] } });
    expect(JSON.stringify(losses)).not.toContain('\\u0000');
  });

  it('leaves a parse without NUL exactly as it was, and adds no loss', () => {
    const source = { blocks: [{ t: 'Para', c: [{ t: 'Str', c: 'a literal \\u0000 escape' }] }] };
    // A literal "\u0000" escape in the text costs a walk that finds nothing.
    const { document, losses } = replaceNulCharacters(source);
    expect(document).toEqual(source);
    expect(losses).toEqual([]);
    const plain = { blocks: [{ t: 'Para', c: [{ t: 'Str', c: 'plain' }] }] };
    expect(replaceNulCharacters(plain).document).toBe(plain);
  });

  it('is applied by the projection, so atoms and losses carry no NUL', () => {
    const { atoms, conversionLoss } = projectionFromPandoc({
      blocks: [{ t: 'Para', c: [{ t: 'Str', c: `x${NUL}y` }] }],
    });
    expect(atoms.map((atom) => atom.text)).toEqual(['x�y']);
    expect(conversionLoss.map((loss) => loss.code)).toEqual(['nul_character_replaced']);
  });

  it('refuses, as an integrity error, a parser that hands a NUL on', () => {
    const bytes = Buffer.from(`x${NUL}y`);
    const atoms = [
      { ordinal: 1, kind: 'paragraph' as const, level: null, text: `x${NUL}y`, attributes: {} },
    ];
    const parsed = {
      parser: 'test',
      parserVersion: '1',
      projectionContract: 'test.v1',
      sourceDigest: digestOf(bytes),
      atoms: atoms.map((atom) => ({ ...atom, digest: '0'.repeat(64) })),
      conversionLoss: [],
      lossDigest: documentConversionLossDigest([]),
      contentDigest: documentProjectionDigest('test.v1', atoms, []),
    };
    expect(() => validateParsedDocument(parsed, bytes)).toThrow(DocumentParseIntegrityError);
    expect(() => validateParsedDocument(parsed, bytes)).toThrow(/NUL/u);
  });
});
