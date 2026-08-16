import { digest } from '@kf/canonicalization';
import type { CompilationRun } from './types.js';
import { compilationRunPreimage } from './receipts.js';
import { fail, VERIFIED_COMPILATION_RUN } from './primitives.js';

/** Fail closed before an approval action can freeze a compiler receipt. */
export function assertCompilationMayBeAccepted(run: CompilationRun): void {
  if ((run as unknown as Record<PropertyKey, unknown>)[VERIFIED_COMPILATION_RUN] !== true) {
    fail('unverified_compilation_run', 'acceptance requires a verified compiler run');
  }
  if (digest(compilationRunPreimage(run)) !== run.runDigest) {
    fail('run_digest_mismatch', 'compilation run digest does not match its canonical contents');
  }
  if (run.status !== 'succeeded') {
    fail('failed_compilation', 'a failed compilation run cannot be accepted');
  }
  if (run.draftOnly) {
    fail('draft_only_compiler', 'this compiler run is draft-only until qualification is ratified');
  }
  if (run.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    fail('compiler_diagnostic_error', 'a run with error diagnostics cannot be accepted');
  }
  if (run.hirProvenance.length === 0 || run.cirProvenance.length === 0) {
    fail(
      'missing_provenance_coverage',
      'acceptance requires non-empty Basis-bound HIR and CIR provenance',
    );
  }
  if (run.unresolvedReferences.length > 0) {
    fail('unresolved_references', 'a run with unresolved references cannot be accepted');
  }
  if (run.omittedSubgraphs.length > 0) {
    fail('omitted_subgraphs', 'a run with omitted subgraphs cannot be accepted');
  }
  if (run.conversionLoss.length > 0) {
    fail('conversion_loss', 'a lossy compiler run cannot be accepted without a later policy seam');
  }
}
