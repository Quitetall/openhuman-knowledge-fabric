import { digest, type JsonValue } from '@kf/canonicalization';
import { type DocumentAtom, type DocumentParseLoss } from './parse-contract.js';
import {
  blockText,
  createAtom,
  inlineText,
  inspectInlines,
  node,
  nonEmptyPandocAttr,
  parseLoss,
} from './pandoc-text.js';
import type { PandocDocument } from './pandoc-types.js';

function walkBlocks(
  blocks: unknown,
  atoms: DocumentAtom[],
  losses: DocumentParseLoss[] = [],
  listDepth = 0,
  path = '/blocks',
): void {
  if (!Array.isArray(blocks)) return;
  for (const [index, raw] of blocks.entries()) {
    const blockPath = `${path}/${String(index)}`;
    const block = node(raw);
    if (block === undefined || typeof block.t !== 'string') {
      parseLoss(
        losses,
        'malformed_pandoc_block',
        blockPath,
        'Pandoc block is not a tagged node',
        raw,
      );
      continue;
    }
    if (block.t === 'Header' && Array.isArray(block.c)) {
      if (nonEmptyPandocAttr(block.c[1])) {
        parseLoss(
          losses,
          'pandoc_block_attributes_omitted',
          `${blockPath}/c/1`,
          'Header identifier, classes, or key-value attributes are not represented by atom fields',
          block.c[1],
        );
      }
      inspectInlines(block.c[2], losses, `${blockPath}/c/2`);
      createAtom(
        atoms,
        'heading',
        inlineText(block.c[2]),
        typeof block.c[0] === 'number' ? block.c[0] : 1,
      );
    } else if (block.t === 'Para' || block.t === 'Plain') {
      inspectInlines(block.c, losses, `${blockPath}/c`);
      createAtom(atoms, 'paragraph', inlineText(block.c));
    } else if (block.t === 'BulletList' && Array.isArray(block.c)) {
      for (const [itemIndex, item] of block.c.entries()) {
        inspectInlines(item, losses, `${blockPath}/c/${String(itemIndex)}`);
        createAtom(atoms, 'list_item', blockText(item), listDepth + 1, { list: 'bullet' });
      }
    } else if (block.t === 'OrderedList' && Array.isArray(block.c)) {
      const items = Array.isArray(block.c[1]) ? block.c[1] : [];
      const listAttributes = Array.isArray(block.c[0]) ? block.c[0] : [];
      let order = typeof listAttributes[0] === 'number' ? listAttributes[0] : 1;
      if (listAttributes.length > 1) {
        parseLoss(
          losses,
          'pandoc_ordered_list_style_omitted',
          `${blockPath}/c/0`,
          'Ordered-list style and delimiter are not represented by atom fields',
          listAttributes,
        );
      }
      for (const [itemIndex, item] of items.entries()) {
        inspectInlines(item, losses, `${blockPath}/c/1/${String(itemIndex)}`);
        createAtom(atoms, 'list_item', blockText(item), listDepth + 1, {
          list: 'ordered',
          order: order++,
        });
      }
    } else if (block.t === 'BlockQuote') {
      parseLoss(
        losses,
        'pandoc_block_structure_flattened',
        blockPath,
        'BlockQuote child block boundaries were flattened into one atom',
        block,
      );
      createAtom(atoms, 'quote', blockText(block.c));
    } else if (block.t === 'CodeBlock') {
      if (Array.isArray(block.c) && nonEmptyPandocAttr(block.c[0])) {
        parseLoss(
          losses,
          'pandoc_block_attributes_omitted',
          `${blockPath}/c/0`,
          'Code-block identifier, classes, or key-value attributes are not represented by atom fields',
          block.c[0],
        );
      }
      createAtom(atoms, 'code', blockText(block));
    } else if (block.t === 'Table') {
      parseLoss(
        losses,
        'pandoc_table_structure_flattened',
        blockPath,
        'Pandoc table structure was flattened into atom text',
        block,
      );
      createAtom(atoms, 'table', blockText(block.c), null, { source: 'pandoc-table' });
    } else if (block.t === 'HorizontalRule') {
      createAtom(atoms, 'horizontal_rule', '');
    } else if (block.t === 'Div' && Array.isArray(block.c)) {
      if (nonEmptyPandocAttr(block.c[0])) {
        parseLoss(
          losses,
          'pandoc_block_attributes_omitted',
          `${blockPath}/c/0`,
          'Div identifier, classes, or key-value attributes are not represented by atom fields',
          block.c[0],
        );
      }
      walkBlocks(block.c[1], atoms, losses, listDepth, `${blockPath}/c/1`);
    } else if (block.t === 'Figure' && Array.isArray(block.c)) {
      // Pandoc Figure is [Attr, Caption, Blocks]. Body is explicit index 2; caption is
      // metadata around it and should not replace the document content being composed.
      if (nonEmptyPandocAttr(block.c[0])) {
        parseLoss(
          losses,
          'pandoc_block_attributes_omitted',
          `${blockPath}/c/0`,
          'Figure identifier, classes, or key-value attributes are not represented by atom fields',
          block.c[0],
        );
      }
      if (Array.isArray(block.c[1]) && blockText(block.c[1]) !== '') {
        parseLoss(
          losses,
          'pandoc_figure_caption_omitted',
          `${blockPath}/c/1`,
          'Figure caption is not represented by emitted body atoms',
          block.c[1],
        );
      }
      walkBlocks(block.c[2], atoms, losses, listDepth, `${blockPath}/c/2`);
    } else if (block.t === 'RawBlock') {
      const rawFormat = Array.isArray(block.c) && typeof block.c[0] === 'string' ? block.c[0] : '';
      const text = Array.isArray(block.c) && typeof block.c[1] === 'string' ? block.c[1] : '';
      if (text !== '') {
        createAtom(atoms, 'paragraph', text, null, { source: 'raw-block', format: rawFormat });
      }
    } else {
      parseLoss(
        losses,
        'unsupported_pandoc_block',
        blockPath,
        `Pandoc block type ${block.t} has no atom representation`,
        block,
      );
    }
  }
}

export function atomsFromPandoc(document: PandocDocument): DocumentAtom[] {
  const atoms: DocumentAtom[] = [];
  walkBlocks(document.blocks, atoms);
  return atoms;
}

export function projectionFromPandoc(document: PandocDocument): {
  readonly atoms: readonly DocumentAtom[];
  readonly conversionLoss: readonly DocumentParseLoss[];
} {
  const atoms: DocumentAtom[] = [];
  const conversionLoss: DocumentParseLoss[] = [];
  if (document.meta !== undefined && digest(document.meta as JsonValue) !== digest({})) {
    parseLoss(
      conversionLoss,
      'pandoc_metadata_omitted',
      '/meta',
      'Pandoc document metadata is not represented by atom fields',
      document.meta,
    );
  }
  walkBlocks(document.blocks, atoms, conversionLoss);
  return { atoms: Object.freeze(atoms), conversionLoss: Object.freeze(conversionLoss) };
}
