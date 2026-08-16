import { setAccessContext, setTransactionContext, withTransaction, type Pool } from '@kf/database';
import {
  canonicalCompilationRunPreimage,
  canonicalCompilationSemanticPreimage,
  type CompilationRun,
} from '@kf/documents';
import type { CompilerRuntimeRepository, MaterializedCompiledView } from './types.js';
import { parseCompilerRuntimeRequest } from './validation.js';

function runPayload(run: CompilationRun, basisId: string): Record<string, unknown> {
  return {
    id: run.id,
    basisId,
    basisDigest: run.basisDigest,
    compilerDigest: run.compilerDigest,
    dependencyDigest: run.dependencyDigest,
    status: run.status,
    draftOnly: run.draftOnly,
    effectiveClassification: run.effectiveClassification,
    semanticDigest: run.semanticDigest,
    hirProvenance: run.hirProvenance,
    cirProvenance: run.cirProvenance,
    unresolvedReferences: run.unresolvedReferences,
    omittedSubgraphs: run.omittedSubgraphs,
    projectionCapabilities: run.projectionCapabilities,
    failureCode: run.failureCode,
    failureMessage: run.failureMessage,
    diagnostics: run.diagnostics,
    conversionLoss: run.conversionLoss,
    runDigest: run.runDigest,
  };
}

function viewPayload(view: MaterializedCompiledView): Record<string, unknown> {
  return {
    id: view.id,
    artifactId: view.artifactId,
    artifactVersionId: view.artifactVersionId,
    target: view.target,
    mediaType: view.mediaType,
    contentDigest: view.contentDigest,
    sizeBytes: view.sizeBytes,
    storageUri: view.storageUri,
    storageVersion: view.storageVersion,
  };
}

export function createPostgresCompilerRuntimeRepository(pool: Pool): CompilerRuntimeRepository {
  return {
    async load(actionId) {
      return withTransaction(pool, async (tx) => {
        const row = await tx.one<{ request: unknown }>(
          'select content.compiler_runtime_request($1) as request',
          [actionId],
        );
        return parseCompilerRuntimeRequest(row.request);
      });
    },

    async persist(request, run, views) {
      return withTransaction(pool, async (tx) => {
        await setAccessContext(tx, {
          organizationId: request.organizationId,
          maxClassification: request.maxClassification,
        });
        await setTransactionContext(tx, {
          actorId: request.actorId,
          actingRoleId: request.actingRoleId,
          actionId: request.actionId,
          ...(request.requestId === null ? {} : { requestId: request.requestId }),
        });
        const row = await tx.one<{ run_id: string }>(
          'select content.record_compilation_result($1, $2::jsonb, $3::jsonb) as run_id',
          [
            request.actionId,
            JSON.stringify(runPayload(run, request.basisId)),
            JSON.stringify(views.map(viewPayload)),
          ],
        );
        await tx.query('select content.record_compilation_preimage($1, $2::text, $3::text)', [
          row.run_id,
          canonicalCompilationRunPreimage(run),
          canonicalCompilationSemanticPreimage(run),
        ]);
        return row.run_id;
      });
    },
  };
}
