import type { ActionEffect, ActionMaterializer, PreconditionCheck } from '@kf/actions';
import { createControlledObject, requireString } from '@kf/record-atoms';
import { createAuthoredFragmentRevision } from '../compiler.js';
import {
  assertDocumentAuthor,
  assertQualityAuthorityWhenRequired,
  requireDocumentPolicy,
} from './document-authority.js';
import { sourceHolderFromPayload } from './holder-contract.js';
import { insertSourceHolder } from './holder-store.js';
import {
  FRAGMENT_TARGET,
  requireDocumentClassification,
  requireDocumentTarget,
} from './target-classification.js';
import { refuseDocument } from './action-payload.js';

interface FragmentAddActions {
  readonly addAuthoredFragment: ActionMaterializer;
  readonly materializeAuthoredFragment: ActionEffect;
  readonly assertAddFragment: PreconditionCheck;
}

export function createFragmentAddActions(): FragmentAddActions {
  const addAuthoredFragment: ActionMaterializer = async (tx, request) => {
    if (request.targetIds.length !== 0) {
      refuseDocument(
        'KF-DOC-TARGET-002',
        'add_authored_fragment does not accept an existing target',
      );
    }
    const id = await createControlledObject(tx, {
      objectType: 'authored_fragment',
      authorityDomain: 'qms',
      lifecycleState: 'active',
      title: requireString(request.payload, 'title'),
      organizationId: request.organizationId,
      createdBy: request.actorId,
      classification: requireDocumentClassification(request.payload),
      retentionClass: 'quality_record',
    });
    return [id];
  };

  const materializeAuthoredFragment: ActionEffect = async (tx, request, objects, ctx) => {
    const object = requireDocumentTarget(objects, FRAGMENT_TARGET, request.actionType);
    const holderId = requireString(request.payload, 'holder_id');
    const revisionId = requireString(request.payload, 'revision_id');
    const holder = sourceHolderFromPayload(request.payload, object.id);
    const revision = createAuthoredFragmentRevision({
      id: revisionId,
      fragmentId: object.id,
      previousRevisionId: null,
      mediaType: requireString(request.payload, 'media_type'),
      classification: requireDocumentClassification(request.payload),
      state: 'active',
      holder,
    });
    await tx.query(
      `insert into content.document_subject
         (id, object_id, subject_kind, stable_key, document_policy, current_holder_id,
          created_by, created_by_action)
       values ($1,$1,'fragment',$2,$3,$4,$5,$6)`,
      [
        object.id,
        requireString(request.payload, 'stable_key'),
        requireDocumentPolicy(request),
        holderId,
        request.actorId,
        ctx.actionId,
      ],
    );
    await tx.query('insert into content.authored_fragment (id) values ($1)', [object.id]);
    await insertSourceHolder(tx, {
      id: holderId,
      subjectId: object.id,
      previousHolderId: null,
      holder,
      conversionLoss: [],
      migrationReason: null,
      reversibleMigrationPlan: null,
      actorId: request.actorId,
      actionId: ctx.actionId,
    });
    await tx.query(
      `insert into content.authored_fragment_revision
         (id, fragment_id, previous_revision_id, holder_id, media_type, classification,
          revision_state, content_digest, revision_digest, created_by, created_by_action)
       values ($1,$2,null,$3,$4,$5,'active',$6,$7,$8,$9)`,
      [
        revision.id,
        revision.fragmentId,
        holderId,
        revision.mediaType,
        revision.classification,
        revision.holder.contentDigest,
        revision.revisionDigest,
        request.actorId,
        ctx.actionId,
      ],
    );
  };

  const assertAddFragment: PreconditionCheck = async (tx, request, objects) => {
    await assertDocumentAuthor(tx, request, objects);
    requireDocumentTarget(objects, FRAGMENT_TARGET, request.actionType);
    await assertQualityAuthorityWhenRequired(tx, request, objects, requireDocumentPolicy(request));
  };

  return { addAuthoredFragment, materializeAuthoredFragment, assertAddFragment };
}
