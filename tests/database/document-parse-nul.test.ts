import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryObjectStore, digestOf } from '@kf/artifacts';
import { withTransaction } from '@kf/database';
import { createDocumentActionAtoms, PandocDocumentParser } from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
import { bindReader, seedFixtures, startHarness, type Fixtures, type Harness } from './harness.js';

/**
 * A source holding NUL characters is stored, with the replacement recorded as conversion loss.
 *
 * PostgreSQL holds no NUL in text or jsonb. Pandoc hands a NUL through as `\u0000`, so the parse's
 * preimages were refused by the database ("document parse preimage is not valid JSON") and the
 * ingest answered 500: three Slack threads of the enterprise-rag-bench corpus never loaded. Now the
 * parser replaces each NUL with U+FFFD and records a `nul_character_replaced` loss naming the
 * string and the code-point runs, so the original is recoverable from the parse and nothing is
 * silently changed (§52.1). Real pandoc, real database.
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
    // One claim per pandoc string that held a NUL, each with its code-point runs.
    expect(replaced.map((loss) => loss.source)).toEqual(
      expect.arrayContaining([
        { replacement: 'U+FFFD', ranges: [[4, 1]] },
        { replacement: 'U+FFFD', ranges: [[0, 2]] },
        { replacement: 'U+FFFD', ranges: [[2, 1]] },
      ]),
    );
    expect(replaced.every((loss) => loss.path.startsWith('/blocks/'))).toBe(true);
  });
});
