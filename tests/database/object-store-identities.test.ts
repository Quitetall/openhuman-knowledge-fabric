/**
 * The identities a host's object store is given grant what each service needs, and no more than
 * SeaweedFS can express.
 *
 * deploy/object-store/render-identities.mjs turns the services' secret files into the store's
 * identities file; provision-host.sh runs it. This renders a set the same way and runs it in the
 * real store (the compose service's image and arguments), then asks the store, as each identity:
 *
 *   - the API's key writes, reads and lists the artifacts bucket;
 *   - the restore drill's key reads and lists it and cannot write;
 *   - the storage sweep's key passes `--check-permissions`' own probe under each evidence
 *     namespace (list, list versions, delete a version), and is refused deletion anywhere else —
 *     the orphan-collection policy, in SeaweedFS's form.
 *
 * SeaweedFS has no separate delete action: its `Write` scope also permits PUT under the same
 * prefixes. That is wider than the policy's s3:DeleteObjectVersion and is stated, not hidden.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3ObjectStore, S3SweepableObjectStore, isAccessDenied } from '@kf/artifacts';
import { PreservationObjectStore, type StartedStore } from './preservation-object-store.js';

const REPO = resolve(import.meta.dirname, '../..');
const RENDER = join(REPO, 'deploy/object-store/render-identities.mjs');
const POLICY = join(REPO, 'deploy/object-store/kf-storage-orphan-collection.policy.json');
const BUCKET = 'kf-artifacts';
const ROLES = { 'kf-api': 'app', 'kf-storage': 'storage', 'kf-drill': 'readonly' } as const;

const work = mkdtempSync(join(tmpdir(), 'kf-identities-'));
const secrets = Object.fromEntries(
  Object.keys(ROLES).map((name) => [name, randomBytes(36).toString('base64')]),
) as Record<keyof typeof ROLES, string>;

function render(): { identities: unknown[] } {
  const lines = Object.entries(ROLES).map(([name, role]) => {
    writeFileSync(join(work, name), secrets[name as keyof typeof ROLES], { mode: 0o600 });
    return `${name}|${join(work, name)}|${role}`;
  });
  const out = join(work, 'identities.json');
  execFileSync(process.execPath, [RENDER, out, POLICY, BUCKET], {
    env: { KF_OBJECTS_IDENTITIES: lines.join('\n') },
  });
  return JSON.parse(readFileSync(out, 'utf8')) as { identities: unknown[] };
}

let fixture: PreservationObjectStore;
let started: StartedStore;

beforeAll(async () => {
  fixture = new PreservationObjectStore([BUCKET], render().identities);
  started = await fixture.start();
}, 180_000);

afterAll(async () => {
  await fixture.stop();
  rmSync(work, { recursive: true, force: true });
});

function as(name: keyof typeof ROLES) {
  const config = {
    endpoint: started.endpoint,
    region: 'us-east-1',
    accessKeyId: name,
    secretAccessKey: secrets[name],
    bucket: BUCKET,
    forcePathStyle: true,
  };
  return { store: new S3ObjectStore(config), sweep: new S3SweepableObjectStore(config) };
}

async function refusal(promise: Promise<unknown>): Promise<boolean> {
  return promise.then(
    () => false,
    (error: unknown) => {
      if (isAccessDenied(error)) return true;
      throw error;
    },
  );
}

describe("a host's object-store identities", () => {
  it('lets the API write, read and list the artifacts bucket', async () => {
    const { store, sweep } = as('kf-api');
    const written = await store.put(
      'ingest/org-a/x.pdf',
      Buffer.from('evidence'),
      'application/pdf',
    );
    expect(written.versionId).toMatch(/^[0-9a-f]{32}$/);
    await expect(store.read('ingest/org-a/x.pdf', written.versionId, 64)).resolves.toEqual(
      Buffer.from('evidence'),
    );
    expect((await sweep.probeCollectionPermissions('ingest/org-a/')).listBucketVersions).toBe(true);
  });

  it('lets the restore drill read and list, and refuses its writes', async () => {
    const { store, sweep } = as('kf-drill');
    await expect(store.head('ingest/org-a/x.pdf')).resolves.toMatchObject({ sizeBytes: 8 });
    expect(await refusal(store.put('ingest/org-a/y.pdf', Buffer.from('no'), 'text/plain'))).toBe(
      true,
    );
    expect(await sweep.probeCollectionPermissions('ingest/org-a/')).toEqual({
      listBucket: true,
      listBucketVersions: true,
      deleteObjectVersion: false,
    });
  });

  it("gives the storage sweep exactly the policy's deletion, under the evidence prefixes only", async () => {
    const { sweep, store } = as('kf-storage');
    for (const namespace of ['ingest', 'document-imports']) {
      expect(await sweep.probeCollectionPermissions(`${namespace}/org-a/`), namespace).toEqual({
        listBucket: true,
        listBucketVersions: true,
        deleteObjectVersion: true,
      });
    }
    expect((await sweep.probeCollectionPermissions('checkpoints/org-a/')).deleteObjectVersion).toBe(
      false,
    );
    expect(
      await refusal(store.put('checkpoints/org-a/z.json', Buffer.from('{}'), 'application/json')),
    ).toBe(true);
    // And it really removes a version where it may.
    const { store: api } = as('kf-api');
    await api.put('ingest/org-a/orphan.pdf', Buffer.from('orphan'), 'application/pdf');
    await expect(sweep.deleteEveryVersion('ingest/org-a/orphan.pdf')).resolves.toBe(1);
  });
});
