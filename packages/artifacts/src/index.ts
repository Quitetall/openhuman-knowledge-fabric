/**
 * Artifact identity and digest verification.
 *
 * The upload flow has one job beyond moving bytes: make it impossible to record a version
 * whose digest does not describe what is actually in the store. Everything downstream —
 * snapshots, releases, the preservation export — cites that digest, so a version recorded
 * from the client's claim rather than from the stored bytes would make every citation after
 * it worthless.
 *
 * So the client states a digest, uploads, and the SERVER reads the object back and computes
 * the digest itself. The client's claim is only ever used to detect a mismatch.
 */

import { digestOf, type ObjectStore, type StoredObject } from './store.js';
import type { Tx } from '@kf/database';

export {
  InMemoryObjectStore,
  S3ObjectStore,
  digestOf,
  type ObjectStore,
  type S3Config,
  type StoredObject,
} from './store.js';

export type VerificationFailure =
  'not_uploaded' | 'digest_mismatch' | 'size_mismatch' | 'empty_object';

export class ArtifactRejected extends Error {
  readonly failure: VerificationFailure;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(failure: VerificationFailure, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ArtifactRejected';
    this.failure = failure;
    this.detail = detail;
  }
}

export interface UploadTicket {
  readonly key: string;
  readonly url: string;
  readonly expiresAt: Date;
}

/**
 * Where an artifact version's bytes live.
 *
 * The artifact id and the CLAIMED digest, so two uploads of the same bytes for the same
 * artifact land on the same key and the store deduplicates them naturally. The digest is
 * re-derived on completion, so a client lying about it only misfiles its own upload — it
 * cannot cause a wrong digest to be recorded.
 */
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
    // Short-lived: a ticket that outlives the request it was issued for is a standing
    // write capability to the evidence vault.
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  };
}

export interface VerifiedUpload {
  readonly key: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly storageVersion: string | undefined;
}

/**
 * Read the uploaded object back and verify it.
 *
 * Reads the FULL bytes rather than trusting the store's metadata. An ETag is not a SHA-256
 * for multipart uploads, and a size check alone would accept any tampering that preserved
 * length — which is every interesting kind.
 */
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
    // An empty object is almost always a failed upload reported as a success.
    throw new ArtifactRejected('empty_object', 'the uploaded object is empty', { key: spec.key });
  }
  if (spec.claimedSizeBytes !== undefined && head.sizeBytes !== spec.claimedSizeBytes) {
    throw new ArtifactRejected('size_mismatch', 'stored size differs from the claim', {
      key: spec.key,
      claimed: spec.claimedSizeBytes,
      stored: head.sizeBytes,
    });
  }

  const bytes = await store.read(spec.key, head.versionId);
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

/**
 * Record a verified upload as an immutable artifact version.
 *
 * The version number comes from the database under a lock, not from the caller: two
 * concurrent uploads that each read "the latest is 3" would both write 4.
 */
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
      spec.verified.storageVersion ?? null,
      spec.createdBy,
      spec.createdByAction ?? null,
    ],
  );
  return { id: row.id, versionNo: Number(next) };
}

/**
 * Re-verify a recorded version against the store.
 *
 * This is the restore-and-audit path: given what the database says, are the bytes still
 * there and still what they were? Run over every version, it answers "is the evidence vault
 * intact" — a question no amount of database integrity can answer on its own.
 */
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
    // A version held by another system: we recorded its digest but do not hold the bytes,
    // so there is nothing here to verify. Reported rather than silently passed.
    return { ok: false, failure: 'not_uploaded', detail: 'no storage_uri — bytes held elsewhere' };
  }
  const head = await store.head(version.storageUri);
  if (head === undefined) {
    return { ok: false, failure: 'not_uploaded', detail: `object missing: ${version.storageUri}` };
  }
  const bytes = await store.read(version.storageUri, version.storageVersion ?? undefined);
  const actual = digestOf(bytes);
  if (actual !== version.sha256) {
    return {
      ok: false,
      failure: 'digest_mismatch',
      detail: `expected ${version.sha256}, found ${actual}`,
    };
  }
  if (bytes.length !== Number(version.sizeBytes)) {
    return {
      ok: false,
      failure: 'size_mismatch',
      detail: `expected ${version.sizeBytes} bytes, found ${bytes.length}`,
    };
  }
  return { ok: true };
}

export const PACKAGE = {
  name: '@kf/artifacts',
  role: 'Artifact identity and digest verification',
  owns: [],
} as const;
