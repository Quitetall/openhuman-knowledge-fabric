import type { ObjectStore } from '@kf/artifacts';
import type { Tx } from '@kf/database';
import type {
  DogfoodActionContext,
  DogfoodExecute,
  DogfoodIdentity,
  LoadedDogfoodDocument,
  StagedSource,
} from './contracts.js';
import { loadSource } from './load-documents/source.js';

export async function loadDogfoodDocuments(
  tx: Tx,
  store: ObjectStore,
  execute: DogfoodExecute,
  identity: DogfoodIdentity,
  common: DogfoodActionContext,
  sources: readonly StagedSource[],
): Promise<{
  readonly loaded: readonly LoadedDogfoodDocument[];
  readonly fragmentRevisionIds: readonly string[];
}> {
  const loaded: LoadedDogfoodDocument[] = [];
  const fragmentRevisionIds: string[] = [];
  for (const source of sources) {
    const result = await loadSource(tx, store, execute, identity, common, source);
    loaded.push(result.loaded);
    fragmentRevisionIds.push(result.fragmentRevisionId);
  }
  return { loaded, fragmentRevisionIds };
}
