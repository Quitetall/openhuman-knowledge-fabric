import { describe, expect, it, vi } from 'vitest';
import type { Tx } from '@kf/database';
import { getDocument } from './index.js';

describe('document readers', () => {
  it('exposes parsed syntax through ParsedBlock naming', async () => {
    const tx = {
      maybeOne: vi.fn(async () => ({
        id: 'document-1',
        title: 'Constitution',
        document_number: 'OH-DOC-001',
        revision: 'R01',
        document_class: 'policy',
        lifecycle_state: 'draft',
        row_version: '3',
        owning_role: 'technical_authority',
        content_version_id: 'artifact-version-1',
        media_type: 'text/markdown',
        sha256: 'a'.repeat(64),
        size_bytes: '42',
        parser: 'pandoc',
        parser_version: '3.8',
        projection_contract: 'kf.pandoc-atoms.v2',
        conversion_loss: [],
        content_digest: 'b'.repeat(64),
        parsed_block_count: '1',
        parse_id: 'parse-1',
      })),
      query: vi.fn(async () => [
        {
          ordinal: 1,
          atom_kind: 'heading',
          heading_level: 1,
          text_content: 'Authority',
          attributes: {},
          atom_digest: 'c'.repeat(64),
        },
      ]),
    } as unknown as Tx;

    const document = await getDocument(tx, 'document-1');

    expect(document).toMatchObject({
      parsedBlockCount: 1,
      parsedBlocks: [{ ordinal: 1, kind: 'heading', text: 'Authority' }],
    });
    expect(document).not.toHaveProperty('atomCount');
    expect(document).not.toHaveProperty('atoms');
  });
});
