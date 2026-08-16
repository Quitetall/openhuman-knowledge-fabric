import type { Tx } from '@kf/database';
import { requireInteger, requireString } from '@kf/record-atoms';
import type { CompositionInput } from '../compiler.js';
import { refuseDocument, requireArray, requireDigest } from './action-payload.js';
import { documentClassification } from './target-classification.js';

export type DeclaredCompositionInput =
  | Extract<CompositionInput, { readonly role: 'fragment' | 'composition' | 'binding' }>
  | Omit<Extract<CompositionInput, { readonly role: 'resource' }>, 'classification'>
  | Omit<Extract<CompositionInput, { readonly role: 'generated_view' }>, 'classification'>;

export function declaredCompositionInputs(
  payload: Readonly<Record<string, unknown>> | undefined,
): DeclaredCompositionInput[] {
  return requireArray(payload, 'inputs').map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`inputs[${index}] must be an object`);
    }
    const input = raw as Readonly<Record<string, unknown>>;
    const ordinal = requireInteger(input, 'ordinal', 1);
    const role = requireString(input, 'role');
    if (role === 'fragment') {
      return {
        ordinal,
        role,
        fragmentRevisionId: requireString(input, 'fragment_revision_id'),
      };
    }
    if (role === 'composition') {
      return {
        ordinal,
        role,
        compositionRevisionId: requireString(input, 'composition_revision_id'),
      };
    }
    if (role === 'resource') {
      return {
        ordinal,
        role,
        resourceVersionId: requireString(input, 'resource_version_id'),
        contentDigest: requireDigest(input, 'content_digest'),
      };
    }
    if (role === 'binding') {
      return { ordinal, role, bindingId: requireString(input, 'binding_id') };
    }
    if (role === 'generated_view') {
      return {
        ordinal,
        role,
        compiledViewId: requireString(input, 'compiled_view_id'),
        contentDigest: requireDigest(input, 'content_digest'),
      };
    }
    throw new Error(`inputs[${index}].role is not supported`);
  });
}

export async function compositionInputs(
  tx: Tx,
  payload: Readonly<Record<string, unknown>> | undefined,
): Promise<CompositionInput[]> {
  const declared = declaredCompositionInputs(payload);
  const hydrated: CompositionInput[] = [];
  for (const input of declared) {
    if (input.role === 'resource') {
      const row = await tx.maybeOne<{ classification: string }>(
        `select o.classification
           from content.artifact_version v
           join core.object o on o.id = v.artifact_id
          where v.id = $1 and v.sha256 = $2`,
        [input.resourceVersionId, input.contentDigest],
      );
      if (row === undefined) {
        refuseDocument('KF-DOC-COMP-002', 'resource input is missing, mismatched, or not visible', {
          ordinal: input.ordinal,
        });
      }
      hydrated.push({
        ...input,
        classification: documentClassification(row.classification, 'resource classification'),
      });
    } else if (input.role === 'generated_view') {
      const row = await tx.maybeOne<{ classification: string }>(
        `select effective_classification as classification
           from content.compiled_view
          where id = $1 and content_digest = $2`,
        [input.compiledViewId, input.contentDigest],
      );
      if (row === undefined) {
        refuseDocument(
          'KF-DOC-COMP-002',
          'generated-view input is missing, mismatched, or not visible',
          { ordinal: input.ordinal },
        );
      }
      hydrated.push({
        ...input,
        classification: documentClassification(row.classification, 'generated-view classification'),
      });
    } else {
      hydrated.push(input);
    }
  }
  return hydrated;
}
