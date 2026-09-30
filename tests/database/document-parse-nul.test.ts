import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryObjectStore, digestOf } from '@kf/artifacts';
import { withTransaction } from '@kf/database';
import { createDocumentActionAtoms, PandocDocumentParser } from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
import { bindReader, seedFixtures, startHarness, type Fixtures, type Harness } from './harness.js';

/**
 * A source holding NUL characters is stored, with the replacement recorded as conversion loss.
 *
 * PostgreSQL holds no NUL in text or jsonb. Some readers pass it through; GFM in pandoc 3.11
 * replaces it before emitting the AST. KF records the UTF-8 source replacement before parsing,
 * naming original byte ranges, while preserving the stored source and its digest (§52.1).
 * The AST sanitizer independently guards binary readers and imported ASTs. Real pandoc and DB.
 */

let harness: Harness;
let fixtures: Fixtures;
const store = new InMemoryObjectStore();

beforeAll(async () => {
  harness = await startHarness();
  fixtures = await seedFixtures(harness.adminPool);
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

describe('a source with NUL characters', () => {
  it('is attached, its atoms carry U+FFFD, and the replacement is a recorded loss', async () => {
    const bytes = Buffer.from(
      '# Kick\u0000off\n\nThread \u0000\u0000 text `co\u0000de`.\n',
      'utf8',
    );
    const sha256 = digestOf(bytes);
    const key = `ingest/${fixtures.organizationId}/${sha256}`;
    await store.put(key, bytes, 'text/markdown');
    const execute = createFabricDispatcher(
      harness.pool,
      createDocumentActionAtoms({ store, parser: new PandocDocumentParser() }),
    );
    const result = await execute({
      actionType: 'attach_evidence',
      actorId: fixtures.reviewerId,
      actingRoleId: fixtures.reviewerRoleId,
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      targetIds: [],
      idempotencyKey: 'nul-thread-0001',
      payload: {
        title: 'thread-with-nul.md',
        artifact_kind: 'message_snapshot',
        sha256,
        size_bytes: bytes.length,
        media_type: 'text/markdown',
        storage_uri: key,
      },
    });
    expect(result.status).toBe('applied');

    const { atoms, losses } = await withTransaction(harness.pool, async (tx) => {
      await bindReader(tx, fixtures, fixtures.reviewerId);
      const parse = await tx.one<{
        id: string;
        conversion_loss: { code: string; path: string; source: unknown }[];
      }>(
        `select p.id, p.conversion_loss
           from content.document_parse p
           join content.artifact_version v on v.id = p.artifact_version_id
          where v.artifact_id = $1`,
        [result.objectIds[0]],
      );
      const rows = await tx.query<{ text_content: string }>(
        'select text_content from content.document_atom where parse_id = $1 order by ordinal',
        [parse.id],
      );
      return { atoms: rows.map((row) => row.text_content), losses: parse.conversion_loss };
    });
    expect(atoms).toEqual(['Kick�off', 'Thread �� text co�de.']);
    const replaced = losses.filter((loss) => loss.code === 'nul_character_replaced');
    // One source-level claim survives even when pandoc itself never emits a NUL-bearing AST.
    expect(replaced.map((loss) => loss.source)).toEqual([
      {
        replacement: 'U+FFFD',
        encoding: 'utf-8',
        offsetUnit: 'byte',
        ranges: [
          [6, 1],
          [19, 2],
          [30, 1],
        ],
      },
    ]);
    expect(replaced.map((loss) => loss.path)).toEqual(['/source']);
  });
});
