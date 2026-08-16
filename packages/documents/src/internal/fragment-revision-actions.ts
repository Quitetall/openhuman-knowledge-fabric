import type { ActionEffect, ActionRequest, ObjectRow, PreconditionCheck } from '@kf/actions';
import type { Tx } from '@kf/database';
import { requireString } from '@kf/record-atoms';
import { createAuthoredFragmentRevision } from '../compiler.js';
import { TECHNICAL_AUTHORITY_ROLE } from './action-types.js';
import {
  authoritativeDocumentPolicy,
  assertDocumentAuthor,
  assertDocumentRole,
  assertQualityAuthorityWhenRequired,
} from './document-authority.js';
import { appendRevisionHolder, assertRevisionHolder, currentHolder } from './holder-authority.js';
import { sourceHolderFromRow, type HolderRow } from './holder-store.js';
import { latestFragmentRevision } from './revision-readers.js';
import {
  FRAGMENT_TARGET,
  assertClassificationMayAdvance,
  requireDocumentClassification,
  requireDocumentTarget,
} from './target-classification.js';
import { touchDocumentObject } from './composition-store.js';
import { refuseDocument } from './action-payload.js';

interface FragmentRevisionActions {
  readonly assertReviseFragment: PreconditionCheck;
  readonly reviseAuthoredFragment: ActionEffect;
  readonly assertRetireFragment: PreconditionCheck;
  readonly retireAuthoredFragment: ActionEffect;
}

export function createFragmentRevisionActions(): FragmentRevisionActions {
  const assertFragmentRevisionBase = async (
    tx: Tx,
    request: ActionRequest,
    object: ObjectRow,
  ): Promise<void> => {
    if (object.lifecycle_state !== 'active') {
      refuseDocument('KF-DOC-FRAG-001', 'only an active Authored Fragment may be revised', {
        objectId: object.id,
      });
    }
    const latest = await latestFragmentRevision(tx, object.id);
    if (
      latest === undefined ||
      latest.revision_state === 'retired' ||
      latest.revision_id !== requireString(request.payload, 'previous_revision_id')
    ) {
      refuseDocument('KF-DOC-FRAG-002', 'revision must name the latest fragment revision', {
        objectId: object.id,
      });
    }
  };

  const assertReviseFragment: PreconditionCheck = async (tx, request, objects) => {
    await assertDocumentAuthor(tx, request, objects);
    const object = requireDocumentTarget(objects, FRAGMENT_TARGET, request.actionType);
    await assertFragmentRevisionBase(tx, request, object);
    await assertQualityAuthorityWhenRequired(
      tx,
      request,
      objects,
      await authoritativeDocumentPolicy(tx, request, object.id),
    );
    await assertClassificationMayAdvance(
      tx,
      object.id,
      requireDocumentClassification(request.payload),
    );
    await assertRevisionHolder(tx, request.payload, object.id);
  };

  const appendFragmentRevision = async (
    tx: Tx,
    request: ActionRequest,
    object: ObjectRow,
    actionId: string,
    state: 'active' | 'retired',
    holderRow?: HolderRow,
  ): Promise<void> => {
    const exactHolder = holderRow ?? (await currentHolder(tx, object.id));
    const holder = sourceHolderFromRow(exactHolder);
    const revision = createAuthoredFragmentRevision({
      id: requireString(request.payload, 'revision_id'),
      fragmentId: exactHolder.subject_id,
      previousRevisionId: requireString(request.payload, 'previous_revision_id'),
      mediaType: requireString(request.payload, 'media_type'),
      classification: requireDocumentClassification(request.payload),
      state,
      holder,
    });
    await tx.query(
      `insert into content.authored_fragment_revision
         (id, fragment_id, previous_revision_id, holder_id, media_type, classification,
          revision_state, content_digest, revision_digest, created_by, created_by_action)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        revision.id,
        revision.fragmentId,
        revision.previousRevisionId,
        exactHolder.holder_id,
        revision.mediaType,
        revision.classification,
        revision.state,
        revision.holder.contentDigest,
        revision.revisionDigest,
        request.actorId,
        actionId,
      ],
    );
  };

  const reviseAuthoredFragment: ActionEffect = async (tx, request, objects, ctx) => {
    const object = requireDocumentTarget(objects, FRAGMENT_TARGET, request.actionType);
    const holder = await appendRevisionHolder(tx, request, object.id, ctx.actionId);
    await appendFragmentRevision(tx, request, object, ctx.actionId, 'active', holder);
    await touchDocumentObject(
      tx,
      request,
      object.id,
      requireDocumentClassification(request.payload),
    );
  };

  const assertRetireFragment: PreconditionCheck = async (tx, request, objects) => {
    await assertDocumentRole(tx, request, objects, TECHNICAL_AUTHORITY_ROLE);
    const object = requireDocumentTarget(objects, FRAGMENT_TARGET, request.actionType);
    await assertFragmentRevisionBase(tx, request, object);
    await assertQualityAuthorityWhenRequired(
      tx,
      request,
      objects,
      await authoritativeDocumentPolicy(tx, request, object.id),
    );
    await assertClassificationMayAdvance(
      tx,
      object.id,
      requireDocumentClassification(request.payload),
    );
  };

  const retireAuthoredFragment: ActionEffect = async (tx, request, objects, ctx) => {
    const object = requireDocumentTarget(objects, FRAGMENT_TARGET, request.actionType);
    await appendFragmentRevision(tx, request, object, ctx.actionId, 'retired');
  };

  return {
    assertReviseFragment,
    reviseAuthoredFragment,
    assertRetireFragment,
    retireAuthoredFragment,
  };
}
