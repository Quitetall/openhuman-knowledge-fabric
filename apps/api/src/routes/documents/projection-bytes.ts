import type { Tx } from '@kf/database';
import { DocumentBytesUnavailable, type VerifiedStoredBytes } from './source-bytes.js';

export interface StoredProjectionBytes extends VerifiedStoredBytes {
  readonly target: string;
}

export async function documentProjectionBytes(
  tx: Tx,
  basisId: string,
  viewId: string,
  maxBytes: number,
): Promise<StoredProjectionBytes | undefined> {
  const row = await tx.maybeOne<{
    target: string;
    media_type: string;
    size_bytes: string;
    sha256: string;
    storage_uri: string | null;
    storage_version: string | null;
    version_id: string;
  }>(
    `select /* document.projection-bytes */
            view.target, view.media_type, version.size_bytes, version.sha256,
            version.storage_uri, version.storage_version, version.id as version_id
       from content.compiled_view view
       join content.compilation_run run
         on run.id = view.compilation_run_id and run.run_status = 'succeeded'
       join content.artifact_version version
         on version.id = view.artifact_version_id and version.sha256 = view.content_digest
       join content.artifact artifact on artifact.id = version.artifact_id
       join core.object artifact_object on artifact_object.id = artifact.id
      where view.id = $1 and run.basis_id = $2`,
    [viewId, basisId],
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
    row.media_type.trim() === '' ||
    row.target.trim() === ''
  ) {
    throw new DocumentBytesUnavailable('missing_identity');
  }
  if (sizeBytes > maxBytes) throw new DocumentBytesUnavailable('too_large');
  return {
    target: row.target,
    mediaType: row.media_type,
    sizeBytes,
    sha256: row.sha256,
    storageUri: row.storage_uri,
    storageVersion: row.storage_version,
    versionId: row.version_id,
  };
}
