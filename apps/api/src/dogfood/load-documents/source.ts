import type { ObjectStore } from '@kf/artifacts';
import type { Tx } from '@kf/database';
import type {
  DogfoodActionContext,
  DogfoodExecute,
  DogfoodIdentity,
  StagedSource,
} from '../contracts.js';
import { loadArtifact } from './artifact.js';
import type { LoadedSourceResult } from './contracts.js';
import { loadControlledDocument } from './controlled-document.js';
import { loadFragment } from './fragment.js';

export async function loadSource(
  tx: Tx,
  store: ObjectStore,
  execute: DogfoodExecute,
  identity: DogfoodIdentity,
  common: DogfoodActionContext,
  source: StagedSource,
): Promise<LoadedSourceResult> {
  const artifact = await loadArtifact(tx, store, execute, identity, common, source);
  const fragment = await loadFragment(tx, execute, identity, common, source, artifact.versionId);
  const document = await loadControlledDocument(
    tx,
    execute,
    identity,
    common,
    source,
    artifact.versionId,
  );
  const { entry, sha256 } = source;
  return {
    fragmentRevisionId: fragment.fragmentRevisionId,
    loaded: {
      documentNumber: entry.documentNumber,
      revision: entry.revision,
      documentId: document.documentId,
      artifactId: artifact.artifactId,
      fragmentId: fragment.fragmentId,
      fragmentRevisionId: fragment.fragmentRevisionId,
      sha256,
      replayed: artifact.replayed && fragment.replayed && document.replayed,
    },
  };
}
