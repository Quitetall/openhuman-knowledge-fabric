import { basename } from 'node:path';
import type { ObjectStore } from '@kf/artifacts';
import type { Tx } from '@kf/database';
import { artifactKindForDocumentClass } from '@kf/documents';
import type {
  DogfoodActionContext,
  DogfoodExecute,
  DogfoodIdentity,
  StagedSource,
} from '../contracts.js';
import {
  artifactVersionCreatedByAction,
  legacyArtifactMaterialization,
  replayableEvidenceKey,
} from '../repository.js';
import type { LoadedArtifact } from './contracts.js';

export async function loadArtifact(
  tx: Tx,
  store: ObjectStore,
  execute: DogfoodExecute,
  identity: DogfoodIdentity,
  common: DogfoodActionContext,
  source: StagedSource,
): Promise<LoadedArtifact> {
  const { entry, bytes, mediaType, sha256, key } = source;
  const artifactTitle = basename(entry.file);
  const artifactKind = artifactKindForDocumentClass(entry.documentClass);
  const artifactKey = `dogfood:${entry.documentNumber}:${entry.revision}:${sha256}:artifact`;
  const legacyArtifact = await legacyArtifactMaterialization(
    tx,
    store,
    identity.organizationId,
    identity.actorId,
    artifactKey,
    {
      title: artifactTitle,
      artifactKind,
      sha256,
      sizeBytes: bytes.length,
      mediaType,
      storageUri: key,
      revisionLabel: entry.revision,
      requiresDocumentParse: true,
    },
  );
  if (legacyArtifact !== undefined) {
    return {
      artifactId: legacyArtifact.artifactId,
      versionId: legacyArtifact.versionId,
      replayed: true,
    };
  }
  const request = {
    ...common,
    actionType: 'attach_evidence',
    idempotencyKey: artifactKey,
    payload: {
      title: artifactTitle,
      artifact_kind: artifactKind,
      sha256,
      size_bytes: bytes.length,
      media_type: mediaType,
      storage_uri: key,
      revision_label: entry.revision,
    },
  };
  // A database loaded before the storage key was organization-scoped replays under its old key.
  const storageUri = await replayableEvidenceKey(tx, request, sha256);
  const artifact = await execute(tx, {
    ...request,
    payload: { ...request.payload, storage_uri: storageUri },
  });
  const artifactId = artifact.objectIds[0];
  if (artifactId === undefined) throw new Error('attach_evidence returned no artifact id');
  const versionId = (
    await artifactVersionCreatedByAction(tx, identity.organizationId, artifactId, artifact.actionId)
  ).id;
  return { artifactId, versionId, replayed: artifact.replayed };
}
