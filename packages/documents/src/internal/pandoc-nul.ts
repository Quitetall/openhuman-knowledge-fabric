import type { DocumentParseLoss } from './parse-contract.js';
import { parseLoss } from './pandoc-text.js';
import type { PandocDocument } from './pandoc-types.js';

/** What stands in for a NUL character in a parse: the Unicode replacement character. */
export const NUL_REPLACEMENT = '�';
export const NUL_REPLACED_LOSS_CODE = 'nul_character_replaced';

/** A run of replaced characters: `[start, length]` in code points of the string as recorded. */
type Range = readonly [number, number];

/** The code-point runs of U+0000 in `value`, or an empty list. */
function nulRanges(value: string): Range[] {
  const ranges: [number, number][] = [];
  let index = 0;
  for (const character of value) {
    if (character === '\u0000') {
      const last = ranges.at(-1);
      if (last !== undefined && last[0] + last[1] === index) last[1] += 1;
      else ranges.push([index, 1]);
    }
    index += 1;
  }
  return ranges;
}

/** RFC 6901: `~` as `~0`, `/` as `~1`. */
function pointerToken(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

/**
 * The parse with every U+0000 replaced by U+FFFD, and one conversion-loss claim per string that
 * held any (§52.1: conversion loss is recorded, not discarded).
 *
 * A NUL is not text PostgreSQL can hold, in `text` or in `jsonb`, so a parse that carried one could
 * not be stored at all: the receipt's preimages were refused ("document parse preimage is not valid
 * JSON") and the ingest answered 500. Refusing the source instead would keep out a whole document
 * for a character nobody reads; replacing it silently would make the atoms claim text the source
 * does not contain. So it is replaced and the replacement is recorded where every other loss is.
 *
 * Each claim's `path` is the JSON pointer of the string in pandoc's output, and its `source` the
 * code-point runs that were NUL — `{ replacement: 'U+FFFD', ranges: [[start, length], …] }`, or
 * with `key: true` when the string was an object key. With the replaced string, which the parse
 * keeps, that is the exact original: a genuine U+FFFD in the source is not in a recorded run. The
 * claim cannot carry the original value itself, as other losses do, because that value is what
 * cannot be stored.
 */
export function replaceNulCharacters(document: PandocDocument): {
  readonly document: PandocDocument;
  readonly losses: readonly DocumentParseLoss[];
} {
  const losses: DocumentParseLoss[] = [];
  const record = (path: string, ranges: readonly Range[], key: boolean): void => {
    parseLoss(
      losses,
      NUL_REPLACED_LOSS_CODE,
      path === '' ? '/' : path,
      'U+0000 cannot be stored as text; each was replaced by U+FFFD at the recorded code-point ranges',
      { replacement: 'U+FFFD', ranges: ranges.map((range) => [...range]), ...(key ? { key } : {}) },
    );
  };
  const clean = (value: unknown, path: string): unknown => {
    if (typeof value === 'string') {
      const ranges = nulRanges(value);
      if (ranges.length === 0) return value;
      record(path, ranges, false);
      return value.replaceAll('\u0000', NUL_REPLACEMENT);
    }
    if (Array.isArray(value)) {
      return value.map((item, index) => clean(item, `${path}/${String(index)}`));
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [rawKey, item] of Object.entries(value)) {
        const ranges = nulRanges(rawKey);
        const key = ranges.length === 0 ? rawKey : rawKey.replaceAll('\u0000', NUL_REPLACEMENT);
        const itemPath = `${path}/${pointerToken(key)}`;
        if (ranges.length > 0) record(itemPath, ranges, true);
        out[key] = clean(item, itemPath);
      }
      return out;
    }
    return value;
  };
  // Cheap and never wrong in the direction that matters: text holding a literal "\u0000" escape
  // only costs the walk, which then finds nothing.
  if (!JSON.stringify(document).includes('\\u0000')) return { document, losses };
  return { document: clean(document, '') as PandocDocument, losses };
}
