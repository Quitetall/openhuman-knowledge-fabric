/** First dogfood seam: immutable bytes -> parsed atoms -> draft controlled document -> read. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryObjectStore, digestOf } from '@kf/artifacts';
import { digest } from '@kf/canonicalization';
import { setAccessContext, withTransaction } from '@kf/database';
import {
  atomsFromPandoc,
  createDocumentActionAtoms,
  getDocument,
  listDocuments,
  type DocumentParser,
} from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
import { seedFixtures, startHarness, type Fixtures, type Harness } from '../database/harness.js';

let harness: Harness;
let fixtures: Fixtures;

beforeAll(async () => {
  harness = await startHarness();
  fixtures = await seedFixtures(harness.adminPool);
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

describe('document constitution dogfood', () => {
  it('adds one source as a draft and reads its independently digested atoms', async () => {
    const bytes = Buffer.from('# Constitution\n\nOne fact, one owner.\n');
    const sha256 = digestOf(bytes);
    const store = new InMemoryObjectStore();
    const key = `document-imports/${sha256}`;
    await store.put(key, bytes, 'text/markdown');

    const parser: DocumentParser = {
      async parse() {
        const atoms = atomsFromPandoc({
          'pandoc-api-version': [1, 23, 1],
          blocks: [
            { t: 'Header', c: [1, ['constitution', [], []], [{ t: 'Str', c: 'Constitution' }]] },
            {
              t: 'Para',
              c: [
                { t: 'Str', c: 'One' },
                { t: 'Space' },
                { t: 'Str', c: 'fact,' },
                { t: 'Space' },
                { t: 'Str', c: 'one' },
                { t: 'Space' },
                { t: 'Str', c: 'owner.' },
              ],
            },
          ],
        });
        return { parser: 'test-parser', parserVersion: '1', atoms, contentDigest: digest(atoms) };
      },
    };
    const execute = createFabricDispatcher(
      harness.pool,
      createDocumentActionAtoms({ store, parser }),
    );
    const caller = {
      actorId: fixtures.reviewerId,
      actingRoleId: fixtures.reviewerRoleId,
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      targetIds: [],
    } as const;

    const artifactRequest = {
      ...caller,
      actionType: 'attach_evidence',
      idempotencyKey: 'dogfood-artifact-0001',
      payload: {
        title: 'constitution.md',
        artifact_kind: 'specification',
        sha256,
        size_bytes: bytes.length,
        media_type: 'text/markdown',
        storage_uri: key,
        revision_label: 'R01',
      },
    } as const;
    const artifact = await execute(artifactRequest);
    const replay = await execute(artifactRequest);
    expect(replay.replayed).toBe(true);
    expect(replay.objectIds).toEqual(artifact.objectIds);

    const versionId = await withTransaction(harness.pool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      return (
        await tx.one<{ id: string }>(
          'select id from content.artifact_version where artifact_id = $1',
          [artifact.objectIds[0]],
        )
      ).id;
    });
    const added = await execute({
      ...caller,
      actionType: 'add_controlled_document',
      idempotencyKey: 'dogfood-document-0001',
      payload: {
        title: 'OpenHuman Document Constitution',
        document_class: 'specification',
        document_number: 'OH-DOC-TEST-001',
        revision: 'R01',
        owning_role: 'technical_authority',
        content_version: versionId,
      },
    });

    const { detail, summaries, approvals } = await withTransaction(harness.pool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      return {
        detail: await getDocument(tx, added.objectIds[0]!),
        summaries: await listDocuments(tx),
        approvals: await tx.one<{ count: string }>(
          'select count(*)::text as count from core.approval',
        ),
      };
    });

    expect(summaries).toHaveLength(1);
    expect(detail).toMatchObject({
      lifecycleState: 'draft',
      documentNumber: 'OH-DOC-TEST-001',
      revision: 'R01',
      parser: 'test-parser',
      atomCount: 2,
    });
    expect(detail?.atoms.map((atom) => atom.text)).toEqual([
      'Constitution',
      'One fact, one owner.',
    ]);
    expect(detail?.atoms.every((atom) => /^[0-9a-f]{64}$/.test(atom.digest))).toBe(true);
    expect(Number(approvals.count)).toBe(0);

    const unscoped = await withTransaction(harness.pool, async (tx) => ({
      parses: await tx.one<{ count: string }>(
        'select count(*)::text as count from content.document_parse',
      ),
      atoms: await tx.one<{ count: string }>(
        'select count(*)::text as count from content.document_atom',
      ),
    }));
    expect(Number(unscoped.parses.count)).toBe(0);
    expect(Number(unscoped.atoms.count)).toBe(0);
  });
});
