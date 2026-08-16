import type { DocumentProposalCompositionInput } from './contracts.js';
import { exactKeys, nonEmpty, positiveOrdinal, record, sha256 } from './validation.js';

export function compositionInput(value: unknown, index: number): DocumentProposalCompositionInput {
  const input = record(value, `inputs[${String(index)}]`);
  const ordinal = positiveOrdinal(input['ordinal'], `inputs[${String(index)}].ordinal`);
  if (ordinal !== index + 1) {
    throw new Error('composition input ordinals must be contiguous and match array order');
  }
  if (input['role'] === 'fragment') {
    exactKeys(input, ['ordinal', 'role', 'fragment_revision_id'], 'fragment input');
    return Object.freeze({
      ordinal,
      role: input['role'],
      fragment_revision_id: nonEmpty(
        input['fragment_revision_id'],
        `inputs[${String(index)}].fragment_revision_id`,
      ),
    });
  }
  if (input['role'] === 'composition') {
    exactKeys(input, ['ordinal', 'role', 'composition_revision_id'], 'composition input');
    return Object.freeze({
      ordinal,
      role: input['role'],
      composition_revision_id: nonEmpty(
        input['composition_revision_id'],
        `inputs[${String(index)}].composition_revision_id`,
      ),
    });
  }
  if (input['role'] === 'resource') {
    exactKeys(
      input,
      ['ordinal', 'role', 'resource_version_id', 'content_digest'],
      'resource input',
    );
    return Object.freeze({
      ordinal,
      role: input['role'],
      resource_version_id: nonEmpty(
        input['resource_version_id'],
        `inputs[${String(index)}].resource_version_id`,
      ),
      content_digest: sha256(input['content_digest'], `inputs[${String(index)}].content_digest`),
    });
  }
  if (input['role'] === 'binding') {
    exactKeys(input, ['ordinal', 'role', 'binding_id'], 'binding input');
    return Object.freeze({
      ordinal,
      role: input['role'],
      binding_id: nonEmpty(input['binding_id'], `inputs[${String(index)}].binding_id`),
    });
  }
  if (input['role'] === 'generated_view') {
    exactKeys(
      input,
      ['ordinal', 'role', 'compiled_view_id', 'content_digest'],
      'generated-view input',
    );
    return Object.freeze({
      ordinal,
      role: input['role'],
      compiled_view_id: nonEmpty(
        input['compiled_view_id'],
        `inputs[${String(index)}].compiled_view_id`,
      ),
      content_digest: sha256(input['content_digest'], `inputs[${String(index)}].content_digest`),
    });
  }
  throw new Error(`inputs[${String(index)}].role is not supported`);
}
