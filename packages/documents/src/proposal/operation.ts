import type { DocumentProposalOperation } from './contracts.js';
import { compositionInput } from './composition-input.js';
import { sourceHolder } from './source-holder.js';
import { classification, exactKeys, nonEmpty, record } from './validation.js';

/** Validate and copy an untrusted proposal operation, refusing all unknown shapes and fields. */
export function validateDocumentProposalOperation(value: unknown): DocumentProposalOperation {
  const operation = record(value, 'proposal operation');
  if (operation['operation'] === 'replace_composition_inputs') {
    exactKeys(
      operation,
      ['operation', 'classification', 'holder_id', 'previous_holder_id', 'holder', 'inputs'],
      'replace_composition_inputs operation',
    );
    if (!Array.isArray(operation['inputs']) || operation['inputs'].length === 0) {
      throw new Error('inputs must be a non-empty array');
    }
    return Object.freeze({
      operation: operation['operation'],
      classification: classification(operation['classification']),
      holder_id: nonEmpty(operation['holder_id'], 'holder_id'),
      previous_holder_id: nonEmpty(operation['previous_holder_id'], 'previous_holder_id'),
      holder: sourceHolder(operation['holder']),
      inputs: Object.freeze(operation['inputs'].map(compositionInput)),
    });
  }
  if (operation['operation'] !== 'replace_fragment_source') {
    throw new Error('proposal operation is not supported');
  }
  exactKeys(
    operation,
    ['operation', 'media_type', 'classification', 'holder_id', 'previous_holder_id', 'holder'],
    'replace_fragment_source operation',
  );
  return Object.freeze({
    operation: operation['operation'],
    media_type: nonEmpty(operation['media_type'], 'media_type'),
    classification: classification(operation['classification']),
    holder_id: nonEmpty(operation['holder_id'], 'holder_id'),
    previous_holder_id: nonEmpty(operation['previous_holder_id'], 'previous_holder_id'),
    holder: sourceHolder(operation['holder']),
  });
}
