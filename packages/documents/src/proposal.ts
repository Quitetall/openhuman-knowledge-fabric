/**
 * Exact operations that a recorded document proposal may later apply.
 *
 * These are data-only contracts. Validation is pure and grants no action or write authority.
 */

export * from './proposal/contracts.js';
export { validateDocumentProposalModelProvenance } from './proposal/model-provenance.js';
export { validateDocumentProposalOperation } from './proposal/operation.js';
