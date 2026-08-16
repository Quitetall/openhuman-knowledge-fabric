import { digest } from '@kf/canonicalization';
import type {
  CompositionInput,
  CompositionRevision,
  CompositionRevisionInput,
} from './core-types.js';
import { classification, exactKeys, fail, nonEmpty, sha256 } from './primitives.js';

function compositionInput(input: CompositionInput): CompositionInput {
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 1) {
    fail('invalid_ordinal', 'composition input ordinal must be a positive safe integer');
  }
  if (input.role === 'fragment') {
    exactKeys(input, ['ordinal', 'role', 'fragmentRevisionId'], 'fragment input');
    return Object.freeze({
      ordinal: input.ordinal,
      role: input.role,
      fragmentRevisionId: nonEmpty(input.fragmentRevisionId, 'fragmentRevisionId'),
    });
  }
  if (input.role === 'composition') {
    exactKeys(input, ['ordinal', 'role', 'compositionRevisionId'], 'composition input');
    return Object.freeze({
      ordinal: input.ordinal,
      role: input.role,
      compositionRevisionId: nonEmpty(input.compositionRevisionId, 'compositionRevisionId'),
    });
  }
  if (input.role === 'resource') {
    exactKeys(
      input,
      ['ordinal', 'role', 'resourceVersionId', 'contentDigest', 'classification'],
      'resource input',
    );
    return Object.freeze({
      ordinal: input.ordinal,
      role: input.role,
      resourceVersionId: nonEmpty(input.resourceVersionId, 'resourceVersionId'),
      contentDigest: sha256(input.contentDigest, 'resource.contentDigest'),
      classification: classification(input.classification, 'resource.classification'),
    });
  }
  if (input.role === 'binding') {
    exactKeys(input, ['ordinal', 'role', 'bindingId'], 'binding input');
    return Object.freeze({
      ordinal: input.ordinal,
      role: input.role,
      bindingId: nonEmpty(input.bindingId, 'bindingId'),
    });
  }
  if (input.role === 'generated_view') {
    exactKeys(
      input,
      ['ordinal', 'role', 'compiledViewId', 'contentDigest', 'classification'],
      'generated-view input',
    );
    return Object.freeze({
      ordinal: input.ordinal,
      role: input.role,
      compiledViewId: nonEmpty(input.compiledViewId, 'compiledViewId'),
      contentDigest: sha256(input.contentDigest, 'generatedView.contentDigest'),
      classification: classification(input.classification, 'generatedView.classification'),
    });
  }
  return fail('unknown_composition_role', 'composition input role is not supported');
}

/** Construct one immutable ordered composition revision. */
export function createCompositionRevision(input: CompositionRevisionInput): CompositionRevision {
  const inputs = input.inputs
    .map(compositionInput)
    .sort((left, right) => left.ordinal - right.ordinal);
  for (const [index, item] of inputs.entries()) {
    if (item.ordinal !== index + 1) {
      fail(
        'invalid_composition_order',
        'composition input ordinals must be unique and contiguous starting at 1',
      );
    }
  }
  const claim: CompositionRevisionInput = {
    id: nonEmpty(input.id, 'id'),
    compositionId: nonEmpty(input.compositionId, 'compositionId'),
    previousRevisionId:
      input.previousRevisionId === null
        ? null
        : nonEmpty(input.previousRevisionId, 'previousRevisionId'),
    classification: classification(input.classification, 'composition.classification'),
    inputs: Object.freeze(inputs),
  };
  return Object.freeze({ ...claim, revisionDigest: digest(claim) });
}
