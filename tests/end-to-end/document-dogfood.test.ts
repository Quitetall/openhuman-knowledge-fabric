/** Constitution dogfood: immutable bytes -> fragments -> composition -> draft document view. */

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

/**
 * 120s, not the 30s global, and this one is measured rather than guessed.
 *
 * The single test here drives the whole document path end to end: a PostgreSQL container, the
 * action dispatcher, the Liminal compiler under bubblewrap, pandoc, and content-addressed
 * staging into object storage. Its wall time is set by how fast the machine is, not by anything
 * the assertions are checking.
 *
 * THIRTY-EIGHT recorded runs from this repository's own gate logs on 2026-08-21/22:
 *
 *   fastest  10_455ms
 *   median   ~19_000ms
 *   slowest  24_385ms      <- 81% of the 30_000ms budget, on a passing run
 *   CI       30_031ms      <- failed by 31ms on a GitHub-hosted runner
 *
 * A budget the median already consumes two thirds of is not a budget, and the failure it
 * produces is a false red on an end-to-end test — the most expensive kind to misread, because
 * the natural next move is to go hunting through the document pipeline for a regression that
 * is not there. It cost exactly that once already this session on the self-hosted runner.
 *
 * 120s is ~5x the slowest observed pass. A genuine hang still fails, just later.
 */
describe('document constitution dogfood', { timeout: 120_000 }, () => {
  it('adds one source as a draft and reads its independently digested atoms', async () => {
    const bytes = Buffer.from('# Constitution\n\nOne fact, one owner.\n');
    const sha256 = digestOf(bytes);
    const store = new InMemoryObjectStore();
    const key = `document-imports/${sha256}`;
    await store.put(key, bytes, 'text/markdown');

    const parser: DocumentParser = {
      async parse(sourceBytes) {
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
        const atomClaims = atoms.map(({ digest: _digest, ...claim }) => claim);
        return {
          parser: 'test-parser',
          parserVersion: '1',
          projectionContract: 'test.atoms.v1',
          sourceDigest: digestOf(sourceBytes),
          atoms,
          conversionLoss: [],
          lossDigest: digest([]),
          contentDigest: digest({
            projectionContract: 'test.atoms.v1',
            atoms: atomClaims,
            conversionLoss: [],
          }),
        };
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
    const fragmentHolderId = '01950000-0000-7000-8000-00000000d001';
    const fragmentRevisionId = '01950000-0000-7000-8000-00000000d002';
    const fragment = await execute({
      ...caller,
      actionType: 'add_authored_fragment',
      idempotencyKey: 'dogfood-fragment-0001',
      payload: {
        title: 'OpenHuman Document Constitution',
        stable_key: 'openhuman.constitution.OH-DOC-TEST-001',
        holder_id: fragmentHolderId,
        holder: {
          kind: 'fabric_native',
          artifact_version_id: versionId,
          content_digest: sha256,
        },
        revision_id: fragmentRevisionId,
        media_type: 'text/markdown',
        classification: 'internal',
        document_policy: 'ordinary',
      },
    });

    const manifestBytes = Buffer.from(
      JSON.stringify([{ documentNumber: 'OH-DOC-TEST-001', revision: 'R01' }]),
    );
    const manifestSha256 = digestOf(manifestBytes);
    const manifestKey = `document-imports/${manifestSha256}`;
    await store.put(manifestKey, manifestBytes, 'application/json');
    const manifestArtifact = await execute({
      ...caller,
      actionType: 'attach_evidence',
      idempotencyKey: 'dogfood-manifest-0001',
      payload: {
        title: 'document-constitution.json',
        artifact_kind: 'specification',
        sha256: manifestSha256,
        size_bytes: manifestBytes.length,
        media_type: 'application/json',
        storage_uri: manifestKey,
      },
    });
    const manifestVersionId = await withTransaction(harness.pool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      return (
        await tx.one<{ id: string }>(
          'select id from content.artifact_version where artifact_id = $1',
          [manifestArtifact.objectIds[0]],
        )
      ).id;
    });
    const composition = await execute({
      ...caller,
      actionType: 'add_document_composition',
      idempotencyKey: 'dogfood-composition-0001',
      payload: {
        title: 'OpenHuman Document Constitution',
        stable_key: 'openhuman.document-constitution',
        holder_id: '01950000-0000-7000-8000-00000000d003',
        holder: {
          kind: 'fabric_native',
          artifact_version_id: manifestVersionId,
          content_digest: manifestSha256,
        },
        revision_id: '01950000-0000-7000-8000-00000000d004',
        classification: 'internal',
        document_policy: 'ordinary',
        inputs: [{ ordinal: 1, role: 'fragment', fragment_revision_id: fragmentRevisionId }],
      },
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

    const { detail, summaries, source, approvals, authorityActions } = await withTransaction(
      harness.pool,
      async (tx) => {
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
          authorityActions: await tx.one<{ count: string }>(
            `select count(*)::text as count
             from core.action
            where action_type in ('approve_controlled_document', 'accept_decision')`,
          ),
          source: await tx.one<{
            fragments: string;
            compositions: string;
            inputs: string;
            holder_kinds: string[];
          }>(
            `select
             (select count(*)::text from content.authored_fragment) as fragments,
             (select count(*)::text from content.document_composition) as compositions,
             (select count(*)::text from content.composition_input) as inputs,
             (select array_agg(holder_kind order by holder_kind)
                from content.document_source_holder) as holder_kinds`,
          ),
        };
      },
    );

    expect(summaries).toHaveLength(1);
    expect(detail).toMatchObject({
      lifecycleState: 'draft',
      documentNumber: 'OH-DOC-TEST-001',
      revision: 'R01',
      parser: 'test-parser',
      // `parsedBlockCount`, not `atomCount`. The reader was renamed deliberately: an atom is
      // LamQuant's authoring unit, while these are disposable projections of parsed source
      // that any reparse may replace (ADR 0002). Calling both "atoms" conflated a thing
      // somebody wrote with a thing a parser produced.
      parsedBlockCount: 2,
    });
    expect(detail?.parsedBlocks.map((block) => block.text)).toEqual([
      'Constitution',
      'One fact, one owner.',
    ]);
    expect(detail?.parsedBlocks.every((block) => /^[0-9a-f]{64}$/.test(block.digest))).toBe(true);
    expect(Number(approvals.count)).toBe(0);
    expect(Number(authorityActions.count)).toBe(0);
    expect(source).toEqual({
      fragments: '1',
      compositions: '1',
      inputs: '1',
      holder_kinds: ['fabric_native', 'fabric_native'],
    });
    expect(fragment.objectIds).toHaveLength(1);
    expect(composition.objectIds).toHaveLength(1);

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
