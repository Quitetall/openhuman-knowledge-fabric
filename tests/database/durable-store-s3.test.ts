/**
 * The durable artifact store on an S3 endpoint with its own region (ADR 0039: Backblaze B2).
 *
 * A real PostgreSQL and a real S3 endpoint (tests/backup-restore/s3-endpoint.ts), configured the
 * way B2 is: a custom endpoint, a non-AWS region, both stores versioned. The storage sweep, as
 * its declared service actor through the storage login, must:
 *
 *   1. bind `durable` to that endpoint and bucket in content.artifact_store on first use
 *      (content.bind_artifact_store), and refuse a later process configured with another bucket;
 *   2. replicate a version into it and record the version id the store returned;
 *   3. verify it there, by re-reading that version;
 *   4. find a durable copy whose recorded version was deleted, and say so rather than passing;
 *   5. do all of it with conditional create off (`S3_DURABLE_CONDITIONAL_CREATE=false`, for a
 *      store without If-None-Match), keeping an existing object at the key rather than
 *      overwriting it.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  S3ObjectStore,
  StoreAddressMismatch,
  StoreRegistry,
  createStorageActionAtoms,
  digestOf,
  locationsOf,
  type S3Config,
} from '@kf/artifacts';
import { withTransaction } from '@kf/database';
import { createFabricDispatcher } from '@kf/orchestrator';
import { runDeclareServiceActor } from '../../apps/api/src/admin/declare-service-actor.js';
import { runStorageSweep } from '../../apps/kf-storage/src/sweep.js';
import {
  BUCKETS,
  REGION,
  startS3Endpoint,
  type S3Endpoint,
} from '../backup-restore/s3-endpoint.js';
import {
  aYearFromNow,
  bindContext,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

let harness: Harness;
let fixtures: Fixtures;
let s3: S3Endpoint;
let actor: {
  personId: string;
  roleAssignmentId: string;
  organizationId: string;
  maxClassification: string;
};

beforeAll(async () => {
  [harness, s3] = await Promise.all([startHarness(), startS3Endpoint()]);
  fixtures = await seedFixtures(harness.adminPool);
  const declared = await runDeclareServiceActor(harness.adminPool, {
    validTo: aYearFromNow(),
    organizationId: fixtures.organizationId,
    name: 'storage-steward',
    roleId: 'performer',
    classification: 'restricted',
    declaredBy: fixtures.reviewerId,
    reason: 'replicates artifact copies into the durable store',
  });
  actor = {
    personId: declared.personId,
    roleAssignmentId: declared.roleAssignmentId,
    organizationId: fixtures.organizationId,
    maxClassification: 'restricted',
  };
}, 240_000);

afterAll(async () => {
  await Promise.allSettled([harness?.stop(), s3?.stop()]);
});

function config(bucket: string, extra: Partial<S3Config> = {}): S3Config {
  return {
    endpoint: s3.remoteEndpoint,
    region: REGION,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    bucket,
    forcePathStyle: true,
    ...extra,
  };
}

/** One artifact version whose working bytes are in the working bucket. */
async function storedVersion(body: Buffer): Promise<{ versionId: string; key: string }> {
  const working = new S3ObjectStore(config(BUCKETS.working));
  const artifactId = await createObject(harness.adminPool, fixtures, {
    type: 'artifact',
    domain: 'artifact',
    state: 'draft',
    title: 'Durable artifact',
    createdBy: fixtures.reviewerId,
  });
  const key = `artifacts/${artifactId}/v1`;
  const stored = await working.put(key, body, 'text/plain');
  const versionId = randomUUID();
  await withTransaction(harness.adminPool, async (tx) => {
    await bindContext(tx, fixtures, fixtures.reviewerId);
    await tx.query(
      `insert into content.artifact (id, artifact_kind, source_system) values ($1, 'document', 'object_store')`,
      [artifactId],
    );
    await tx.query(
      `insert into content.artifact_version
         (id, artifact_id, version_no, revision_label, sha256, size_bytes, media_type,
          storage_uri, storage_version, created_by, created_by_action)
       values ($1, $2, 1, 'R01', $3, $4, 'text/plain', $5, $6, $7, $8)`,
      [
        versionId,
        artifactId,
        digestOf(body),
        body.length,
        key,
        stored.versionId,
        fixtures.reviewerId,
        fixtures.clearanceActionId,
      ],
    );
  });
  return { versionId, key };
}

async function sweep(durable: S3Config, verifyOlderThanDays?: number) {
  const registry = await withTransaction(harness.storagePool, (tx) =>
    StoreRegistry.fromDatabase(tx, { working: config(BUCKETS.working), durable }),
  );
  const execute = createFabricDispatcher(
    harness.storagePool,
    undefined,
    undefined,
    undefined,
    createStorageActionAtoms(registry),
  );
  return runStorageSweep(harness.storagePool, execute, actor, {
    replicateTo: 'durable',
    ...(verifyOlderThanDays === undefined ? {} : { verifyOlderThanDays }),
  });
}

describe('the durable store on a custom S3 endpoint and region', () => {
  it('is bound on first use, replicated into, and verified there', async () => {
    const body = Buffer.from('bytes that must survive the working store');
    const { versionId, key } = await storedVersion(body);
    const report = await sweep(config(BUCKETS.durable), 0);
    expect(report.refused).toEqual([]);
    expect(report.replicated.map((r) => r.versionId)).toContain(versionId);
    expect(report.verified.every((v) => v.ok)).toBe(true);

    const bound = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{ kind: string; endpoint: string; bucket: string }>(
        `select kind, endpoint, bucket from content.artifact_store where id = 'durable'`,
      ),
    );
    expect(bound).toEqual({
      kind: 'object_store',
      endpoint: s3.remoteEndpoint,
      bucket: BUCKETS.durable,
    });

    const durable = (
      await withTransaction(harness.adminPool, (tx) => locationsOf(tx, versionId))
    ).find((l) => l.role === 'durable_copy')!;
    expect(durable.store_id).toBe('durable');
    expect(durable.uri).toBe(key);
    expect(durable.store_version).toMatch(/\S/);
    // What the location names is really there, at that version, with those bytes.
    const read = await new S3ObjectStore(config(BUCKETS.durable)).read(
      key,
      durable.store_version!,
      body.length,
    );
    expect(digestOf(read)).toBe(digestOf(body));
  });

  it('refuses a later process configured with another bucket under the same id', async () => {
    await expect(
      withTransaction(harness.storagePool, (tx) =>
        StoreRegistry.fromDatabase(tx, {
          working: config(BUCKETS.working),
          durable: config(BUCKETS.plain),
        }),
      ),
    ).rejects.toBeInstanceOf(StoreAddressMismatch);
  });

  it('reports a durable copy whose recorded version is gone, instead of passing it', async () => {
    const { versionId, key } = await storedVersion(Buffer.from('a copy somebody will delete'));
    expect((await sweep(config(BUCKETS.durable))).refused).toEqual([]);
    const durable = (
      await withTransaction(harness.adminPool, (tx) => locationsOf(tx, versionId))
    ).find((l) => l.role === 'durable_copy')!;
    await s3.deleteVersion(BUCKETS.durable, key, durable.store_version!);
    const report = await sweep(config(BUCKETS.durable), 0);
    const failed = report.verified.filter((v) => !v.ok);
    expect(failed.length).toBeGreaterThanOrEqual(1);
    const row = (await withTransaction(harness.adminPool, (tx) => locationsOf(tx, versionId))).find(
      (l) => l.role === 'durable_copy',
    )!;
    expect(row.verification_failure).not.toBeNull();
  });

  it('works without conditional writes, and keeps an object already at the key', async () => {
    const body = Buffer.from('bytes for a store without If-None-Match');
    const { versionId, key } = await storedVersion(body);
    // The same bytes already at the key, put there by an earlier run that died before its row.
    const earlier = await new S3ObjectStore(config(BUCKETS.durable)).put(key, body, 'text/plain');
    const report = await sweep(config(BUCKETS.durable, { conditionalCreate: false }));
    expect(report.refused).toEqual([]);
    expect(report.replicated.map((r) => r.versionId)).toContain(versionId);
    const durable = (
      await withTransaction(harness.adminPool, (tx) => locationsOf(tx, versionId))
    ).find((l) => l.role === 'durable_copy')!;
    // Kept, not overwritten: the location names the version that was already there, and the
    // replication's own verification re-hashed it there.
    expect(durable.store_version).toBe(earlier.versionId);
    expect(durable.verified_sha256).toBe(digestOf(body));
    expect(durable.verification_failure).toBeNull();
  });
});
