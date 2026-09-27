/**
 * The collection-permission probe asks the store without removing anything, and reads its
 * answers the way the store means them: 403 is "not this key", anything else from the delete is
 * the store answering about an object that does not exist — after it authorized the request.
 */

import {
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { S3SweepableObjectStore, isAccessDenied } from './sweep-store.js';

const store = () =>
  new S3SweepableObjectStore({
    endpoint: 'http://127.0.0.1:9',
    region: 'us-east-1',
    accessKeyId: 'probe',
    secretAccessKey: 'probe-secret',
    bucket: 'kf-artifacts',
  });

const failure = (name: string, status: number): Error =>
  Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('probeCollectionPermissions', () => {
  it('reports each refused action, and deletes only a random probe key by explicit version', async () => {
    const sent: unknown[] = [];
    vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: unknown) => {
      sent.push(command);
      if (command instanceof ListObjectsV2Command) return {};
      if (command instanceof ListObjectVersionsCommand) throw failure('AccessDenied', 403);
      if (command instanceof DeleteObjectCommand) throw failure('AccessDenied', 403);
      throw new Error('unexpected command');
    });
    await expect(store().probeCollectionPermissions('ingest/org/')).resolves.toEqual({
      listBucket: true,
      listBucketVersions: false,
      deleteObjectVersion: false,
    });
    const deletes = sent.filter((c): c is DeleteObjectCommand => c instanceof DeleteObjectCommand);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.input.Key).toMatch(/^ingest\/org\/kf-permission-probe-[0-9a-f-]{36}$/);
    // An explicit version: never a delete marker, so a permitted probe changes nothing.
    expect(deletes[0]!.input.VersionId).toBe('null');
  });

  it('reads "no such version" on the probe delete as permitted', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: unknown) => {
      if (command instanceof DeleteObjectCommand) throw failure('NoSuchVersion', 404);
      return {};
    });
    await expect(store().probeCollectionPermissions('ingest/org/')).resolves.toEqual({
      listBucket: true,
      listBucketVersions: true,
      deleteObjectVersion: true,
    });
  });

  it('does not claim a list permission from a missing bucket', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => {
      throw failure('NoSuchBucket', 404);
    });
    await expect(store().probeCollectionPermissions('ingest/org/')).rejects.toThrow('NoSuchBucket');
  });
});

describe('isAccessDenied', () => {
  it('recognizes the SDK error name and a bare 403, and nothing else', () => {
    expect(isAccessDenied(failure('AccessDenied', 403))).toBe(true);
    expect(isAccessDenied(failure('Forbidden', 403))).toBe(true);
    expect(isAccessDenied(failure('NoSuchKey', 404))).toBe(false);
    expect(isAccessDenied('AccessDenied')).toBe(false);
  });
});
