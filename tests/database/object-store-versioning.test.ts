/**
 * The working object store keeps every version, and a store that does not is caught by name.
 *
 * ADR 0039 replaced MinIO with SeaweedFS because KF depends on S3 versioning: the artifact store
 * records each object's version id (`content.artifact_location.store_version`) and reads by it.
 * This runs the store exactly as the development stack does — image, arguments and bucket
 * initialisation are docker-compose.yml's and deploy/object-store/init-buckets.sh's — and checks
 * the behaviour packages/artifacts/src/store.ts relies on, against the real server:
 *
 *   - every bucket the stack configures answers GetBucketVersioning with Enabled;
 *   - a second write to a key makes a new version id, and both versions stay readable by id;
 *   - a create-only write (If-None-Match) does not replace the first;
 *   - an upload through a presigned URL is accepted and versioned;
 *   - and a planted bucket WITHOUT versioning, or with it suspended, is refused by name.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VersioningNotEnabled, bucketVersioning, requireVersioning } from '@kf/artifacts';
import { PreservationObjectStore, type StartedStore } from './preservation-object-store.js';

/** The buckets the development stack hands the applications (S3_BUCKET_* in .env.example). */
const CONFIGURED = [
  ...readFileSync(resolve(import.meta.dirname, '../../.env.example'), 'utf8').matchAll(
    /^S3_BUCKET_[A-Z]+=(\S+)$/gm,
  ),
].map((match) => match[1] ?? '');

const PLANTED = 'kf-planted-unversioned';
const SUSPENDED = 'kf-planted-suspended';

const fixture = new PreservationObjectStore();
let started: StartedStore;

beforeAll(async () => {
  started = await fixture.start();
}, 180_000);

afterAll(async () => {
  await fixture.stop();
});

function key(name: string): string {
  return `ingest/versioning-test/${name}-${Date.now()}`;
}

describe('the working object store', () => {
  it('has versioning Enabled on every bucket the stack is configured with', async () => {
    expect(CONFIGURED).toEqual(['kf-artifacts', 'kf-snapshots', 'kf-checkpoints', 'kf-exports']);
    await expect(
      requireVersioning(fixture.credentials(started.endpoint), CONFIGURED),
    ).resolves.toBeUndefined();
  });

  it('gives a second write to a key a new version id, and keeps both readable', async () => {
    const at = key('rewrite');
    const first = await started.store.put(at, Buffer.from('first bytes'), 'application/pdf');
    const second = await started.store.put(at, Buffer.from('second, longer'), 'application/pdf');

    expect(first.versionId).toMatch(/^[0-9a-f]{32}$/);
    expect(second.versionId).toMatch(/^[0-9a-f]{32}$/);
    expect(second.versionId).not.toBe(first.versionId);
    await expect(started.store.read(at, first.versionId, 64)).resolves.toEqual(
      Buffer.from('first bytes'),
    );
    await expect(started.store.read(at, second.versionId, 64)).resolves.toEqual(
      Buffer.from('second, longer'),
    );
    await expect(started.store.head(at, first.versionId)).resolves.toEqual({
      key: at,
      sizeBytes: 11,
      versionId: first.versionId,
    });
    // Unversioned reads name the newest; a version the store never issued is absent, not an error.
    await expect(started.store.head(at)).resolves.toMatchObject({ versionId: second.versionId });
    await expect(started.store.head(at, '6724dc0000000000ffffffffffffffff')).resolves.toBe(
      undefined,
    );
  });

  it('keeps the first object when a create-only write meets an existing key', async () => {
    const at = key('create-only');
    const first = await started.store.putIfAbsent(at, Buffer.from('one'), 'text/plain');
    const again = await started.store.putIfAbsent(at, Buffer.from('two'), 'text/plain');

    expect(again).toEqual(first);
    await expect(started.store.read(at, undefined, 16)).resolves.toEqual(Buffer.from('one'));
  });

  it('accepts and versions an upload through a presigned URL', async () => {
    const at = key('presigned');
    const url = await started.store.presignPut(at, 'application/pdf', 60);
    const response = await fetch(url, {
      method: 'PUT',
      body: 'uploaded by a browser',
      headers: { 'content-type': 'application/pdf' },
    });

    expect(response.status, await response.text()).toBe(200);
    const versionId = response.headers.get('x-amz-version-id');
    expect(versionId).toMatch(/^[0-9a-f]{32}$/);
    await expect(started.store.head(at, versionId ?? undefined)).resolves.toMatchObject({
      sizeBytes: 21,
      versionId,
    });
  });

  it('refuses, by name, a bucket that was never versioned or is suspended', async () => {
    // Planted beside the real ones, through the S3 API: a bucket made without init-buckets.sh.
    expect((await fixture.request(started.id, 'PUT', PLANTED)).status).toBe(200);
    expect((await fixture.request(started.id, 'PUT', SUSPENDED)).status).toBe(200);
    await fixture.initialise(started.id, [SUSPENDED]);
    await fixture.suspendVersioning(started.id, SUSPENDED);

    const credentials = fixture.credentials(started.endpoint);
    expect([...(await bucketVersioning(credentials, [PLANTED, SUSPENDED]))]).toEqual([
      [PLANTED, 'never enabled'],
      [SUSPENDED, 'Suspended'],
    ]);
    const refusal = await requireVersioning(credentials, [...CONFIGURED, PLANTED, SUSPENDED]).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(VersioningNotEnabled);
    expect([...(refusal as VersioningNotEnabled).buckets.keys()]).toEqual([PLANTED, SUSPENDED]);
    expect((refusal as Error).message).toContain(`bucket ${PLANTED} is never enabled`);

    // What it would cost: the store issues no version id, and a rewrite destroys the first bytes.
    const unversioned = fixture.open(started.endpoint, PLANTED);
    const at = key('unversioned');
    const written = await unversioned.put(at, Buffer.from('evidence'), 'application/pdf');
    expect(written.versionId ?? null).toBeNull();
    await unversioned.put(at, Buffer.from('overwritten'), 'application/pdf');
    await expect(unversioned.read(at, undefined, 64)).resolves.toEqual(Buffer.from('overwritten'));
  });
});
