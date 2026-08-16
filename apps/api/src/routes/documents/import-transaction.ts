import { randomUUID } from 'node:crypto';
import { setAccessContext, withTransaction } from '@kf/database';
import { artifactKindForDocumentClass } from '@kf/documents';
import type { Caller } from '../actions.js';
import {
  IMPORT_CLASSIFICATION,
  ImportIdempotencyConflict,
  SourceHolderConflict,
  type DocumentActionContext,
  type DocumentImportResult,
  type DocumentRoutesOptions,
  type ParsedDocumentImport,
} from './contracts.js';
import {
  currentImportSource,
  importedControlledDocument,
  lockDocumentImport,
  sourceCreatedByAction,
  type ImportedFragmentSource,
} from './repository.js';

export async function persistDocumentImport(
  options: DocumentRoutesOptions,
  identity: Caller,
  sourceFacts: ParsedDocumentImport,
  common: DocumentActionContext,
): Promise<DocumentImportResult> {
  return withTransaction(options.pool, async (tx) => {
    await setAccessContext(tx, {
      organizationId: identity.organizationId,
      maxClassification: identity.maxClassification,
    });
    await lockDocumentImport(tx, identity.organizationId, sourceFacts.stableKey);
    const currentSource = await currentImportSource(
      tx,
      identity.organizationId,
      sourceFacts.stableKey,
    );
    if (currentSource !== undefined && currentSource.holder_kind !== 'fabric_native') {
      throw new SourceHolderConflict();
    }
    const artifact = await options.executeInTransaction(tx, {
      ...common,
      actionType: 'attach_evidence',
      idempotencyKey: `${sourceFacts.idempotencyKey}-artifact`,
      payload: {
        title: sourceFacts.fileName,
        artifact_kind: artifactKindForDocumentClass(sourceFacts.documentClass),
        sha256: sourceFacts.sha256,
        size_bytes: sourceFacts.bytes.length,
        media_type: sourceFacts.mediaType,
        storage_uri: sourceFacts.storageKey,
        revision_label: sourceFacts.revision,
      },
    });
    const artifactId = artifact.objectIds[0];
    if (artifactId === undefined) throw new Error('attach_evidence returned no artifact id');
    const version = await tx.one<{ id: string; sha256: string; media_type: string }>(
      `select id, sha256, media_type from content.artifact_version
        where artifact_id = $1 order by version_no desc limit 1`,
      [artifactId],
    );
    if (version.sha256 !== sourceFacts.sha256 || version.media_type !== sourceFacts.mediaType) {
      throw new ImportIdempotencyConflict();
    }

    let importedSource: ImportedFragmentSource;
    let sourceReplayed: boolean;
    if (
      currentSource !== undefined &&
      currentSource.holder_kind === 'fabric_native' &&
      currentSource.revision_holder_id === currentSource.holder_id &&
      currentSource.artifact_version_id === version.id &&
      currentSource.content_digest === sourceFacts.sha256 &&
      currentSource.media_type === sourceFacts.mediaType
    ) {
      importedSource = currentSource;
      sourceReplayed = true;
    } else {
      const fragmentAction = await options.executeInTransaction(tx, {
        ...common,
        actionType:
          currentSource === undefined ? 'add_authored_fragment' : 'revise_authored_fragment',
        targetIds: currentSource === undefined ? [] : [currentSource.fragment_id],
        idempotencyKey: `${sourceFacts.idempotencyKey}-fragment`,
        payload:
          currentSource === undefined
            ? {
                title: sourceFacts.title,
                stable_key: sourceFacts.stableKey,
                document_policy: 'ordinary',
                holder_id: randomUUID(),
                holder: {
                  kind: 'fabric_native',
                  artifact_version_id: version.id,
                  content_digest: sourceFacts.sha256,
                },
                revision_id: randomUUID(),
                media_type: sourceFacts.mediaType,
                classification: IMPORT_CLASSIFICATION,
              }
            : {
                previous_revision_id: currentSource.fragment_revision_id,
                previous_holder_id: currentSource.holder_id,
                holder_id: randomUUID(),
                holder: {
                  kind: 'fabric_native',
                  artifact_version_id: version.id,
                  content_digest: sourceFacts.sha256,
                },
                revision_id: randomUUID(),
                media_type: sourceFacts.mediaType,
                classification: currentSource.classification,
              },
      });
      const recordedSource = await sourceCreatedByAction(
        tx,
        identity.organizationId,
        fragmentAction.actionId,
      );
      if (
        recordedSource === undefined ||
        recordedSource.fragment_id !== fragmentAction.objectIds[0] ||
        recordedSource.stable_key !== sourceFacts.stableKey ||
        recordedSource.holder_kind !== 'fabric_native' ||
        recordedSource.artifact_version_id !== version.id ||
        recordedSource.content_digest !== sourceFacts.sha256 ||
        recordedSource.media_type !== sourceFacts.mediaType ||
        recordedSource.classification !==
          (currentSource?.classification ?? IMPORT_CLASSIFICATION) ||
        recordedSource.document_policy !== (currentSource?.document_policy ?? 'ordinary')
      ) {
        throw fragmentAction.replayed
          ? new ImportIdempotencyConflict()
          : new Error('authored fragment action did not record exact fabric-native source');
      }
      importedSource = recordedSource;
      sourceReplayed = fragmentAction.replayed;
    }

    const document = await options.executeInTransaction(tx, {
      ...common,
      actionType: 'add_controlled_document',
      idempotencyKey: `${sourceFacts.idempotencyKey}-document`,
      payload: {
        title: sourceFacts.title,
        document_number: sourceFacts.documentNumber,
        revision: sourceFacts.revision,
        document_class: sourceFacts.documentClass,
        owning_role: sourceFacts.owningRole,
        content_version: version.id,
      },
    });
    const documentId = document.objectIds[0];
    if (documentId === undefined) throw new Error('add_controlled_document returned no id');
    const recordedDocument = await importedControlledDocument(
      tx,
      identity.organizationId,
      documentId,
    );
    if (
      recordedDocument === undefined ||
      recordedDocument.title !== sourceFacts.title ||
      recordedDocument.document_number !== sourceFacts.documentNumber ||
      recordedDocument.revision !== sourceFacts.revision ||
      recordedDocument.document_class !== sourceFacts.documentClass ||
      recordedDocument.owning_role !== sourceFacts.owningRole ||
      recordedDocument.content_version_id !== version.id
    ) {
      throw document.replayed
        ? new ImportIdempotencyConflict()
        : new Error('controlled document action did not record exact import facts');
    }
    return {
      statusCode: document.replayed ? 200 : 201,
      body: {
        id: documentId,
        artifactId,
        fragmentId: importedSource.fragment_id,
        fragmentRevisionId: importedSource.fragment_revision_id,
        sha256: sourceFacts.sha256,
        replayed: artifact.replayed && sourceReplayed && document.replayed,
      },
    };
  });
}
