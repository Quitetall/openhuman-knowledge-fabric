import type { Tx } from '@kf/database';
import { digestOf, ObjectReadLimitExceeded, type ObjectStore } from '../store.js';
import type { VerificationFailure, VerifiedUpload } from './artifact-contracts.js';

export async function recordVersion(
  tx: Tx,
  spec: {
    readonly artifactId: string;
    readonly verified: VerifiedUpload;
    readonly mediaType: string;
    readonly createdBy: string;
    readonly createdByAction?: string;
    readonly revisionLabel?: string;
  },
): Promise<{ id: string; versionNo: number }> {
  const { next } = await tx.one<{ next: number }>('select content.next_version_no($1) as next', [
    spec.artifactId,
  ]);
  const row = await tx.one<{ id: string }>(
    `insert into content.artifact_version
       (artifact_id, version_no, revision_label, sha256, size_bytes, media_type,
        storage_uri, storage_version, created_by, created_by_action)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     returning id`,
    [
      spec.artifactId,
      next,
      spec.revisionLabel ?? null,
      spec.verified.sha256,
      spec.verified.sizeBytes,
      spec.mediaType,
      spec.verified.key,
      spec.verified.storageVersion,
      spec.createdBy,
      spec.createdByAction ?? null,
    ],
  );
  return { id: row.id, versionNo: Number(next) };
}

export async function verifyRecordedVersion(
  store: ObjectStore,
  version: {
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly storageUri: string | null;
    readonly storageVersion: string | null;
  },
): Promise<{ ok: true } | { ok: false; failure: VerificationFailure; detail: string }> {
  if (version.storageUri === null) {
    return { ok: false, failure: 'not_uploaded', detail: 'no storage_uri — bytes held elsewhere' };
  }
  if (
    version.storageVersion === null ||
    version.storageVersion.trim() === '' ||
    version.storageVersion === 'null'
  ) {
    return {
      ok: false,
      failure: 'unversioned_storage',
      detail: `object has no immutable storage version: ${version.storageUri}`,
    };
  }
  const head = await store.head(version.storageUri, version.storageVersion);
  if (head === undefined) {
    return { ok: false, failure: 'not_uploaded', detail: `object missing: ${version.storageUri}` };
  }
  const expectedSize = Number(version.sizeBytes);
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    return {
      ok: false,
      failure: 'size_mismatch',
      detail: `invalid recorded size: ${String(version.sizeBytes)}`,
    };
  }
  let bytes: Buffer;
  try {
    bytes = await store.read(version.storageUri, version.storageVersion, expectedSize);
  } catch (error: unknown) {
    if (error instanceof ObjectReadLimitExceeded) {
      return {
        ok: false,
        failure: 'size_mismatch',
        detail: `expected ${expectedSize} bytes, stored object exceeds that bound`,
      };
    }
    throw error;
  }
  if (bytes.length !== expectedSize) {
    return {
      ok: false,
      failure: 'size_mismatch',
      detail: `expected ${version.sizeBytes} bytes, found ${bytes.length}`,
    };
  }
  const actual = digestOf(bytes);
  if (actual !== version.sha256) {
    return {
      ok: false,
      failure: 'digest_mismatch',
      detail: `expected ${version.sha256}, found ${actual}`,
    };
  }
  return { ok: true };
}
