import { digestOf, type ObjectStore, type StoredObject } from '@kf/artifacts';
import type { CompilationRun } from '@kf/documents';
import type { MaterializedCompiledView, RecordedCompiledView } from './types.js';
import { requireUuid } from './validation.js';

export class MaterializationIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaterializationIntegrityError';
  }
}

export async function verifyStoredView(
  store: ObjectStore,
  view: RecordedCompiledView,
): Promise<void> {
  if (view.storageVersion.trim() === '' || view.storageVersion === 'null') {
    throw new MaterializationIntegrityError(
      `recorded compiled view has no immutable version for target ${view.target}`,
    );
  }
  const bytes = await store.read(view.storageUri, view.storageVersion, view.sizeBytes);
  if (bytes.length !== view.sizeBytes) {
    throw new MaterializationIntegrityError(
      `recorded compiled view size mismatch for target ${view.target}`,
    );
  }
  if (digestOf(bytes) !== view.contentDigest) {
    throw new MaterializationIntegrityError(
      `recorded compiled view digest mismatch for target ${view.target}`,
    );
  }
}

async function verifiedStoredObject(
  store: ObjectStore,
  key: string,
  bytes: Buffer,
  mediaType: string,
): Promise<StoredObject & { readonly versionId: string }> {
  let stored = await store.head(key);
  if (stored === undefined) stored = await store.put(key, bytes, mediaType);
  if (stored.key !== key || stored.sizeBytes !== bytes.length) {
    throw new MaterializationIntegrityError(`object store metadata mismatch for ${key}`);
  }
  if (
    stored.versionId === undefined ||
    stored.versionId.trim() === '' ||
    stored.versionId === 'null'
  ) {
    throw new MaterializationIntegrityError(`object store versioning is required for ${key}`);
  }
  const verified = await store.read(key, stored.versionId, bytes.length);
  if (verified.length !== bytes.length || digestOf(verified) !== digestOf(bytes)) {
    throw new MaterializationIntegrityError(`object store read-back mismatch for ${key}`);
  }
  return { ...stored, versionId: stored.versionId };
}

export async function materializeViews(
  store: ObjectStore,
  run: CompilationRun,
  idFactory: () => string,
): Promise<readonly MaterializedCompiledView[]> {
  const materialized: MaterializedCompiledView[] = [];
  for (const view of run.views) {
    const bytes = Buffer.from(view.bytesBase64, 'base64');
    const storageUri = `compiled-views/sha256/${view.contentDigest}`;
    const stored = await verifiedStoredObject(store, storageUri, bytes, view.mediaType);
    materialized.push(
      Object.freeze({
        id: requireUuid(idFactory(), 'compiled view id'),
        artifactId: requireUuid(idFactory(), 'compiled artifact id'),
        artifactVersionId: requireUuid(idFactory(), 'compiled artifact version id'),
        target: view.target,
        mediaType: view.mediaType,
        contentDigest: view.contentDigest,
        sizeBytes: bytes.length,
        storageUri,
        storageVersion: stored.versionId,
      }),
    );
  }
  return Object.freeze(materialized);
}
