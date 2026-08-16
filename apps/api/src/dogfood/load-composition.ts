import { randomUUID } from 'node:crypto';
import { digestOf, type ObjectStore } from '@kf/artifacts';
import type { Tx } from '@kf/database';
import type {
  DogfoodActionContext,
  DogfoodExecute,
  DogfoodIdentity,
  LoadedDogfoodComposition,
  StagedManifest,
} from './contracts.js';
import {
  artifactVersionCreatedByAction,
  compositionRevisionCreatedByAction,
  currentCompositionSource,
  legacyArtifactMaterialization,
} from './repository.js';
import type { CurrentCompositionInput } from './repository.js';

function isExactFragmentSequence(
  inputs: readonly CurrentCompositionInput[],
  expectedRevisionIds: readonly string[],
): boolean {
  return (
    inputs.length === expectedRevisionIds.length &&
    inputs.every(
      (input, index) =>
        input.ordinal === index + 1 &&
        input.inputRole === 'fragment' &&
        input.fragmentRevisionId === expectedRevisionIds[index],
    )
  );
}

export async function loadDogfoodComposition(
  tx: Tx,
  store: ObjectStore,
  execute: DogfoodExecute,
  identity: DogfoodIdentity,
  common: DogfoodActionContext,
  manifest: StagedManifest,
  fragmentRevisionIds: readonly string[],
): Promise<LoadedDogfoodComposition> {
  const manifestArtifactKey = `dogfood:document-constitution:${manifest.sha256}:artifact`;
  const legacyManifest = await legacyArtifactMaterialization(
    tx,
    store,
    identity.organizationId,
    identity.actorId,
    manifestArtifactKey,
    {
      title: manifest.fileName,
      artifactKind: 'specification',
      sha256: manifest.sha256,
      sizeBytes: manifest.bytes.length,
      mediaType: 'application/json',
      storageUri: manifest.key,
      requiresDocumentParse: false,
    },
  );
  let manifestArtifactId: string;
  let manifestVersionId: string;
  let manifestArtifactReplayed: boolean;
  if (legacyManifest !== undefined) {
    manifestArtifactId = legacyManifest.artifactId;
    manifestVersionId = legacyManifest.versionId;
    manifestArtifactReplayed = true;
  } else {
    const manifestArtifact = await execute(tx, {
      ...common,
      actionType: 'attach_evidence',
      idempotencyKey: manifestArtifactKey,
      payload: {
        title: manifest.fileName,
        artifact_kind: 'specification',
        sha256: manifest.sha256,
        size_bytes: manifest.bytes.length,
        media_type: 'application/json',
        storage_uri: manifest.key,
      },
    });
    const createdArtifactId = manifestArtifact.objectIds[0];
    if (createdArtifactId === undefined) {
      throw new Error('constitution manifest attach_evidence returned no artifact id');
    }
    manifestArtifactId = createdArtifactId;
    manifestVersionId = (
      await artifactVersionCreatedByAction(
        tx,
        identity.organizationId,
        manifestArtifactId,
        manifestArtifact.actionId,
      )
    ).id;
    manifestArtifactReplayed = manifestArtifact.replayed;
  }
  const compositionStableKey = 'openhuman.document-constitution';
  const currentComposition = await currentCompositionSource(
    tx,
    identity.organizationId,
    compositionStableKey,
  );
  if (currentComposition !== undefined && currentComposition.holderKind !== 'fabric_native') {
    throw new Error(
      `Dogfood loader cannot transfer Holder authority for existing source ${compositionStableKey}.`,
    );
  }
  const inputs = fragmentRevisionIds.map((fragmentRevisionId, index) => ({
    ordinal: index + 1,
    role: 'fragment' as const,
    fragment_revision_id: fragmentRevisionId,
  }));
  const compositionDigest = digestOf(
    Buffer.from(JSON.stringify({ manifestSha256: manifest.sha256, fragmentRevisionIds })),
  );

  let compositionId: string;
  let compositionRevisionId: string;
  let compositionReplayed: boolean;
  if (
    currentComposition !== undefined &&
    currentComposition.revisionHolderId === currentComposition.holderId &&
    currentComposition.artifactVersionId === manifestVersionId &&
    currentComposition.contentDigest === manifest.sha256 &&
    currentComposition.classification === 'internal' &&
    isExactFragmentSequence(currentComposition.inputs, fragmentRevisionIds)
  ) {
    compositionId = currentComposition.objectId;
    compositionRevisionId = currentComposition.revisionId;
    compositionReplayed = true;
  } else if (currentComposition === undefined) {
    const requestedRevisionId = randomUUID();
    const composition = await execute(tx, {
      ...common,
      actionType: 'add_document_composition',
      idempotencyKey: `dogfood:document-constitution:${compositionDigest}:composition`,
      payload: {
        title: 'OpenHuman Document Constitution',
        stable_key: compositionStableKey,
        holder_id: randomUUID(),
        holder: {
          kind: 'fabric_native',
          artifact_version_id: manifestVersionId,
          content_digest: manifest.sha256,
        },
        revision_id: requestedRevisionId,
        classification: 'internal',
        document_policy: 'ordinary',
        inputs,
      },
    });
    const createdId = composition.objectIds[0];
    if (createdId === undefined) {
      throw new Error('add_document_composition returned no object id');
    }
    const recorded = await compositionRevisionCreatedByAction(
      tx,
      identity.organizationId,
      composition.actionId,
    );
    if (recorded.objectId !== createdId) {
      throw new Error('add_document_composition replay names a different composition');
    }
    compositionId = recorded.objectId;
    compositionRevisionId = recorded.revisionId;
    compositionReplayed = composition.replayed;
  } else {
    const composition = await execute(tx, {
      ...common,
      actionType: 'revise_document_composition',
      targetIds: [currentComposition.objectId],
      idempotencyKey: `dogfood:document-constitution:${compositionDigest}:composition`,
      payload: {
        revision_id: randomUUID(),
        previous_revision_id: currentComposition.revisionId,
        holder_id: randomUUID(),
        previous_holder_id: currentComposition.holderId,
        holder: {
          kind: 'fabric_native',
          artifact_version_id: manifestVersionId,
          content_digest: manifest.sha256,
        },
        classification: 'internal',
        inputs,
      },
    });
    const recorded = await compositionRevisionCreatedByAction(
      tx,
      identity.organizationId,
      composition.actionId,
    );
    if (recorded.objectId !== currentComposition.objectId) {
      throw new Error('revise_document_composition replay names a different composition');
    }
    compositionId = recorded.objectId;
    compositionRevisionId = recorded.revisionId;
    compositionReplayed = composition.replayed;
  }
  return {
    compositionId,
    compositionRevisionId,
    manifestArtifactId,
    manifestSha256: manifest.sha256,
    replayed: manifestArtifactReplayed && compositionReplayed,
  };
}
