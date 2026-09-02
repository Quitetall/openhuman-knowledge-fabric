import {
  digestOf,
  ObjectReadLimitExceeded,
  readVersionBytes,
  type ObjectStore,
  type StoreRegistry,
} from '@kf/artifacts';
import { setAccessContext, withTransaction, type Pool, type Tx } from '@kf/database';

export interface VerifiedStoredBytes {
  /** The artifact version whose bytes these are — what the location ledger is keyed by. */
  readonly versionId: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly storageUri: string;
  readonly storageVersion: string;
}

export interface StoredDocumentBytes extends VerifiedStoredBytes {
  readonly documentNumber: string;
  readonly revision: string;
}

export class DocumentBytesUnavailable extends Error {
  constructor(
    readonly failure: 'missing_identity' | 'too_large' | 'size_mismatch' | 'digest_mismatch',
  ) {
    super(`document bytes unavailable: ${failure}`);
    this.name = 'DocumentBytesUnavailable';
  }
}

export async function documentSourceBytes(
  tx: Tx,
  documentId: string,
  maxBytes: number,
): Promise<StoredDocumentBytes | undefined> {
  const row = await tx.maybeOne<{
    document_number: string;
    revision: string;
    media_type: string;
    size_bytes: string;
    sha256: string;
    storage_uri: string | null;
    storage_version: string | null;
    version_id: string;
  }>(
    `select /* document.source-bytes */
            d.document_number, d.revision, version.media_type, version.size_bytes,
            version.sha256, version.storage_uri, version.storage_version,
            version.id as version_id
       from quality.controlled_document d
       join core.object document_object on document_object.id = d.id
       join content.artifact_version version on version.id = d.content_version
       join content.artifact artifact on artifact.id = version.artifact_id
       join core.object artifact_object on artifact_object.id = artifact.id
      where d.id = $1`,
    [documentId],
  );
  if (row === undefined) return undefined;
  const sizeBytes = Number(row.size_bytes);
  if (
    row.storage_uri === null ||
    row.storage_uri.trim() === '' ||
    row.storage_version === null ||
    row.storage_version.trim() === '' ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0 ||
    !/^[0-9a-f]{64}$/.test(row.sha256) ||
    row.media_type.trim() === ''
  ) {
    throw new DocumentBytesUnavailable('missing_identity');
  }
  if (sizeBytes > maxBytes) throw new DocumentBytesUnavailable('too_large');
  return {
    documentNumber: row.document_number,
    revision: row.revision,
    mediaType: row.media_type,
    sizeBytes,
    sha256: row.sha256,
    storageUri: row.storage_uri,
    storageVersion: row.storage_version,
    versionId: row.version_id,
  };
}

export interface ServedBytes {
  readonly bytes: Buffer;
  /** `working` when the working copy served; otherwise the role of the location that did. */
  readonly servedFrom: string;
}

/**
 * Read from the working copy and verify; when that fails and a degraded reader is supplied
 * (ADR 0017: every location whose last verification matched, hashed again before serving),
 * serve from there and say so. Bytes from either path are verified against the recorded
 * identity here, so a fallback cannot serve what the record does not describe.
 */
export async function readVerifiedDocumentBytes(
  store: ObjectStore,
  source: VerifiedStoredBytes,
  degraded?: () => Promise<{ bytes: Buffer; servedFrom: string } | undefined>,
): Promise<ServedBytes> {
  // The working copy first. Any failure to obtain verified bytes from it — missing object,
  // transport error, over the ceiling, wrong size, wrong digest — is a reason to try a copy
  // when one can be tried; without a degraded reader, the failure is reported as before.
  let failure: DocumentBytesUnavailable | undefined;
  let transport: unknown;
  try {
    const bytes = await store.read(source.storageUri, source.storageVersion, source.sizeBytes);
    if (bytes.byteLength !== source.sizeBytes) {
      failure = new DocumentBytesUnavailable('size_mismatch');
    } else if (digestOf(bytes) !== source.sha256) {
      failure = new DocumentBytesUnavailable('digest_mismatch');
    } else {
      return { bytes, servedFrom: 'working' };
    }
  } catch (error: unknown) {
    if (error instanceof ObjectReadLimitExceeded) {
      failure = new DocumentBytesUnavailable('size_mismatch');
    } else {
      transport = error;
    }
  }
  if (degraded !== undefined) {
    const served = await degraded();
    if (
      served !== undefined &&
      served.bytes.byteLength === source.sizeBytes &&
      digestOf(served.bytes) === source.sha256
    ) {
      return served;
    }
  }
  if (failure !== undefined) throw failure;
  throw transport;
}

/**
 * The degraded reader the byte routes hand to `readVerifiedDocumentBytes`: every location of
 * the version whose last verification matched, read under the caller's own access context.
 */
export function degradedReadFrom(
  pool: Pool,
  identity: { readonly organizationId: string; readonly maxClassification: string },
  stores: StoreRegistry,
  versionId: string,
): () => Promise<{ bytes: Buffer; servedFrom: string } | undefined> {
  return () =>
    withTransaction(pool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: identity.organizationId,
        maxClassification: identity.maxClassification,
      });
      const served = await readVersionBytes(tx, stores, versionId);
      return served === undefined
        ? undefined
        : { bytes: served.bytes, servedFrom: served.servedFrom.role };
    });
}
