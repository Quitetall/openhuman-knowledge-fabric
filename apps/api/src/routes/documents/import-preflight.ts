import { randomUUID } from 'node:crypto';
import { setAccessContext, withTransaction } from '@kf/database';
import type { Caller } from '../actions.js';
import {
  SourceHolderConflict,
  type DocumentActionContext,
  type DocumentRoutesOptions,
  type ParsedDocumentImport,
} from './contracts.js';
import { currentImportSource } from './repository.js';

export async function preflightDocumentImport(
  options: DocumentRoutesOptions,
  identity: Caller,
  source: ParsedDocumentImport,
  common: DocumentActionContext,
): Promise<void> {
  // Object storage is immutable and external to database transaction. Refuse callers that
  // cannot pass existing authority/precondition contract before writing bytes. This remains
  // only a TOCTOU-prone early gate: authoritative action repeats every check after storage.
  await withTransaction(options.pool, async (tx) => {
    await setAccessContext(tx, {
      organizationId: identity.organizationId,
      maxClassification: identity.maxClassification,
    });
    const currentSource = await currentImportSource(tx, identity.organizationId, source.stableKey);
    if (currentSource !== undefined && currentSource.holder_kind !== 'fabric_native') {
      throw new SourceHolderConflict();
    }
    if (currentSource === undefined) {
      await options.preflightInTransaction(
        tx,
        {
          ...common,
          actionType: 'add_authored_fragment',
          idempotencyKey: `${source.idempotencyKey}-fragment`,
          payload: { document_policy: 'ordinary' },
        },
        [
          {
            id: randomUUID(),
            object_type: 'authored_fragment',
            lifecycle_state: 'active',
            row_version: '0',
            organization_id: identity.organizationId,
            created_by: identity.actorId,
          },
        ],
      );
      return;
    }
    if (
      currentSource.revision_holder_id === currentSource.holder_id &&
      currentSource.artifact_version_id !== null &&
      currentSource.content_digest === source.sha256 &&
      currentSource.media_type === source.mediaType
    ) {
      // Exact bytes use same immutable storage key. Same artifact action will replay and final
      // transaction will reuse this revision; different artifact identity still faces final
      // revise authority. Never demand revise authority for an exact no-op replay.
      return;
    }
    if (currentSource.artifact_version_id === null) {
      throw new Error('fabric-native current Holder has no artifact version');
    }
    await options.preflightInTransaction(tx, {
      ...common,
      actionType: 'revise_authored_fragment',
      targetIds: [currentSource.fragment_id],
      idempotencyKey: `${source.idempotencyKey}-fragment`,
      payload: {
        previous_revision_id: currentSource.fragment_revision_id,
        previous_holder_id: currentSource.holder_id,
        holder_id: randomUUID(),
        holder: {
          kind: 'fabric_native',
          artifact_version_id: currentSource.artifact_version_id,
          content_digest: currentSource.content_digest,
        },
        media_type: currentSource.media_type,
        classification: currentSource.classification,
      },
    });
  });
}
