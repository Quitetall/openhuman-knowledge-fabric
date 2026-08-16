import type { ActionEffect, PreconditionCheck } from '@kf/actions';
import { requireString } from '@kf/record-atoms';
import { refuseDocument } from './action-payload.js';
import { assertCompositionClassification } from './composition-classification.js';
import { compositionInputs } from './composition-inputs.js';
import { assertActiveCompositionInputs } from './composition-retirement.js';
import {
  insertCompositionRevision,
  objectClassification,
  touchDocumentObject,
} from './composition-store.js';
import {
  authoritativeDocumentPolicy,
  assertDocumentAuthor,
  assertQualityAuthorityWhenRequired,
} from './document-authority.js';
import { appendRevisionHolder, assertRevisionHolder } from './holder-authority.js';
import { latestCompositionRevision } from './revision-readers.js';
import {
  COMPOSITION_TARGET,
  assertClassificationMayAdvance,
  requireDocumentClassification,
  requireDocumentTarget,
} from './target-classification.js';

interface CompositionRevisionActions {
  readonly assertReviseComposition: PreconditionCheck;
  readonly reviseDocumentComposition: ActionEffect;
}

export function createCompositionRevisionActions(): CompositionRevisionActions {
  const assertReviseComposition: PreconditionCheck = async (tx, request, objects) => {
    await assertDocumentAuthor(tx, request, objects);
    const object = requireDocumentTarget(objects, COMPOSITION_TARGET, request.actionType);
    const latest = await latestCompositionRevision(tx, object.id);
    if (latest?.revision_id !== requireString(request.payload, 'previous_revision_id')) {
      refuseDocument('KF-DOC-COMP-003', 'revision must name the latest composition revision', {
        objectId: object.id,
      });
    }
    const classification = requireDocumentClassification(request.payload);
    const inputs = await compositionInputs(tx, request.payload);
    await assertActiveCompositionInputs(tx, inputs);
    await assertQualityAuthorityWhenRequired(
      tx,
      request,
      objects,
      await authoritativeDocumentPolicy(tx, request, object.id),
    );
    await assertClassificationMayAdvance(tx, object.id, classification);
    await assertCompositionClassification(tx, classification, inputs);
    await assertRevisionHolder(tx, request.payload, object.id);
  };

  const reviseDocumentComposition: ActionEffect = async (tx, request, objects, ctx) => {
    const object = requireDocumentTarget(objects, COMPOSITION_TARGET, request.actionType);
    const subject = await tx.one<{ id: string }>(
      'select id from content.document_subject where object_id = $1',
      [object.id],
    );
    await appendRevisionHolder(tx, request, object.id, ctx.actionId);
    await touchDocumentObject(
      tx,
      request,
      object.id,
      requireDocumentClassification(request.payload),
    );
    await insertCompositionRevision(tx, {
      id: requireString(request.payload, 'revision_id'),
      compositionId: subject.id,
      previousRevisionId: requireString(request.payload, 'previous_revision_id'),
      classification: await objectClassification(tx, object.id),
      inputs: await compositionInputs(tx, request.payload),
      actorId: request.actorId,
      actionId: ctx.actionId,
    });
  };

  return { assertReviseComposition, reviseDocumentComposition };
}
