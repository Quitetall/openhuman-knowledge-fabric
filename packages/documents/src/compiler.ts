export { DocumentCompilerError } from './compiler/errors.js';
export * from './compiler/types.js';
export { createAuthoredFragmentRevision } from './compiler/source-holder.js';
export { createCompositionRevision } from './compiler/composition.js';
export { createTypedBinding } from './compiler/bindings.js';
export { createCompilationBasis } from './compiler/basis.js';
export {
  canonicalCompilationRunPreimage,
  canonicalCompilationSemanticPreimage,
  verifyCompilationRunPreimage,
} from './compiler/receipts.js';
export { createFailedCompilationRun, runCompilation } from './compiler/run.js';
export { assertCompilationMayBeAccepted } from './compiler/acceptance.js';
export { createProposalOverlay } from './compiler/proposal-overlay.js';
export type { JsonValue as DocumentJsonValue } from '@kf/canonicalization';
