/**
 * The scheduled determinism re-run (SAS §100.35, KF-SAS-RQ-102).
 *
 * A recorded success is compiled again — the same Basis, the same input bytes read back from the
 * store at their recorded versions, the same run identity — and the run digest the compiler gives
 * now is compared with the one recorded. The digest commits to the semantic output and to every
 * view's content digest, so equal digests mean the compiler reproduced the run. Nothing is
 * written: no run, no view, no act. A difference is a finding for a person, raised by the unit
 * failing (`kf-compiler-determinism.service`, OnFailure=); the database's own refusal
 * (KF-DOC-DETERMINISM-001) still governs what a later compilation may record.
 *
 * What it does not do: it re-runs only what `content.compilation_determinism_sample` returns, the
 * newest succeeded runs whose registration is enabled, so a compiler nondeterministic only on
 * older sources is caught when those are compiled again and not before; and a re-run on a host
 * whose installed binary is not the registered one fails as `rerun_failed` (the adapter refuses
 * the pin), which says the host drifted rather than that the compiler is nondeterministic.
 */

import type { ObjectStore } from '@kf/artifacts';
import {
  runCompilation,
  type DocumentCompilerAdapter,
  type LiminalCompilerIdentity,
} from '@kf/documents';
import { boundedAdapter, loadCompilerInputs } from './input-guard.js';
import { DEFAULT_MAX_CANONICAL_INPUT_BYTES, DEFAULT_MAX_SOURCE_BYTES } from './runtime.js';
import type { CompilerRuntimeRepository } from './types.js';

export type DeterminismProblem = 'run_digest_differs' | 'rerun_failed' | 'not_a_recorded_success';

export interface DeterminismFinding {
  readonly actionId: string;
  readonly runId: string | null;
  readonly problem: DeterminismProblem;
  readonly recordedRunDigest: string | null;
  readonly rerunRunDigest: string | null;
  readonly detail: string;
}

export interface DeterminismReport {
  /** Request acts re-run, in the order given. */
  readonly checked: readonly string[];
  readonly findings: readonly DeterminismFinding[];
}

export interface DeterminismOptions {
  /** Only `load` is used: the re-run reads its request as the worker does, and persists nothing. */
  readonly repository: Pick<CompilerRuntimeRepository, 'load'>;
  readonly store: ObjectStore;
  readonly adapterFor: (identity: LiminalCompilerIdentity) => DocumentCompilerAdapter;
  readonly actionIds: readonly string[];
  readonly maxSourceBytes?: number;
  readonly maxCanonicalInputBytes?: number;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/** Re-run each recorded success and report every run that did not reproduce. */
export async function rerunRecordedCompilations(
  options: DeterminismOptions,
): Promise<DeterminismReport> {
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  const maxCanonicalInputBytes =
    options.maxCanonicalInputBytes ?? DEFAULT_MAX_CANONICAL_INPUT_BYTES;
  const findings: DeterminismFinding[] = [];
  for (const actionId of options.actionIds) {
    const finding = (
      problem: DeterminismProblem,
      detail: string,
      recorded: { runId: string; runDigest: string } | null = null,
      rerunRunDigest: string | null = null,
    ): void => {
      findings.push({
        actionId,
        runId: recorded?.runId ?? null,
        problem,
        recordedRunDigest: recorded?.runDigest ?? null,
        rerunRunDigest,
        detail,
      });
    };
    let request;
    try {
      request = await options.repository.load(actionId);
    } catch (error: unknown) {
      finding('rerun_failed', `the request could not be read: ${message(error)}`);
      continue;
    }
    const existing = request.existing;
    if (existing === null || existing.status !== 'succeeded') {
      finding('not_a_recorded_success', 'the act has no succeeded run to reproduce');
      continue;
    }
    const identity = request.basis.compiler;
    if (identity.kind !== 'liminal') {
      finding('rerun_failed', 'the Basis does not name a pinned Liminal compiler', existing);
      continue;
    }
    try {
      const loaded = await loadCompilerInputs(options.store, request.inputs, maxSourceBytes);
      if (loaded.failure !== undefined) {
        finding('rerun_failed', `${loaded.failure.code}: ${loaded.failure.message}`, existing);
        continue;
      }
      const run = await runCompilation({
        id: existing.runId,
        basis: request.basis,
        inputs: loaded.inputs,
        adapter: boundedAdapter(options.adapterFor(identity), maxCanonicalInputBytes),
      });
      if (run.status !== 'succeeded') {
        finding(
          'rerun_failed',
          `${run.failureCode ?? 'failed'}: ${run.failureMessage ?? ''}`.slice(0, 500),
          existing,
          run.runDigest,
        );
      } else if (run.runDigest !== existing.runDigest) {
        finding(
          'run_digest_differs',
          'the same Basis and input bytes compiled to a different run digest',
          existing,
          run.runDigest,
        );
      }
    } catch (error: unknown) {
      finding('rerun_failed', message(error), existing);
    }
  }
  return { checked: [...options.actionIds], findings };
}
