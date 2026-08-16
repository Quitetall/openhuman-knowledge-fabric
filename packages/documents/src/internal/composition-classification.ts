import type { Tx } from '@kf/database';
import type { CompositionInput, DocumentClassification } from '../compiler.js';
import { refuseDocument } from './action-payload.js';
import { classificationRank } from './target-classification.js';

export async function classificationForCompositionInputs(
  tx: Tx,
  inputs: readonly CompositionInput[],
): Promise<string> {
  if (inputs.length === 0) {
    refuseDocument('KF-DOC-COMP-001', 'a document composition must contain at least one input');
  }
  let highest = 'public';
  for (const input of inputs) {
    let row: { classification: string } | undefined;
    if (input.role === 'fragment') {
      const fragment = await tx.maybeOne<{
        classification: string;
        holder_kind: string;
        holder_classification: string | null;
      }>(
        `select r.classification, h.holder_kind,
                artifact_object.classification as holder_classification
           from content.authored_fragment_revision r
           join content.document_subject s on s.id = r.fragment_id
           join content.document_source_holder h on h.id = r.holder_id
           left join content.artifact_version av on av.id = h.fabric_artifact_version_id
           left join core.object artifact_object on artifact_object.id = av.artifact_id
          where r.id = $1`,
        [input.fragmentRevisionId],
      );
      if (
        fragment !== undefined &&
        (fragment.holder_kind !== 'fabric_native' || fragment.holder_classification !== null)
      ) {
        row = {
          classification:
            fragment.holder_classification !== null &&
            classificationRank(fragment.holder_classification) >
              classificationRank(fragment.classification)
              ? fragment.holder_classification
              : fragment.classification,
        };
      }
    } else if (input.role === 'composition') {
      row = await tx.maybeOne<{ classification: string }>(
        `select o.classification
           from content.composition_revision r
           join content.document_subject s on s.id = r.composition_id
           join core.object o on o.id = s.object_id
          where r.id = $1`,
        [input.compositionRevisionId],
      );
    } else if (input.role === 'resource') {
      row = await tx.maybeOne<{ classification: string }>(
        `select o.classification
           from content.artifact_version v
           join core.object o on o.id = v.artifact_id
          where v.id = $1 and v.sha256 = $2`,
        [input.resourceVersionId, input.contentDigest],
      );
    } else if (input.role === 'binding') {
      row = await tx.maybeOne<{ classification: string }>(
        `select o.classification
           from content.typed_binding b
           join core.object o on o.id = b.object_id
          where b.id = $1`,
        [input.bindingId],
      );
    } else {
      row = await tx.maybeOne<{ classification: string }>(
        `select effective_classification as classification
           from content.compiled_view
          where id = $1 and content_digest = $2`,
        [input.compiledViewId, input.contentDigest],
      );
    }
    if (row === undefined) {
      refuseDocument(
        'KF-DOC-COMP-002',
        'composition input is missing, mismatched, or not visible',
        {
          role: input.role,
          ordinal: input.ordinal,
        },
      );
    }
    if (classificationRank(row.classification) > classificationRank(highest)) {
      highest = row.classification;
    }
  }
  return highest;
}

export async function assertCompositionClassification(
  tx: Tx,
  classification: DocumentClassification,
  inputs: readonly CompositionInput[],
): Promise<void> {
  const highest = await classificationForCompositionInputs(tx, inputs);
  if (classificationRank(classification) < classificationRank(highest)) {
    refuseDocument(
      'KF-DOC-CLASS-002',
      'composition classification must be at least its highest visible input',
      { requested: classification, required: highest },
    );
  }
}
