import type { Tx } from '@kf/database';
import type { DocumentClassification } from '../compiler.js';
import { refuseDocument } from './action-payload.js';

export interface CompilationRunReceipt extends Record<string, unknown> {
  readonly run_id: string;
  readonly run_digest: string;
  readonly run_status: string;
  readonly draft_only: boolean;
  readonly compiler_digest: string;
  readonly dependency_digest: string;
  readonly effective_classification: DocumentClassification;
  readonly semantic_graph: unknown;
  readonly semantic_digest: string | null;
  readonly hir_provenance: unknown;
  readonly cir_provenance: unknown;
  readonly unresolved_references: unknown;
  readonly omitted_subgraphs: unknown;
  readonly projection_capabilities: unknown;
  readonly failure_code: string | null;
  readonly failure_message: string | null;
  readonly diagnostics: unknown;
  readonly conversion_loss: unknown;
  readonly canonical_preimage: string | null;
  readonly requested_by_action: string;
  readonly basis_id: string;
  readonly basis_digest: string;
  readonly target_profiles: unknown;
  readonly basis_created_by_action: string;
  readonly target_object_id: string;
  readonly compiler_enabled: boolean;
  readonly hir_provenance_complete: boolean;
  readonly cir_provenance_complete: boolean;
}

export const compilationRunReceipt = async (
  tx: Tx,
  runId: string,
): Promise<CompilationRunReceipt> => {
  const row = await tx.maybeOne<CompilationRunReceipt>(
    `select r.id as run_id, r.run_digest, r.run_status, r.draft_only,
            r.compiler_digest, r.dependency_digest, r.effective_classification,
            preimage.semantic_graph, r.semantic_digest,
            r.hir_provenance, r.cir_provenance, r.unresolved_references,
            r.omitted_subgraphs, r.projection_capabilities,
            r.failure_code, r.failure_message, r.diagnostics, r.conversion_loss,
            preimage.canonical_preimage,
            r.requested_by_action, r.basis_id,
            b.basis_digest, b.target_profiles,
            b.created_by_action as basis_created_by_action,
            s.object_id as target_object_id,
            content.document_compiler_enabled(
              r.compiler_registration_id,
              b.id
            ) as compiler_enabled,
            content.compilation_run_provenance_complete(
              r.id,
              'hir'
            ) as hir_provenance_complete,
            content.compilation_run_provenance_complete(
              r.id,
              'cir'
            ) as cir_provenance_complete
       from content.compilation_run r
       left join content.compilation_run_preimage preimage on preimage.run_id = r.id
       join content.compilation_basis b on b.id = r.basis_id
       join content.composition_revision cr on cr.id = b.root_composition_revision_id
       join content.document_subject s on s.id = cr.composition_id
      where r.id = $1`,
    [runId],
  );
  if (row === undefined) {
    return refuseDocument('KF-DOC-COMPILE-001', 'compilation run is missing or not visible', {
      runId,
    });
  }
  return row;
};

export interface RecordedAction extends Record<string, unknown> {
  readonly action_type: string;
  readonly target_ids: string[];
  readonly parameters: unknown;
}

export const actionReceipt = async (tx: Tx, actionId: string): Promise<RecordedAction> => {
  const action = await tx.maybeOne<RecordedAction>(
    'select action_type, target_ids, parameters from core.action where id = $1',
    [actionId],
  );
  if (action === undefined) {
    return refuseDocument('KF-DOC-COMPILE-002', 'referenced action receipt is not visible', {
      actionId,
    });
  }
  return action;
};

export const actionParameters = (
  action: RecordedAction,
  rule: string,
): Readonly<Record<string, unknown>> => {
  if (
    action.parameters === null ||
    typeof action.parameters !== 'object' ||
    Array.isArray(action.parameters)
  ) {
    return refuseDocument(rule, 'recorded action parameters are not an object');
  }
  return action.parameters as Readonly<Record<string, unknown>>;
};
