import type { ActionEffect, PreconditionCheck } from '@kf/actions';
import { requireString } from '@kf/record-atoms';
import { refuseDocument } from './action-payload.js';
import { touchDocumentObject } from './composition-store.js';
import { assertTechnicalDocumentAuthority } from './document-authority.js';
import { currentHolder } from './holder-authority.js';
import { sourceHolderFromPayload } from './holder-contract.js';
import { insertSourceHolder } from './holder-store.js';
import { DOCUMENT_TARGET, requireDocumentTarget } from './target-classification.js';

interface HolderChangeActions {
  readonly assertChangeHolder: PreconditionCheck;
  readonly changeDocumentSourceHolder: ActionEffect;
}

export function createHolderChangeActions(): HolderChangeActions {
  const assertChangeHolder: PreconditionCheck = async (tx, request, objects) => {
    await assertTechnicalDocumentAuthority(tx, request, objects);
    const object = requireDocumentTarget(objects, DOCUMENT_TARGET, request.actionType);
    if (request.reason?.trim() === '') {
      refuseDocument('KF-DOC-001', 'Source Holder change requires a reason', {
        objectId: object.id,
      });
    }
    if (request.reason === undefined) {
      refuseDocument('KF-DOC-001', 'Source Holder change requires a reason', {
        objectId: object.id,
      });
    }
    requireString(request.payload, 'reversible_migration_plan');
    const current = await currentHolder(tx, object.id);
    if (current.holder_id !== requireString(request.payload, 'previous_holder_id')) {
      refuseDocument('KF-DOC-001', 'Source Holder change must name the current Holder', {
        objectId: object.id,
        currentHolderId: current.holder_id,
      });
    }
    sourceHolderFromPayload(request.payload, current.subject_id);
  };

  const changeDocumentSourceHolder: ActionEffect = async (tx, request, objects, ctx) => {
    const object = requireDocumentTarget(objects, DOCUMENT_TARGET, request.actionType);
    const current = await currentHolder(tx, object.id);
    const holderId = requireString(request.payload, 'holder_id');
    await insertSourceHolder(tx, {
      id: holderId,
      subjectId: current.subject_id,
      previousHolderId: current.holder_id,
      holder: sourceHolderFromPayload(request.payload, current.subject_id),
      conversionLoss: Array.isArray(request.payload?.['conversion_loss'])
        ? request.payload['conversion_loss']
        : [],
      migrationReason: request.reason ?? null,
      reversibleMigrationPlan: requireString(request.payload, 'reversible_migration_plan'),
      actorId: request.actorId,
      actionId: ctx.actionId,
    });
    await tx.query(
      'update content.document_subject set current_holder_id = $2 where object_id = $1',
      [object.id, holderId],
    );
    await touchDocumentObject(tx, request, object.id);
  };

  return { assertChangeHolder, changeDocumentSourceHolder };
}
