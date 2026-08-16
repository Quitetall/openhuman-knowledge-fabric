import { setAccessContext, withTransaction, type Pool } from '@kf/database';
import type { ObjectStore } from '@kf/artifacts';
import type {
  DogfoodActionContext,
  DogfoodExecute,
  DogfoodIdentity,
  LoadedDogfoodComposition,
  LoadedDogfoodDocument,
  StagedConstitution,
} from './contracts.js';
import { loadDogfoodComposition } from './load-composition.js';
import { loadDogfoodDocuments } from './load-documents.js';

export async function loadDocumentConstitution(
  pool: Pool,
  store: ObjectStore,
  execute: DogfoodExecute,
  identity: DogfoodIdentity,
  staged: StagedConstitution,
): Promise<{
  readonly identity: DogfoodIdentity;
  readonly loaded: readonly LoadedDogfoodDocument[];
  readonly composition: LoadedDogfoodComposition;
}> {
  // Immutable, content-addressed blobs are staged before one authoritative transaction.
  // Failure leaves at most unreferenced bytes; never a partial constitution in PostgreSQL.
  return withTransaction(pool, async (tx) => {
    await setAccessContext(tx, {
      organizationId: identity.organizationId,
      maxClassification: 'restricted',
    });
    const common: DogfoodActionContext = {
      ...identity,
      maxClassification: 'restricted',
      targetIds: [],
      requestId: 'document-constitution-dogfood',
    };
    const documents = await loadDogfoodDocuments(
      tx,
      store,
      execute,
      identity,
      common,
      staged.sources,
    );
    const composition = await loadDogfoodComposition(
      tx,
      store,
      execute,
      identity,
      common,
      staged.manifest,
      documents.fragmentRevisionIds,
    );
    return { identity, loaded: documents.loaded, composition };
  });
}
