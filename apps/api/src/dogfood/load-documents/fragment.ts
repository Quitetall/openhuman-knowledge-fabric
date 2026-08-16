import { randomUUID } from 'node:crypto';
import type { Tx } from '@kf/database';
import type {
  DogfoodActionContext,
  DogfoodExecute,
  DogfoodIdentity,
  StagedSource,
} from '../contracts.js';
import { allocateNewFragmentIds } from '../identifiers.js';
import { currentFragmentSource, fragmentRevisionCreatedByAction } from '../repository.js';
import type { LoadedFragment } from './contracts.js';

export async function loadFragment(
  tx: Tx,
  execute: DogfoodExecute,
  identity: DogfoodIdentity,
  common: DogfoodActionContext,
  source: StagedSource,
  versionId: string,
): Promise<LoadedFragment> {
  const { entry, mediaType, sha256 } = source;
  const stableKey = `openhuman.constitution.${entry.documentNumber}`;
  const currentFragment = await currentFragmentSource(tx, identity.organizationId, stableKey);
  if (currentFragment !== undefined && currentFragment.holderKind !== 'fabric_native') {
    throw new Error(
      `Dogfood loader cannot transfer Holder authority for existing source ${stableKey}.`,
    );
  }
  if (
    currentFragment !== undefined &&
    currentFragment.revisionHolderId === currentFragment.holderId &&
    currentFragment.artifactVersionId === versionId &&
    currentFragment.contentDigest === sha256 &&
    currentFragment.mediaType === mediaType &&
    currentFragment.classification === 'internal'
  ) {
    return {
      fragmentId: currentFragment.objectId,
      fragmentRevisionId: currentFragment.revisionId,
      replayed: true,
    };
  }
  if (currentFragment === undefined) {
    return addFragment(tx, execute, identity, common, source, stableKey, versionId);
  }
  const fragment = await execute(tx, {
    ...common,
    actionType: 'revise_authored_fragment',
    targetIds: [currentFragment.objectId],
    idempotencyKey: `dogfood:${entry.documentNumber}:${entry.revision}:${sha256}:fragment`,
    payload: {
      revision_id: randomUUID(),
      previous_revision_id: currentFragment.revisionId,
      holder_id: randomUUID(),
      previous_holder_id: currentFragment.holderId,
      holder: {
        kind: 'fabric_native',
        artifact_version_id: versionId,
        content_digest: sha256,
      },
      media_type: mediaType,
      classification: 'internal',
    },
  });
  const recorded = await fragmentRevisionCreatedByAction(
    tx,
    identity.organizationId,
    fragment.actionId,
  );
  if (recorded.objectId !== currentFragment.objectId) {
    throw new Error('revise_authored_fragment replay names a different fragment');
  }
  return {
    fragmentId: recorded.objectId,
    fragmentRevisionId: recorded.revisionId,
    replayed: fragment.replayed,
  };
}

async function addFragment(
  tx: Tx,
  execute: DogfoodExecute,
  identity: DogfoodIdentity,
  common: DogfoodActionContext,
  source: StagedSource,
  stableKey: string,
  versionId: string,
): Promise<LoadedFragment> {
  const { entry, mediaType, sha256 } = source;
  const ids = allocateNewFragmentIds();
  const fragment = await execute(tx, {
    ...common,
    actionType: 'add_authored_fragment',
    idempotencyKey: `dogfood:${entry.documentNumber}:${entry.revision}:${sha256}:fragment`,
    payload: {
      title: entry.title,
      stable_key: stableKey,
      holder_id: ids.holderId,
      holder: {
        kind: 'fabric_native',
        artifact_version_id: versionId,
        content_digest: sha256,
      },
      revision_id: ids.revisionId,
      media_type: mediaType,
      classification: 'internal',
      document_policy: 'ordinary',
    },
  });
  const createdId = fragment.objectIds[0];
  if (createdId === undefined) throw new Error('add_authored_fragment returned no object id');
  const recorded = await fragmentRevisionCreatedByAction(
    tx,
    identity.organizationId,
    fragment.actionId,
  );
  if (recorded.objectId !== createdId) {
    throw new Error('add_authored_fragment replay names a different fragment');
  }
  return {
    fragmentId: recorded.objectId,
    fragmentRevisionId: recorded.revisionId,
    replayed: fragment.replayed,
  };
}
