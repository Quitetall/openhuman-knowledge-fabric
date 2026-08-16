import type { Tx } from '@kf/database';
import type {
  DogfoodActionContext,
  DogfoodExecute,
  DogfoodIdentity,
  StagedSource,
} from '../contracts.js';
import { importedControlledDocument } from '../../routes/documents/repository.js';
import { legacyControlledDocumentMaterialization } from '../repository.js';
import type { LoadedControlledDocument } from './contracts.js';

export async function loadControlledDocument(
  tx: Tx,
  execute: DogfoodExecute,
  identity: DogfoodIdentity,
  common: DogfoodActionContext,
  source: StagedSource,
  versionId: string,
): Promise<LoadedControlledDocument> {
  const { entry, sha256 } = source;
  const documentKey = `dogfood:${entry.documentNumber}:${entry.revision}:${sha256}:document`;
  const legacyDocument = await legacyControlledDocumentMaterialization(
    tx,
    identity.organizationId,
    identity.actorId,
    documentKey,
    {
      title: entry.title,
      documentClass: entry.documentClass,
      documentNumber: entry.documentNumber,
      revision: entry.revision,
      owningRole: entry.owningRole,
      contentVersionId: versionId,
    },
  );
  if (legacyDocument !== undefined) {
    return { documentId: legacyDocument.documentId, replayed: true };
  }
  const document = await execute(tx, {
    ...common,
    actionType: 'add_controlled_document',
    idempotencyKey: documentKey,
    payload: {
      title: entry.title,
      document_number: entry.documentNumber,
      revision: entry.revision,
      document_class: entry.documentClass,
      owning_role: entry.owningRole,
      content_version: versionId,
    },
  });
  const documentId = document.objectIds[0];
  if (typeof documentId !== 'string' || documentId.length === 0) {
    throw new Error('add_controlled_document returned no document id');
  }
  await assertControlledDocumentMaterialized(
    tx,
    identity.organizationId,
    documentId,
    source,
    versionId,
  );
  return { documentId, replayed: document.replayed };
}

async function assertControlledDocumentMaterialized(
  tx: Tx,
  organizationId: string,
  documentId: string,
  source: StagedSource,
  versionId: string,
): Promise<void> {
  const { entry } = source;
  const recordedDocument = await importedControlledDocument(tx, organizationId, documentId);
  if (
    recordedDocument === undefined ||
    recordedDocument.title !== entry.title ||
    recordedDocument.document_number !== entry.documentNumber ||
    recordedDocument.revision !== entry.revision ||
    recordedDocument.document_class !== entry.documentClass ||
    recordedDocument.owning_role !== entry.owningRole ||
    recordedDocument.content_version_id !== versionId
  ) {
    throw new Error('add_controlled_document did not materialize exact dogfood facts');
  }
}
