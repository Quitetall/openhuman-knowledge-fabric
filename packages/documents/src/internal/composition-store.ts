import type { ActionRequest } from '@kf/actions';
import type { Tx } from '@kf/database';
import {
  createCompositionRevision,
  type CompositionInput,
  type DocumentClassification,
} from '../compiler.js';
import { documentClassification } from './target-classification.js';

export async function insertCompositionRevision(
  tx: Tx,
  input: {
    readonly id: string;
    readonly compositionId: string;
    readonly previousRevisionId: string | null;
    readonly classification: DocumentClassification;
    readonly inputs: readonly CompositionInput[];
    readonly actorId: string;
    readonly actionId: string;
  },
): Promise<void> {
  const revision = createCompositionRevision({
    id: input.id,
    compositionId: input.compositionId,
    previousRevisionId: input.previousRevisionId,
    classification: input.classification,
    inputs: input.inputs,
  });
  await tx.query(
    `insert into content.composition_revision
       (id, composition_id, previous_revision_id, revision_digest, created_by, created_by_action)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      revision.id,
      revision.compositionId,
      revision.previousRevisionId,
      revision.revisionDigest,
      input.actorId,
      input.actionId,
    ],
  );
  for (const item of revision.inputs) {
    await tx.query(
      `insert into content.composition_input
         (composition_revision_id, ordinal, input_role, fragment_revision_id,
          child_composition_revision_id, resource_version_id, binding_id,
          compiled_view_id, content_digest)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        revision.id,
        item.ordinal,
        item.role,
        item.role === 'fragment' ? item.fragmentRevisionId : null,
        item.role === 'composition' ? item.compositionRevisionId : null,
        item.role === 'resource' ? item.resourceVersionId : null,
        item.role === 'binding' ? item.bindingId : null,
        item.role === 'generated_view' ? item.compiledViewId : null,
        item.role === 'resource' || item.role === 'generated_view' ? item.contentDigest : null,
      ],
    );
  }
}

export async function touchDocumentObject(
  tx: Tx,
  request: ActionRequest,
  objectId: string,
  classification?: string,
): Promise<void> {
  await tx.query(
    `update core.object
        set classification = coalesce($2, classification),
            row_version = row_version + 1,
            updated_at = now(),
            updated_by = $3
      where id = $1`,
    [objectId, classification ?? null, request.actorId],
  );
}

export async function objectClassification(
  tx: Tx,
  objectId: string,
): Promise<DocumentClassification> {
  const row = await tx.one<{ classification: string }>(
    'select classification from core.object where id = $1',
    [objectId],
  );
  return documentClassification(row.classification, 'object classification');
}
