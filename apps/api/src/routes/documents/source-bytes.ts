import { digestOf, ObjectReadLimitExceeded, type ObjectStore } from '@kf/artifacts';
import type { Tx } from '@kf/database';

export interface VerifiedStoredBytes {
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
  }>(
    `select /* document.source-bytes */
            d.document_number, d.revision, version.media_type, version.size_bytes,
            version.sha256, version.storage_uri, version.storage_version
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
  };
}

export async function readVerifiedDocumentBytes(
  store: ObjectStore,
  source: VerifiedStoredBytes,
): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await store.read(source.storageUri, source.storageVersion, source.sizeBytes);
  } catch (error: unknown) {
    if (error instanceof ObjectReadLimitExceeded) {
      throw new DocumentBytesUnavailable('size_mismatch');
    }
    throw error;
  }
  if (bytes.byteLength !== source.sizeBytes) {
    throw new DocumentBytesUnavailable('size_mismatch');
  }
  if (digestOf(bytes) !== source.sha256) {
    throw new DocumentBytesUnavailable('digest_mismatch');
  }
  return bytes;
}
