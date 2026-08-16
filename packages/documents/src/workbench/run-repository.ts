import type { Tx } from '@kf/database';
import type { WorkspaceProjection } from './contracts.js';

export interface WorkspaceRunRow extends Record<string, unknown> {
  readonly run_id: string;
  readonly run_status: 'succeeded' | 'failed';
  readonly draft_only: boolean;
  readonly semantic_digest: string | null;
  readonly semantic_graph: unknown;
  readonly diagnostics: unknown;
  readonly conversion_loss: unknown;
  readonly recorded_at: Date;
}

interface WorkspaceViewRow extends Record<string, unknown> {
  readonly id: string;
  readonly target: string;
  readonly media_type: string;
  readonly artifact_version_id: string;
  readonly content_digest: string;
  readonly effective_classification: string;
}

export async function recentRuns(tx: Tx, basisId: string): Promise<readonly WorkspaceRunRow[]> {
  return tx.query<WorkspaceRunRow>(
    `select /* document.workspace-runs */
            run.id as run_id, run.run_status, run.draft_only, run.semantic_digest,
            preimage.semantic_graph, run.diagnostics, run.conversion_loss, run.recorded_at
       from content.compilation_run run
       left join content.compilation_run_preimage preimage on preimage.run_id = run.id
      where run.basis_id = $1
      order by run.recorded_at desc, run.id desc
      limit 1`,
    [basisId],
  );
}

export async function successfulRuns(tx: Tx, basisId: string): Promise<readonly WorkspaceRunRow[]> {
  return tx.query<WorkspaceRunRow>(
    `select /* document.workspace-successful-runs */
            run.id as run_id, run.run_status, run.draft_only, run.semantic_digest,
            preimage.semantic_graph, run.diagnostics, run.conversion_loss, run.recorded_at
       from content.compilation_run run
       join content.compilation_run_preimage preimage on preimage.run_id = run.id
      where run.basis_id = $1 and run.run_status = 'succeeded'
      order by run.recorded_at desc, run.id desc
      limit 2`,
    [basisId],
  );
}

export async function runViews(tx: Tx, runId: string): Promise<readonly WorkspaceProjection[]> {
  const rows = await tx.query<WorkspaceViewRow>(
    `select /* document.workspace-views */
            view.id, view.target, view.media_type, view.artifact_version_id,
            view.content_digest, view.effective_classification
       from content.compiled_view view
      where view.compilation_run_id = $1
      order by view.target, view.id`,
    [runId],
  );
  return rows.map((view) => ({
    id: view.id,
    target: view.target,
    mediaType: view.media_type,
    artifactVersionId: view.artifact_version_id,
    contentDigest: view.content_digest,
    effectiveClassification: view.effective_classification,
  }));
}
