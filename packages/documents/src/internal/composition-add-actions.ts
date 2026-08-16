import type { ActionEffect, ActionMaterializer, PreconditionCheck } from '@kf/actions';
import { createControlledObject, requireString } from '@kf/record-atoms';
import { refuseDocument } from './action-payload.js';
import { assertCompositionClassification } from './composition-classification.js';
import { compositionInputs } from './composition-inputs.js';
import { assertActiveCompositionInputs } from './composition-retirement.js';
import { insertCompositionRevision, objectClassification } from './composition-store.js';
import {
  assertDocumentAuthor,
  assertQualityAuthorityWhenRequired,
  requireDocumentPolicy,
} from './document-authority.js';
import { sourceHolderFromPayload } from './holder-contract.js';
import { insertSourceHolder } from './holder-store.js';
import {
  COMPOSITION_TARGET,
  requireDocumentClassification,
  requireDocumentTarget,
} from './target-classification.js';

interface CompositionAddActions {
  readonly addDocumentComposition: ActionMaterializer;
  readonly materializeDocumentComposition: ActionEffect;
  readonly assertAddComposition: PreconditionCheck;
}

export function createCompositionAddActions(): CompositionAddActions {
  const addDocumentComposition: ActionMaterializer = async (tx, request) => {
    if (request.targetIds.length !== 0) {
      refuseDocument(
        'KF-DOC-TARGET-002',
        'add_document_composition does not accept an existing target',
      );
    }
    const id = await createControlledObject(tx, {
      objectType: 'document_composition',
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

  const materializeDocumentComposition: ActionEffect = async (tx, request, objects, ctx) => {
    const object = requireDocumentTarget(objects, COMPOSITION_TARGET, request.actionType);
    const holderId = requireString(request.payload, 'holder_id');
    const holder = sourceHolderFromPayload(request.payload, object.id);
    await tx.query(
      `insert into content.document_subject
         (id, object_id, subject_kind, stable_key, document_policy, current_holder_id,
          created_by, created_by_action)
       values ($1,$1,'composition',$2,$3,$4,$5,$6)`,
      [
        object.id,
        requireString(request.payload, 'stable_key'),
        requireDocumentPolicy(request),
        holderId,
        request.actorId,
        ctx.actionId,
      ],
    );
    await tx.query('insert into content.document_composition (id) values ($1)', [object.id]);
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
    await insertCompositionRevision(tx, {
      id: requireString(request.payload, 'revision_id'),
      compositionId: object.id,
      previousRevisionId: null,
      classification: await objectClassification(tx, object.id),
      inputs: await compositionInputs(tx, request.payload),
      actorId: request.actorId,
      actionId: ctx.actionId,
    });
  };

  const assertAddComposition: PreconditionCheck = async (tx, request, objects) => {
    await assertDocumentAuthor(tx, request, objects);
    requireDocumentTarget(objects, COMPOSITION_TARGET, request.actionType);
    const inputs = await compositionInputs(tx, request.payload);
    await assertActiveCompositionInputs(tx, inputs);
    await assertCompositionClassification(
      tx,
      requireDocumentClassification(request.payload),
      inputs,
    );
    await assertQualityAuthorityWhenRequired(tx, request, objects, requireDocumentPolicy(request));
  };

  return { addDocumentComposition, materializeDocumentComposition, assertAddComposition };
}
