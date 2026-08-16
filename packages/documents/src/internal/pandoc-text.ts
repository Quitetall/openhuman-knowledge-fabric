import { digest, type JsonValue } from '@kf/canonicalization';
import {
  parseJson,
  type DocumentAtom,
  type DocumentAtomKind,
  type DocumentParseLoss,
} from './parse-contract.js';
import type { PandocNode } from './pandoc-types.js';

export function node(value: unknown): PandocNode | undefined {
  return typeof value === 'object' && value !== null ? (value as PandocNode) : undefined;
}

export function inlineText(value: unknown): string {
  if (Array.isArray(value)) return value.map(inlineText).join('');
  const item = node(value);
  if (item === undefined || typeof item.t !== 'string') return '';
  if (item.t === 'Space' || item.t === 'SoftBreak') return ' ';
  if (item.t === 'LineBreak') return '\n';
  if (item.t === 'Str' && typeof item.c === 'string') return item.c;
  if ((item.t === 'Code' || item.t === 'Math') && Array.isArray(item.c)) {
    const text = item.c.at(-1);
    return typeof text === 'string' ? text : '';
  }
  if (item.t === 'RawInline' && Array.isArray(item.c)) {
    return typeof item.c[1] === 'string' ? item.c[1] : '';
  }
  if (Array.isArray(item.c)) return inlineText(item.c);
  return typeof item.c === 'string' ? item.c : '';
}

export function normalized(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

export function blockText(value: unknown): string {
  if (Array.isArray(value)) return normalized(value.map(blockText).filter(Boolean).join(' '));
  const item = node(value);
  if (item === undefined) return '';
  if (item.t === 'Para' || item.t === 'Plain' || item.t === 'Header') {
    const content = item.t === 'Header' && Array.isArray(item.c) ? item.c[2] : item.c;
    return normalized(inlineText(content));
  }
  if (item.t === 'CodeBlock' && Array.isArray(item.c)) {
    return typeof item.c[1] === 'string' ? item.c[1] : '';
  }
  return Array.isArray(item.c) ? blockText(item.c) : normalized(inlineText(item.c));
}

export function createAtom(
  atoms: DocumentAtom[],
  kind: DocumentAtomKind,
  text: string,
  level: number | null = null,
  attributes: Readonly<Record<string, JsonValue>> = {},
): void {
  const ordinal = atoms.length + 1;
  const claim = { ordinal, kind, level, text: normalized(text), attributes };
  atoms.push({ ...claim, digest: digest(claim) });
}

export function parseLoss(
  losses: DocumentParseLoss[],
  code: string,
  path: string,
  message: string,
  source: unknown,
): void {
  const sourceValue = parseJson(source, `conversion loss ${path} source`);
  losses.push({ code, path, message, source: sourceValue, sourceDigest: digest(sourceValue) });
}

const TRANSPARENT_INLINE_TYPES = new Set(['Str', 'Space', 'SoftBreak', 'LineBreak']);
const FORMATTED_INLINE_TYPES = new Set([
  'Emph',
  'Underline',
  'Strong',
  'Strikeout',
  'Superscript',
  'Subscript',
  'SmallCaps',
  'Quoted',
  'Cite',
  'Link',
  'Image',
  'Note',
  'Span',
  'Code',
  'Math',
  'RawInline',
]);
const PANDOC_BLOCK_TYPES = new Set([
  'Header',
  'Para',
  'Plain',
  'BulletList',
  'OrderedList',
  'BlockQuote',
  'CodeBlock',
  'Table',
  'HorizontalRule',
  'Div',
  'Figure',
  'RawBlock',
]);

export function inspectInlines(value: unknown, losses: DocumentParseLoss[], path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectInlines(item, losses, `${path}/${String(index)}`));
    return;
  }
  const item = node(value);
  if (item === undefined || typeof item.t !== 'string') return;
  if (PANDOC_BLOCK_TYPES.has(item.t)) {
    if (Array.isArray(item.c)) inspectInlines(item.c, losses, `${path}/c`);
    return;
  }
  if (FORMATTED_INLINE_TYPES.has(item.t)) {
    parseLoss(
      losses,
      'pandoc_inline_projection',
      path,
      `Pandoc ${item.t} metadata or formatting was flattened into atom text`,
      item,
    );
  } else if (!TRANSPARENT_INLINE_TYPES.has(item.t)) {
    parseLoss(
      losses,
      'unsupported_pandoc_inline',
      path,
      `Pandoc inline type ${item.t} has no lossless atom representation`,
      item,
    );
  }
  if (Array.isArray(item.c)) inspectInlines(item.c, losses, `${path}/c`);
}

export function nonEmptyPandocAttr(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    ((typeof value[0] === 'string' && value[0] !== '') ||
      (Array.isArray(value[1]) && value[1].length > 0) ||
      (Array.isArray(value[2]) && value[2].length > 0))
  );
}
