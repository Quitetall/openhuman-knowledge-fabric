import type { Tx } from '@kf/database';
import type { DocumentWorkspace, WorkspaceTargetRow } from './contracts.js';
import { compositionInputs, compositionNodes } from './composition-repository.js';
import { adrLinks, navigationLinks, topicLinks } from './navigation-repository.js';
import { recentRuns, runViews, successfulRuns } from './run-repository.js';
import { diffSemanticGraphs } from './semantic-diff.js';
import { array, holderFromRow, iso } from './support.js';

export { resolveDocumentWorkbenchTarget } from './target-repository.js';

export async function documentWorkspace(
  tx: Tx,
  target: WorkspaceTargetRow,
): Promise<DocumentWorkspace> {
  const runs = await recentRuns(tx, target.basis_id);
  const current = runs[0];
  const projections =
    current?.run_status === 'succeeded' ? await runViews(tx, current.run_id) : [];
  const succeeded = await successfulRuns(tx, target.basis_id);
  const latestSucceeded = succeeded[0];
  const previousSucceeded = succeeded[1];
  const diff =
    latestSucceeded !== undefined &&
    previousSucceeded !== undefined &&
    latestSucceeded.semantic_graph !== null &&
    latestSucceeded.semantic_graph !== undefined &&
    previousSucceeded.semantic_graph !== null &&
    previousSucceeded.semantic_graph !== undefined
      ? {
          status: 'available' as const,
          fromRunId: previousSucceeded.run_id,
          toRunId: latestSucceeded.run_id,
          ...diffSemanticGraphs(previousSucceeded.semantic_graph, latestSucceeded.semantic_graph),
        }
      : { status: 'unavailable' as const };
  const links = await navigationLinks(tx, target.target_object_id);
  const traceability = links.filter((link) =>
    ['implements', 'verifies', 'supersedes', 'amends', 'extends'].includes(link.relationType),
  );
  return {
    status: 'ready',
    target: {
      kind: target.target_kind,
      objectId: target.target_object_id,
      subjectId: target.subject_id,
      stableKey: target.stable_key,
      documentPolicy: target.document_policy,
      baseRevisionId: target.base_revision_id,
      rowVersion: target.target_row_version,
      classification: target.classification,
      holderId: target.holder_id,
      holder: holderFromRow(target),
      contentDigest: target.content_digest,
      mediaType: target.media_type,
    },
    basis: {
      id: target.basis_id,
      digest: target.basis_digest,
      effectiveClassification: target.effective_classification,
      finalizedAt: iso(target.finalized_at),
      targetProfiles: array(target.target_profiles),
    },
    compilation:
      current === undefined
        ? null
        : {
            runId: current.run_id,
            status: current.run_status,
            draftOnly: current.draft_only,
            semanticDigest: current.semantic_digest,
            diagnostics: array(current.diagnostics),
            conversionLoss: array(current.conversion_loss),
            recordedAt: iso(current.recorded_at),
          },
    projections,
    composition: {
      rootRevisionId: target.target_kind === 'document_composition' ? target.base_revision_id : '',
      nodes: await compositionNodes(tx, target.basis_id),
      inputs: await compositionInputs(tx, target.basis_id),
    },
    navigation: {
      backlinks: links.filter((link) => link.direction === 'inbound'),
      traceability,
      adr: await adrLinks(tx, target.target_object_id),
      topics: await topicLinks(tx, target.target_object_id),
    },
    semanticDiff: diff,
  };
}
