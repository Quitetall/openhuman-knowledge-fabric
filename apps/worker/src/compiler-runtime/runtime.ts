import { createHash, randomUUID } from 'node:crypto';
import { createFailedCompilationRun, runCompilation, type CompilationRun } from '@kf/documents';
import { boundedAdapter, loadCompilerInputs } from './input-guard.js';
import {
  MaterializationIntegrityError,
  materializeViews,
  verifyStoredView,
} from './materialization.js';
import type {
  CompilationRuntime,
  CompilerRuntimeRequest,
  CompilerRuntimeResult,
  MaterializedCompiledView,
  RuntimeOptions,
} from './types.js';
import { requireUuid } from './validation.js';

const RUN_NAMESPACE = 'kf-document-compilation-run/v1\0';
const DEFAULT_MAX_CANONICAL_INPUT_BYTES = 16 * 1024 * 1024;
// Matches advertised document-source limit. Base64 expands 10 MiB to 13.34 MiB, retaining
// more than 2.6 MiB of Liminal's 16 MiB canonical request envelope for Basis and metadata.
// A 12 MiB raw budget consumes all 16 MiB before JSON framing and can never reach compiler.
const DEFAULT_MAX_SOURCE_BYTES = 10 * 1024 * 1024;

function deterministicRunId(actionId: string): string {
  const bytes = createHash('sha256')
    .update(RUN_NAMESPACE)
    .update(actionId)
    .digest()
    .subarray(0, 16);
  // RFC 9562 UUIDv8: application-defined digest payload plus standard variant bits.
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function failedRunFor(
  request: CompilerRuntimeRequest,
  id: string,
  code: string,
  message: string,
): CompilationRun {
  return createFailedCompilationRun({
    id,
    basis: request.basis,
    code,
    message,
  });
}

/** The database's KF-SAS-RQ-102 refusal (migration 20260925160100). */
function isUnreproducedCompilation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('KF-DOC-DETERMINISM-001');
}

export function createCompilationRuntime(options: RuntimeOptions): CompilationRuntime {
  const idFactory = options.idFactory ?? randomUUID;
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  const maxCanonicalInputBytes =
    options.maxCanonicalInputBytes ?? DEFAULT_MAX_CANONICAL_INPUT_BYTES;
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes <= 0) {
    throw new Error('maxSourceBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxCanonicalInputBytes) || maxCanonicalInputBytes <= 0) {
    throw new Error('maxCanonicalInputBytes must be a positive safe integer');
  }
  return {
    async process(actionId: string): Promise<CompilerRuntimeResult> {
      requireUuid(actionId, 'actionId');
      const request = await options.repository.load(actionId);
      if (request.actionId !== actionId) throw new Error('runtime request action mismatch');

      if (request.existing !== null) {
        await Promise.all(
          request.existing.views.map((view) => verifyStoredView(options.store, view)),
        );
        return {
          runId: request.existing.runId,
          status: request.existing.status,
          replayed: true,
        };
      }

      const runId = deterministicRunId(actionId);
      const identity = request.basis.compiler;
      if (identity.kind !== 'liminal') {
        throw new Error('runtime requires a Liminal compiler identity');
      }
      const loaded = await loadCompilerInputs(options.store, request.inputs, maxSourceBytes);
      let run =
        loaded.failure === undefined
          ? await runCompilation({
              id: runId,
              basis: request.basis,
              inputs: loaded.inputs,
              adapter: boundedAdapter(options.adapterFor(identity), maxCanonicalInputBytes),
            })
          : failedRunFor(request, runId, loaded.failure.code, loaded.failure.message);
      if (run.draftOnly !== request.draftOnly) {
        throw new Error('compiler result draftOnly differs from registry-derived request');
      }

      let views: readonly MaterializedCompiledView[] = [];
      if (run.status === 'succeeded') {
        try {
          views = await materializeViews(options.store, run, idFactory);
        } catch (error: unknown) {
          if (!(error instanceof MaterializationIntegrityError)) throw error;
          run = failedRunFor(request, runId, 'output_store_integrity_failed', error.message);
        }
      }

      let persistedId: string;
      try {
        persistedId = await options.repository.persist(request, run, views);
      } catch (error: unknown) {
        // KF-SAS-RQ-102: the database refuses a success that does not reproduce an earlier
        // compilation of the same sources by the same pinned compiler. That refusal is the
        // finding, so it is recorded as this request's failed run — naming the run it failed to
        // reproduce — rather than thrown back to the outbox to be retried into silence.
        if (run.status !== 'succeeded' || !isUnreproducedCompilation(error)) throw error;
        run = failedRunFor(
          request,
          runId,
          'nondeterministic_output',
          (error as Error).message.slice(0, 1000),
        );
        persistedId = await options.repository.persist(request, run, []);
      }
      return { runId: persistedId, status: run.status, replayed: false };
    },
  };
}
