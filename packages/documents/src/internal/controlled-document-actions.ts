import type { ActionMaterializer } from '@kf/actions';
import { createControlledObject, requireString } from '@kf/record-atoms';

interface ControlledDocumentActions {
  readonly addControlledDocument: ActionMaterializer;
}

export function createControlledDocumentActions(): ControlledDocumentActions {
  const addControlledDocument: ActionMaterializer = async (tx, request) => {
    if (request.targetIds.length > 0) return [];
    const id = await createControlledObject(tx, {
      objectType: 'controlled_document',
      authorityDomain: 'qms',
      lifecycleState: 'draft',
      title: requireString(request.payload, 'title'),
      organizationId: request.organizationId,
      createdBy: request.actorId,
      retentionClass: 'quality_record',
    });
    await tx.query(
      `insert into quality.controlled_document
         (id, document_class, document_number, revision, owning_role, content_version)
       values ($1,$2,$3,$4,$5,$6)`,
      [
        id,
        requireString(request.payload, 'document_class'),
        requireString(request.payload, 'document_number'),
        requireString(request.payload, 'revision'),
        requireString(request.payload, 'owning_role'),
        requireString(request.payload, 'content_version'),
      ],
    );
    return [id];
  };

  return { addControlledDocument };
}
