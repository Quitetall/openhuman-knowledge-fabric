/**
 * The B2 ciphertext transport against a real versioned S3 store (ADR 0039).
 *
 * `offsite.test.ts` plants faults in controlled SDK responses and `offsite-wire.test.ts` on an
 * owned HTTP wire. Both decide what the store answers. Neither shows what a real versioned store
 * does when its contents change underneath a recorded copy. That is the property a restore depends
 * on, so this runs the production adapter, through its SDK seam, against a real S3 server with
 * versioning (tests/backup-restore/s3-endpoint.ts):
 *
 *   - a later upload to the same key, and a delete marker over it, leave the recorded version
 *     where it was, and `pull` restores exactly that version;
 *   - a recorded version that was permanently deleted is refused;
 *   - a version id the store never issued is refused;
 *   - a store that serves back bytes other than those it was given is refused at publish, the
 *     read-back being the only thing that can tell;
 *   - an unversioned bucket is refused before anything is written.
 *
 * The seam: the adapter accepts only a Backblaze endpoint, and the client factory it already
 * exposes for tests points the SDK at the local server instead. Everything above the HTTP
 * client is the code a host runs.
 *
 * ONE ANSWER IS SUBSTITUTED, and only one. The adapter refuses a bucket whose ACL is not a single
 * FULL_CONTROL grant to its owner, and the MinIO test double answers GetBucketAcl with an empty
 * owner id: a stub, not a policy. So GetBucketAcl alone is answered here as an owner-only bucket
 * answers it; every other request, versioning included, reaches the real store. When the
 * SeaweedFS endpoint replaces MinIO (ADR 0039), check whether this substitution is still needed.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetBucketAclCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BUCKETS,
  startS3Endpoint,
  type S3Endpoint,
} from '../../../tests/backup-restore/s3-endpoint.js';
import { B2ArchiveAdapter } from './internal/offsite/b2.js';
import type { OffsiteArchiveCopy } from './offsite.js';

const B2_ENDPOINT = 'https://s3.us-west-004.backblazeb2.com';
let s3: S3Endpoint;
const made: string[] = [];

beforeAll(async () => {
  s3 = await startS3Endpoint();
}, 120_000);
afterAll(async () => {
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true });
  await s3?.stop();
});

/** The requests that reached the adapter's client, by command, to show where a refusal came. */
let sent: string[] = [];

/** The production adapter, its SDK client pointed at `endpoint` (the real store or a proxy). */
function adapter(bucket: string, endpoint = s3.remoteEndpoint): B2ArchiveAdapter {
  sent = [];
  return new B2ArchiveAdapter(
    {
      endpoint: B2_ENDPOINT,
      bucket,
      applicationKeyId: s3.accessKeyId,
      applicationKey: s3.secretAccessKey,
    },
    (options) => {
      const client = new S3Client({ ...options, endpoint });
      const send = client.send.bind(client) as (...args: unknown[]) => Promise<unknown>;
      (client as unknown as { send: (...args: unknown[]) => Promise<unknown> }).send = async (
        command: unknown,
        ...rest: unknown[]
      ) => {
        sent.push((command as object).constructor.name);
        if (command instanceof GetBucketAclCommand) {
          return {
            $metadata: {},
            Owner: { ID: 'owner' },
            Grants: [
              { Grantee: { Type: 'CanonicalUser', ID: 'owner' }, Permission: 'FULL_CONTROL' },
            ],
          };
        }
        return send(command, ...rest);
      };
      return client;
    },
  );
}

/** An archive that begins as OpenPGP ciphertext does, unique per call. */
function archive(): { root: string; file: string; bytes: Buffer } {
  const root = mkdtempSync(join(tmpdir(), 'kf-b2-real-'));
  made.push(root);
  const bytes = Buffer.concat([Buffer.from([0x85]), randomBytes(4096)]);
  const file = join(root, 'ciphertext.tar.gpg');
  writeFileSync(file, bytes, { mode: 0o600 });
  return { root, file, bytes };
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

async function publish(bucket = BUCKETS.plain): Promise<{
  copy: OffsiteArchiveCopy;
  bytes: Buffer;
  root: string;
}> {
  const { root, file, bytes } = archive();
  const store = adapter(bucket);
  try {
    return { copy: await store.publish(file), bytes, root };
  } finally {
    store.close();
  }
}

async function pull(copy: OffsiteArchiveCopy, root: string): Promise<Buffer> {
  const store = adapter(copy.bucket);
  const destination = join(root, `pulled-${String(Date.now())}`);
  try {
    await store.pull(copy, destination);
    return readFileSync(destination);
  } finally {
    store.close();
  }
}

describe('the B2 transport against a real versioned store', () => {
  it('restores the recorded version after the key is overwritten and hidden by a delete marker', async () => {
    const { copy, bytes, root } = await publish();
    expect(copy.sha256).toBe(sha256(bytes));
    await s3.overwrite(copy.bucket, copy.key, 'replaced by somebody holding the bucket key');
    await s3.deleteMarker(copy.bucket, copy.key);
    expect(sha256(await pull(copy, root))).toBe(copy.sha256);
  });

  it('refuses a recorded version that was permanently deleted', async () => {
    const { copy, root } = await publish();
    await s3.deleteVersion(copy.bucket, copy.key, copy.versionId);
    await expect(pull(copy, root)).rejects.toMatchObject({ code: 'offsite_transfer_refused' });
    expect(sent.at(-1)).toBe('GetObjectCommand');
  });

  it('refuses a version id the store never issued', async () => {
    const { copy, root } = await publish();
    await expect(
      pull({ ...copy, versionId: '00000000-0000-4000-8000-000000000000' }, root),
    ).rejects.toMatchObject({ code: 'offsite_transfer_refused' });
    expect(sent.at(-1)).toBe('GetObjectCommand');
  });

  it('refuses at publish a store that serves back bytes other than those it was given', async () => {
    const proxy = await s3.corruptingProxy();
    const { file } = archive();
    const store = adapter(BUCKETS.plain, proxy.endpoint);
    try {
      await expect(store.publish(file)).rejects.toMatchObject({
        code: 'offsite_transfer_refused',
      });
      // Refused at the read-back: the object was written and read, not refused up front.
      expect(sent).toContain('PutObjectCommand');
      expect(sent.at(-1)).toBe('GetObjectCommand');
    } finally {
      store.close();
      await proxy.close();
    }
  });

  it('refuses an unversioned bucket', async () => {
    const { file } = archive();
    const store = adapter(BUCKETS.unversioned);
    try {
      await expect(store.publish(file)).rejects.toMatchObject({
        code: 'offsite_transfer_refused',
      });
      expect(sent).toEqual(['GetBucketVersioningCommand']);
    } finally {
      store.close();
    }
  });
});
