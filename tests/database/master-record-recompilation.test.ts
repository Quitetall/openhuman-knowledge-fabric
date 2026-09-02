import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InMemoryObjectStore } from '@kf/artifacts';
import { withTransaction } from '@kf/database';
import {
  createDocumentActionAtoms,
  deriveMasterRecordSections,
  latestMasterRecord,
  masterRecordItems,
  type MasterRecordManifest,
} from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
import {
  bindContext,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

/**
 * A master record's identity is its corpus (ADR 0013). This file holds the three behaviours
 * that follow, against a real database:
 *
 *   1. Compiling an UNCHANGED corpus again yields the same record — no second row, and never
 *      the unique-constraint 500 this file was first written to pin.
 *   2. A relevance-only change (one new edge) does not change the corpus, so it does not
 *      produce a new record — and it does not need to: sections are derived at read time, so
 *      the edge is visible immediately against the SAME claim.
 *   3. A corpus change (content drift on a member) produces a new record with a new digest.
 *
 * The first version of this file pinned the defect: `unique (person, organization,
 * permission_digest)` with sectioning outside the digest, measured 2026-08-28 as a 500 and a
 * read surface answering `stale: false` over out-of-date sectioning. That version failed the
 * moment the identity changed, which was its job.
 */

let harness: Harness;
let fixtures: Fixtures;

beforeAll(async () => {
  harness = await startHarness();
  fixtures = await seedFixtures(harness.adminPool);
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

async function latest(): Promise<{
  readonly id: string;
  readonly corpusDigest: string;
  readonly manifest: MasterRecordManifest;
}> {
  return withTransaction(harness.adminPool, async (tx) => {
    const record = await latestMasterRecord(tx, fixtures.performerId, fixtures.organizationId);
    if (record === undefined) throw new Error('no master record');
    return {
      id: String(record['id']),
      corpusDigest: String(record['corpus_digest']),
      manifest: record['manifest'] as MasterRecordManifest,
    };
  });
}

describe('master-record identity is the corpus', () => {
  const dispatcher = () =>
    createFabricDispatcher(
      harness.pool,
      createDocumentActionAtoms({
        store: new InMemoryObjectStore(),
        parser: {
          async parse() {
            return undefined;
          },
        },
      }),
    );

  const compile = async (): Promise<{ readonly status: string; readonly actionId: string }> =>
    (await dispatcher()({
      actionType: 'compile_master_record',
      actorId: fixtures.performerId,
      actingRoleId: fixtures.performerRoleId,
      targetIds: [fixtures.performerId],
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `corpus-identity-${randomUUID()}`,
      // Distinct per call on purpose. The dispatcher also replays semantically identical
      // requests before any effect runs; an identical reason would let that replay satisfy
      // "same record" without the corpus lookup ever being exercised.
      reason: `corpus identity proof ${randomUUID()}`,
    })) as { readonly status: string; readonly actionId: string };

  it('compiles an unchanged corpus to the same record, with no second row', async () => {
    const probe = await createObject(harness.adminPool, fixtures, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Corpus identity probe',
      createdBy: fixtures.performerId,
    });

    const first = await compile();
    expect(first.status).toBe('applied');
    const before = await latest();
    expect(before.manifest.included.some((member) => member.objectId === probe)).toBe(true);
    expect(before.manifest.format).toBe('kf-master-record-v2');
    expect(before.manifest.corpusDigest).toBe(before.corpusDigest);

    // A fresh idempotency key: a genuine second attempt, not a replay of the first action.
    const second = await compile();
    expect(second.status).toBe('applied');
    const after = await latest();
    expect(after.id).toBe(before.id);
    expect(after.corpusDigest).toBe(before.corpusDigest);

    const rows = await withTransaction(harness.adminPool, (tx) =>
      tx.query<{ n: string }>(
        `select count(*)::text as n from content.master_record
          where person_id = $1 and organization_id = $2`,
        [fixtures.performerId, fixtures.organizationId],
      ),
    );
    expect(Number(rows[0]?.n)).toBe(1);
  }, 180_000);

  it('makes a new relevance edge visible against the SAME claim, without recompiling', async () => {
    const before = await latest();
    const probe = before.manifest.included.find(
      (member) => member.objectType === 'decision_record',
    )?.objectId;
    expect(probe, 'the probe from the previous test').toBeDefined();

    const sectionsBefore = await withTransaction(harness.adminPool, (tx) =>
      deriveMasterRecordSections(tx, before.manifest),
    );
    expect(sectionsBefore.relevant.map((member) => member.objectId)).not.toContain(probe);

    // `produces` is person_anchor with propagation class composition_down: the closure reaches
    // the probe from the person.
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, fixtures, fixtures.performerId);
      await tx.query(
        `insert into core.relation (relation_type, source_id, target_id, created_by)
         values ('produces', $1, $2, $1)`,
        [fixtures.performerId, probe],
      );
    });

    // Same claim — the corpus did not move.
    const recompiled = await compile();
    expect(recompiled.status).toBe('applied');
    const after = await latest();
    expect(after.id).toBe(before.id);

    // Different reading — derived from the graph as it is now.
    const sectionsAfter = await withTransaction(harness.adminPool, (tx) =>
      deriveMasterRecordSections(tx, after.manifest),
    );
    expect(sectionsAfter.relevant.map((member) => member.objectId)).toContain(probe);
    // And the stored items carry no section at all: there is nothing there to go stale.
    const items = await withTransaction(harness.adminPool, (tx) => masterRecordItems(tx, after.id));
    expect(items.every((item) => !('section' in item))).toBe(true);
  }, 180_000);

  it('compiles a changed corpus to a new record', async () => {
    const before = await latest();
    const probe = before.manifest.included.find(
      (member) => member.objectType === 'decision_record',
    )?.objectId;
    expect(probe).toBeDefined();

    // Content drift on a member: the envelope title is part of the content digest.
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, fixtures, fixtures.performerId);
      await tx.query(
        `update core.object set title = $2, row_version = row_version + 1 where id = $1`,
        [probe, 'Corpus identity probe, revised'],
      );
    });

    const third = await compile();
    expect(third.status).toBe('applied');
    const after = await latest();
    expect(after.id).not.toBe(before.id);
    expect(after.corpusDigest).not.toBe(before.corpusDigest);
    // The access fact did not change — same objects, same ceiling — only the content did.
    expect(after.manifest.permissionDigest).toBe(before.manifest.permissionDigest);
  }, 180_000);

  it('is checked by the database, not only by the code that wrote it', async () => {
    // The identity columns are recomputed from the manifest and CHECKed. A row whose stored
    // digest disagrees with its own claim cannot exist. The table is also append-only by
    // trigger; that guard is lifted inside this transaction so the refusal observed is the
    // CHECK's and not the trigger's — the transaction rolls back either way.
    const current = await latest();
    await expect(
      withTransaction(harness.adminPool, async (tx) => {
        await tx.query(
          'alter table content.master_record disable trigger master_record_append_only',
        );
        await tx.query(`update content.master_record set corpus_digest = $2 where id = $1`, [
          current.id,
          'a'.repeat(64),
        ]);
      }),
    ).rejects.toThrow(/master_record_corpus_digest_matches_manifest/);
  }, 60_000);
});
