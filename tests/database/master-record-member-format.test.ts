/**
 * A master-record member's content digest is identity, so moving it under a format tag
 * (KF-SAS-RQ-016) must not make a claim compiled before the move read as stale.
 *
 * `corpus_digest` is a line digest over the members' content digests, and every read re-checks
 * the stored claim against a fresh enumeration. The member format is therefore versioned by the
 * manifest that recorded it — kf-master-record-v1/-v2 carry the untagged
 * kf-master-record-member-v1, kf-master-record-v3 the tagged -v2 — and every staleness check
 * enumerates under the RECORDED format. This file plants a v2 claim exactly as the code before
 * the tag wrote it, and requires that it is still current, that it would NOT be current under
 * the new format (so the versioning is load-bearing, not incidental), and that a recompilation
 * writes v3 beside it without touching it.
 */

import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { digest } from '@kf/canonicalization';
import { InMemoryObjectStore } from '@kf/artifacts';
import { setAccessContext, setTransactionContext, withTransaction } from '@kf/database';
import {
  assertPermissionSetInvariant,
  compileMasterRecord,
  createDocumentActionAtoms,
  enumeratePermittedSet,
  latestMasterRecord,
  type MasterRecordManifest,
} from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
import { registerMasterRecordRoute } from '../../apps/api/src/routes/documents/master-record-route.js';
import {
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

let harness: Harness;
let fixtures: Fixtures;

beforeAll(async () => {
  harness = await startHarness();
  fixtures = await seedFixtures(harness.adminPool);
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

async function latest(): Promise<Record<string, unknown>> {
  return withTransaction(harness.adminPool, async (tx) => {
    const record = await latestMasterRecord(tx, fixtures.performerId, fixtures.organizationId);
    if (record === undefined) throw new Error('no master record');
    return record;
  });
}

async function compile(): Promise<void> {
  const execute = createFabricDispatcher(
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
  const result = await execute({
    actionType: 'compile_master_record',
    actorId: fixtures.performerId,
    actingRoleId: fixtures.performerRoleId,
    targetIds: [fixtures.performerId],
    organizationId: fixtures.organizationId,
    maxClassification: 'restricted',
    idempotencyKey: `member-format-${randomUUID()}`,
    reason: `member format proof ${randomUUID()}`,
  });
  expect(result.status).toBe('applied');
}

async function getMasterRecord(): Promise<{ status: number; body: string }> {
  const app = Fastify({ logger: false });
  registerMasterRecordRoute(app, {
    pool: harness.pool,
    identify: async () => ({
      actorId: fixtures.performerId,
      actingRoleId: fixtures.performerRoleId,
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      authentication: { authenticatedAt: undefined, assuranceLevel: undefined, methods: [] },
    }),
    store: undefined,
    preflightInTransaction: async () => undefined,
    executeInTransaction: async () => {
      throw new Error('a master-record read executes no action');
    },
  });
  await app.ready();
  try {
    const response = await app.inject({ method: 'GET', url: '/master-record' });
    return { status: response.statusCode, body: response.body };
  } finally {
    await app.close();
  }
}

describe('a master-record member digest is versioned by the manifest that recorded it', () => {
  let plantedCorpus = '';

  it('new claims are kf-master-record-v3, with tagged member digests', async () => {
    await createObject(harness.adminPool, fixtures, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Member format probe',
      createdBy: fixtures.performerId,
    });
    await compile();
    const record = await latest();
    const manifest = record['manifest'] as MasterRecordManifest;
    expect(manifest.format).toBe('kf-master-record-v3');
    expect(manifest.included.length).toBeGreaterThan(0);
    expect((await getMasterRecord()).status).toBe(200);
  }, 180_000);

  it('a claim written before the tag, under the untagged member digest, is still current', async () => {
    const planted = await withTransaction(harness.adminPool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      const action = await tx.one<{ id: string }>(
        'select id from core.action order by recorded_at limit 1',
      );
      await setTransactionContext(tx, {
        actorId: fixtures.performerId,
        actingRoleId: fixtures.performerRoleId,
        actionId: action.id,
        requestId: 'member-format-plant',
      });
      const permitted = await enumeratePermittedSet(
        tx,
        fixtures.performerId,
        fixtures.organizationId,
        'kf-master-record-member-v1',
      );

      // The untagged member digest, recomputed here from the rows themselves with nothing but
      // RFC 8785 + SHA-256 — the preimage the code before the tag hashed.
      const member = permitted[0]!;
      const row = await tx.one<Record<string, unknown>>(
        `select o.id, o.object_type, o.organization_id, o.classification, o.title,
                o.lifecycle_state, o.row_version::text,
                content.master_record_payload(o.id, 'kf-master-record-payload-v1') as content_payload
           from core.object o where o.id = $1`,
        [member.objectId],
      );
      expect(member.contentDigest).toBe(
        digest({
          id: row['id'],
          objectType: row['object_type'],
          organizationId: row['organization_id'],
          classification: row['classification'],
          title: row['title'],
          lifecycleState: row['lifecycle_state'],
          rowVersion: row['row_version'],
          content: row['content_payload'],
        }),
      );

      const compiled = compileMasterRecord({
        personId: fixtures.performerId,
        organizationId: fixtures.organizationId,
        effectiveClassification: 'restricted',
        permitted,
        relevantIds: new Set(),
        compiledAt: new Date().toISOString(),
      });
      const manifest = { ...compiled.manifest, format: 'kf-master-record-v2' as const };
      await tx.query(
        `insert into content.master_record
           (person_id, organization_id, effective_classification, corpus_digest,
            permission_digest, record_digest, manifest, compiled_at, recorded_by,
            recorded_by_action)
         values ($1,$2,'restricted',$3,$4,$5,$6::jsonb,$7,$8,$9)`,
        [
          fixtures.performerId,
          fixtures.organizationId,
          manifest.corpusDigest,
          manifest.permissionDigest,
          digest(manifest),
          JSON.stringify(manifest),
          manifest.compiledAt,
          fixtures.performerId,
          action.id,
        ],
      );
      return manifest;
    });
    plantedCorpus = planted.corpusDigest;

    const record = await latest();
    expect((record['manifest'] as MasterRecordManifest).format).toBe('kf-master-record-v2');
    expect(record['corpus_digest']).toBe(plantedCorpus);

    const read = await getMasterRecord();
    expect(read.status, read.body).toBe(200);
    expect(read.body).not.toContain('master_record_stale');
  }, 180_000);

  it('the same claim is NOT current under the new member format, so the version is load-bearing', async () => {
    const record = await latest();
    const manifest = record['manifest'] as MasterRecordManifest;
    await withTransaction(harness.adminPool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      const current = await enumeratePermittedSet(
        tx,
        fixtures.performerId,
        fixtures.organizationId,
      );
      expect(() =>
        assertPermissionSetInvariant(
          {
            corpusDigest: String(record['corpus_digest']),
            included: manifest.included,
            withdrawn: manifest.withdrawn,
          },
          current,
        ),
      ).toThrow();
    });
  });

  it('a corpus change compiles v3 beside the v2 claim and leaves it untouched', async () => {
    await createObject(harness.adminPool, fixtures, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Member format corpus change',
      createdBy: fixtures.performerId,
    });
    expect((await getMasterRecord()).body).toContain('master_record_stale');
    await compile();
    const record = await latest();
    expect((record['manifest'] as MasterRecordManifest).format).toBe('kf-master-record-v3');
    expect(record['corpus_digest']).not.toBe(plantedCorpus);
    const kept = await withTransaction(harness.adminPool, (tx) =>
      tx.query<{ n: string }>(
        `select count(*)::text as n from content.master_record
          where corpus_digest = $1 and manifest ->> 'format' = 'kf-master-record-v2'`,
        [plantedCorpus],
      ),
    );
    expect(Number(kept[0]?.n)).toBe(1);
  }, 180_000);
});
