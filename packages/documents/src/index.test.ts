import { describe, expect, it } from 'vitest';
import { artifactKindForDocumentClass, atomsFromPandoc } from './index.js';

describe('document atoms', () => {
  it('maps document classes onto valid evidence-vault kinds', () => {
    expect(artifactKindForDocumentClass('specification')).toBe('specification');
    expect(artifactKindForDocumentClass('report')).toBe('report');
    expect(artifactKindForDocumentClass('record')).toBe('other');
  });

  it('turns one document into ordered, independently hashed atoms', () => {
    const atoms = atomsFromPandoc({
      'pandoc-api-version': [1, 23, 1],
      meta: {},
      blocks: [
        { t: 'Header', c: [1, ['scope', [], []], [{ t: 'Str', c: 'Scope' }]] },
        {
          t: 'Para',
          c: [
            { t: 'Str', c: 'One' },
            { t: 'Space' },
            { t: 'Strong', c: [{ t: 'Str', c: 'fact' }] },
            { t: 'Space' },
            { t: 'Str', c: 'once.' },
          ],
        },
        {
          t: 'BulletList',
          c: [
            [{ t: 'Plain', c: [{ t: 'Str', c: 'Auditable' }] }],
            [{ t: 'Plain', c: [{ t: 'Str', c: 'Reusable' }] }],
          ],
        },
      ],
    });

    expect(atoms.map(({ ordinal, kind, level, text }) => ({ ordinal, kind, level, text }))).toEqual(
      [
        { ordinal: 1, kind: 'heading', level: 1, text: 'Scope' },
        { ordinal: 2, kind: 'paragraph', level: null, text: 'One fact once.' },
        { ordinal: 3, kind: 'list_item', level: 1, text: 'Auditable' },
        { ordinal: 4, kind: 'list_item', level: 1, text: 'Reusable' },
      ],
    );
    expect(atoms.every((atom) => /^[0-9a-f]{64}$/.test(atom.digest))).toBe(true);
    expect(new Set(atoms.map((atom) => atom.digest)).size).toBe(atoms.length);
  });
});
