import {
  digestOf,
  ObjectReadLimitExceeded,
  type ObjectStore,
  type StoredObject,
} from '../store.js';
import { ArtifactRejected, type UploadTicket, type VerifiedUpload } from './artifact-contracts.js';

export function objectKey(artifactId: string, claimedSha256: string): string {
  return `artifacts/${artifactId}/${claimedSha256}`;
}

const DEFAULT_TICKET_SECONDS = 900;

export async function beginUpload(
  store: ObjectStore,
  spec: {
    readonly artifactId: string;
    readonly claimedSha256: string;
    readonly mediaType: string;
    readonly expiresInSeconds?: number;
  },
): Promise<UploadTicket> {
  if (!/^[0-9a-f]{64}$/.test(spec.claimedSha256)) {
    throw new ArtifactRejected(
      'digest_mismatch',
      'claimed digest is not a 64-character lowercase hex SHA-256',
      { claimed: spec.claimedSha256 },
    );
  }
  const key = objectKey(spec.artifactId, spec.claimedSha256);
  const expiresIn = spec.expiresInSeconds ?? DEFAULT_TICKET_SECONDS;
  return {
    key,
    url: await store.presignPut(key, spec.mediaType, expiresIn),
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  };
}

export async function verifyUpload(
  store: ObjectStore,
  spec: {
    readonly key: string;
    readonly claimedSha256: string;
    readonly claimedSizeBytes?: number;
  },
): Promise<VerifiedUpload> {
  const head: StoredObject | undefined = await store.head(spec.key);
  if (head === undefined) {
    throw new ArtifactRejected('not_uploaded', 'no object at that key', { key: spec.key });
  }
  if (head.sizeBytes === 0) {
    throw new ArtifactRejected('empty_object', 'the uploaded object is empty', { key: spec.key });
  }
  if (head.versionId === undefined || head.versionId.trim() === '' || head.versionId === 'null') {
    throw new ArtifactRejected(
      'unversioned_storage',
      'object store did not return an immutable version id',
      { key: spec.key },
    );
  }
  if (spec.claimedSizeBytes !== undefined && head.sizeBytes !== spec.claimedSizeBytes) {
    throw new ArtifactRejected('size_mismatch', 'stored size differs from the claim', {
      key: spec.key,
      claimed: spec.claimedSizeBytes,
      stored: head.sizeBytes,
    });
  }

  let bytes: Buffer;
  try {
    bytes = await store.read(spec.key, head.versionId, head.sizeBytes);
  } catch (error: unknown) {
    if (error instanceof ObjectReadLimitExceeded) {
      throw new ArtifactRejected('size_mismatch', 'stored bytes exceed object metadata size', {
        key: spec.key,
        stored: head.sizeBytes,
      });
    }
    throw error;
  }
  if (bytes.length !== head.sizeBytes) {
    throw new ArtifactRejected('size_mismatch', 'stored bytes differ from object metadata size', {
      key: spec.key,
      stored: head.sizeBytes,
      actual: bytes.length,
    });
  }
  const actual = digestOf(bytes);
  if (actual !== spec.claimedSha256) {
    throw new ArtifactRejected('digest_mismatch', 'stored bytes do not match the claimed digest', {
      key: spec.key,
      claimed: spec.claimedSha256,
      actual,
    });
  }

  return {
    key: spec.key,
    sha256: actual,
    sizeBytes: bytes.length,
    storageVersion: head.versionId,
  };
}
