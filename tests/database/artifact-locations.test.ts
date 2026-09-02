import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  InMemoryObjectStore,
  StoreRegistry,
  createStorageActionAtoms,
  declareStore,
  digestOf,
  locationsOf,
  readVersionBytes,
  replicateVersion,
  verifyLocation,
} from '@kf/artifacts';
import { withTransaction } from '@kf/database';
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
 * Where the bytes are is a set of locations (ADR 0017). Against a real database, with two
 * in-memory stores standing in for the working store and a durable one:
 *
 *   1. Recording a version creates its `working` location by trigger, equal to the columns;
 *      a working location that disagrees with the columns is refused; locations are
 *      append-only and only their verification may change.
 *   2. One version, two locations, both verified to the same sha256 — through the dispatched
 *      `replicate_artifact_version` and `verify_artifact_location`.
 *   3. Losing the working copy leaves the durable one servable; a tampered durable copy is a
 *      recorded verification failure, and is then not served.
 *   4. No code path writes `public_copy`: replication refuses the role.
 */

let harness: Harness;
let fixtures: Fixtures;
let working: InMemoryObjectStore;
let durable: InMemoryObjectStore;
let registry: StoreRegistry;

beforeAll(async () => {
  harness = await startHarness();
  fixtures = await seedFixtures(harness.adminPool);
  working = new InMemoryObjectStore();
  durable = new InMemoryObjectStore();
  registry = new StoreRegistry({ working, durable });
  await withTransaction(harness.adminPool, async (tx) => {
    await bindContext(tx, fixtures);
    await declareStore(tx, { id: 'durable', kind: 'memory', label: 'Second failure domain' });
  });
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

async function recordVersion(body: Buffer): Promise<{ artifactId: string; versionId: string }> {
  const artifactId = await createObject(harness.adminPool, fixtures, {
    type: 'artifact',
    domain: 'content',
    state: 'draft',
    title: 'Located artifact',
    createdBy: fixtures.reviewerId,
  });
  const key = `artifacts/${artifactId}/v1`;
  const stored = await working.put(key, body, 'text/plain');
  const versionId = randomUUID();
  await withTransaction(harness.adminPool, async (tx) => {
    await bindContext(tx, fixtures, fixtures.reviewerId);
    await tx.query(
      `insert into content.artifact (id, artifact_kind, source_system)
       values ($1, 'report', 'object_store')`,
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
  return { artifactId, versionId };
}

describe('storage locations', () => {
  it('records the working location by trigger and holds it equal to the columns', async () => {
    const { versionId } = await recordVersion(Buffer.from('located bytes'));
    const locations = await withTransaction(harness.adminPool, (tx) => locationsOf(tx, versionId));
    expect(locations).toEqual([
      expect.objectContaining({ role: 'working', store_id: 'working', verified_at: null }),
    ]);
    expect(locations[0]!.uri).toBe(`artifacts/${await artifactOf(versionId)}/v1`);

    await expect(
      withTransaction(harness.adminPool, async (tx) => {
        await bindContext(tx, fixtures);
        await tx.query(
          `insert into content.artifact_location (version_id, store_id, role, uri)
           values ($1, 'durable', 'working', 'somewhere-else')`,
          [versionId],
        );
      }),
    ).rejects.toThrow(/must match artifact_version.storage_uri/);
    await expect(
      withTransaction(harness.adminPool, async (tx) => {
        await bindContext(tx, fixtures);
        await tx.query('delete from content.artifact_location where version_id = $1', [versionId]);
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      withTransaction(harness.adminPool, async (tx) => {
        await bindContext(tx, fixtures);
        await tx.query(`update content.artifact_location set uri = 'moved' where version_id = $1`, [
          versionId,
        ]);
      }),
    ).rejects.toThrow(/only the verification/);
  });

  it('replicates and verifies through dispatched actions: two locations, one digest', async () => {
    const body = Buffer.from('two copies of the same thing');
    const { artifactId, versionId } = await recordVersion(body);
    const execute = createFabricDispatcher(
      harness.pool,
      undefined,
      undefined,
      undefined,
      createStorageActionAtoms(registry),
    );
    const replicated = await execute({
      actionType: 'replicate_artifact_version',
      actorId: fixtures.reviewerId,
      actingRoleId: fixtures.reviewerRoleId,
      targetIds: [artifactId],
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `replicate-${randomUUID()}`,
      reason: 'second failure domain',
      payload: { version_id: versionId, store_id: 'durable', role: 'durable_copy' },
    });
    expect(replicated.status).toBe('applied');

    const locations = await withTransaction(harness.adminPool, (tx) => locationsOf(tx, versionId));
    expect(locations.map((l) => [l.role, l.store_id])).toEqual([
      ['durable_copy', 'durable'],
      ['working', 'working'],
    ]);
    const durableRow = locations.find((l) => l.role === 'durable_copy')!;
    expect(durableRow.verified_sha256).toBe(digestOf(body));
    expect(durableRow.verified_by_action).toBe(replicated.actionId);

    const workingRow = locations.find((l) => l.role === 'working')!;
    const verified = await execute({
      actionType: 'verify_artifact_location',
      actorId: fixtures.reviewerId,
      actingRoleId: fixtures.reviewerRoleId,
      targetIds: [artifactId],
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `verify-${randomUUID()}`,
      reason: 'periodic re-hash',
      payload: { location_id: workingRow.id },
    });
    expect(verified.status).toBe('applied');
    const after = await withTransaction(harness.adminPool, (tx) => locationsOf(tx, versionId));
    expect(after.map((l) => l.verified_sha256)).toEqual([digestOf(body), digestOf(body)]);
    expect(after.every((l) => l.verification_failure === null)).toBe(true);

    // The wrong artifact cannot vouch for a version it does not own.
    const other = await createObject(harness.adminPool, fixtures, {
      type: 'artifact',
      domain: 'content',
      state: 'draft',
      title: 'Unrelated artifact',
      createdBy: fixtures.reviewerId,
    });
    await expect(
      execute({
        actionType: 'verify_artifact_location',
        actorId: fixtures.reviewerId,
        actingRoleId: fixtures.reviewerRoleId,
        targetIds: [other],
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
        idempotencyKey: `verify-${randomUUID()}`,
        reason: 'wrong target',
        payload: { location_id: workingRow.id },
      }),
    ).rejects.toMatchObject({ name: 'ActionRejected', failure: 'precondition_failed' });
  });

  it('serves from the durable copy when the working copy is gone, and never from a bad one', async () => {
    const body = Buffer.from('survives the loss of the working store');
    const { versionId } = await recordVersion(body);
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, fixtures, fixtures.reviewerId);
      await replicateVersion(tx, registry, {
        versionId,
        toStoreId: 'durable',
        role: 'durable_copy',
        recordedBy: fixtures.reviewerId,
      });
    });
    const key = `artifacts/${await artifactOf(versionId)}/v1`;

    // Lose the working copy: a fresh working store that never held it.
    const lost = new StoreRegistry({ working: new InMemoryObjectStore(), durable });
    const served = await withTransaction(harness.adminPool, (tx) =>
      readVersionBytes(tx, lost, versionId),
    );
    expect(served?.servedFrom.role).toBe('durable_copy');
    expect(served?.bytes.equals(body)).toBe(true);

    // Now the durable copy is tampered with: verification records the failure, and the
    // read refuses it rather than serving bytes that do not hash to the record.
    // Same length, different bytes: the digest, not the size, is what catches it.
    durable.tamper(key, Buffer.from('survives the loss of the working STORE'));
    const durableRow = (
      await withTransaction(harness.adminPool, (tx) => locationsOf(tx, versionId))
    ).find((l) => l.role === 'durable_copy')!;
    const outcome = await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, fixtures, fixtures.reviewerId);
      return verifyLocation(tx, registry, durableRow.id);
    });
    expect(outcome.ok).toBe(false);
    const recorded = (
      await withTransaction(harness.adminPool, (tx) => locationsOf(tx, versionId))
    ).find((l) => l.role === 'durable_copy')!;
    expect(recorded.verified_sha256).toBeNull();
    expect(recorded.verification_failure).toMatch(/expected [0-9a-f]{64}, found/);
    const none = await withTransaction(harness.adminPool, (tx) =>
      readVersionBytes(tx, lost, versionId),
    );
    expect(none).toBeUndefined();
  });

  it('refuses to produce a public copy: that is a publication act, not a replication', async () => {
    const { artifactId, versionId } = await recordVersion(Buffer.from('never public by copy'));
    const execute = createFabricDispatcher(
      harness.pool,
      undefined,
      undefined,
      undefined,
      createStorageActionAtoms(registry),
    );
    await expect(
      execute({
        actionType: 'replicate_artifact_version',
        actorId: fixtures.reviewerId,
        actingRoleId: fixtures.reviewerRoleId,
        targetIds: [artifactId],
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
        idempotencyKey: `replicate-${randomUUID()}`,
        reason: 'attempted publication by copy',
        payload: { version_id: versionId, store_id: 'durable', role: 'public_copy' },
      }),
    ).rejects.toMatchObject({ name: 'ActionRejected', failure: 'precondition_failed' });
    const count = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{ count: string }>(
        `select count(*)::text as count from content.artifact_location where role = 'public_copy'`,
      ),
    );
    expect(count.count).toBe('0');
  });
});

async function artifactOf(versionId: string): Promise<string> {
  const row = await withTransaction(harness.adminPool, (tx) =>
    tx.one<{ artifact_id: string }>(
      'select artifact_id from content.artifact_version where id = $1',
      [versionId],
    ),
  );
  return row.artifact_id;
}
