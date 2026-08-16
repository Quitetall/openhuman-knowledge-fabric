import type { ActionRequest, ObjectRow } from '@kf/actions';
import { digest } from '@kf/canonicalization';
import type { Tx } from '@kf/database';
import { requireString } from '@kf/record-atoms';
import { verifyCompilationRunPreimage, type DocumentClassification } from '../compiler.js';
import { refuseDocument, requireDigest } from './action-payload.js';
import {
  actionParameters,
  actionReceipt,
  compilationRunReceipt,
  type CompilationRunReceipt,
} from './compilation-receipts.js';
import { assertActiveFragmentRevisions } from './composition-retirement.js';

export const assertAuthorizedCompilationRun = async (
  tx: Tx,
  request: ActionRequest,
  object: ObjectRow,
): Promise<CompilationRunReceipt> => {
  const runId = requireString(request.payload, 'run_id');
  const receipt = await compilationRunReceipt(tx, runId);
  if (
    receipt.run_digest !== requireDigest(request.payload, 'run_digest') ||
    receipt.target_object_id !== object.id
  ) {
    refuseDocument('KF-DOC-COMPILE-003', 'compilation receipt does not match the request target', {
      runId,
      objectId: object.id,
    });
  }
  const basisFragments = await tx.query<{ fragment_revision_id: string }>(
    `select fragment_revision_id
       from content.compilation_basis_fragment
      where basis_id = $1
      order by fragment_revision_id`,
    [receipt.basis_id],
  );
  await assertActiveFragmentRevisions(
    tx,
    basisFragments.map((row) => row.fragment_revision_id),
    'KF-DOC-COMPILE-006',
  );
  const targetProfiles = Array.isArray(receipt.target_profiles)
    ? receipt.target_profiles
    : undefined;
  const expectedTargets = targetProfiles
    ? targetProfiles
        .map((profile) =>
          profile !== null && typeof profile === 'object' && !Array.isArray(profile)
            ? (profile as Record<string, unknown>)['target']
            : undefined,
        )
        .filter((target): target is string => typeof target === 'string')
        .sort()
    : [];
  const recordedViews = await tx.query<{
    target: string;
    media_type: string;
    content_digest: string;
    effective_classification: DocumentClassification;
  }>(
    `select target, media_type, content_digest, effective_classification
       from content.compiled_view where compilation_run_id = $1 order by target`,
    [runId],
  );
  if (
    expectedTargets.length === 0 ||
    expectedTargets.length !== targetProfiles?.length ||
    JSON.stringify(recordedViews.map((view) => view.target)) !== JSON.stringify(expectedTargets)
  ) {
    refuseDocument(
      'KF-DOC-COMPILE-005',
      'compilation run does not contain exactly its Basis-declared views',
      { runId },
    );
  }
  if (receipt.canonical_preimage === null) {
    refuseDocument(
      'KF-DOC-COMPILE-007',
      'compilation run lacks independently verifiable canonical preimage',
      { runId },
    );
  }
  let preimage;
  try {
    preimage = verifyCompilationRunPreimage(receipt.canonical_preimage, receipt.run_digest);
  } catch (error: unknown) {
    return refuseDocument(
      'KF-DOC-COMPILE-007',
      'compilation run canonical preimage failed independent verification',
      { runId, cause: error instanceof Error ? error.message : String(error) },
    );
  }
  const recordedViewClaims = recordedViews.map((view) => ({
    target: view.target,
    mediaType: view.media_type,
    contentDigest: view.content_digest,
    effectiveClassification: view.effective_classification,
  }));
  if (
    preimage.id !== receipt.run_id ||
    preimage.basisDigest !== receipt.basis_digest ||
    preimage.compilerDigest !== receipt.compiler_digest ||
    preimage.dependencyDigest !== receipt.dependency_digest ||
    preimage.status !== receipt.run_status ||
    preimage.draftOnly !== receipt.draft_only ||
    preimage.effectiveClassification !== receipt.effective_classification ||
    preimage.semanticDigest !== receipt.semantic_digest ||
    digest(preimage.semanticGraph) !== digest(receipt.semantic_graph) ||
    digest(preimage.hirProvenance) !== digest(receipt.hir_provenance) ||
    digest(preimage.cirProvenance) !== digest(receipt.cir_provenance) ||
    digest(preimage.unresolvedReferences) !== digest(receipt.unresolved_references) ||
    digest(preimage.omittedSubgraphs) !== digest(receipt.omitted_subgraphs) ||
    digest(preimage.projectionCapabilities) !== digest(receipt.projection_capabilities) ||
    preimage.failureCode !== receipt.failure_code ||
    preimage.failureMessage !== receipt.failure_message ||
    digest(preimage.diagnostics) !== digest(receipt.diagnostics) ||
    digest(preimage.conversionLoss) !== digest(receipt.conversion_loss) ||
    digest(preimage.views) !== digest(recordedViewClaims)
  ) {
    refuseDocument(
      'KF-DOC-COMPILE-007',
      'compilation run canonical preimage differs from authoritative receipt rows',
      { runId },
    );
  }
  if (
    receipt.run_status !== 'succeeded' ||
    receipt.draft_only ||
    !receipt.compiler_enabled ||
    !receipt.hir_provenance_complete ||
    !receipt.cir_provenance_complete ||
    receipt.semantic_digest === null ||
    !Array.isArray(receipt.hir_provenance) ||
    receipt.hir_provenance.length === 0 ||
    !Array.isArray(receipt.cir_provenance) ||
    receipt.cir_provenance.length === 0 ||
    !Array.isArray(receipt.unresolved_references) ||
    receipt.unresolved_references.length !== 0 ||
    !Array.isArray(receipt.omitted_subgraphs) ||
    receipt.omitted_subgraphs.length !== 0 ||
    !Array.isArray(receipt.diagnostics) ||
    !receipt.diagnostics.every((item) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
      const diagnostic = item as Record<string, unknown>;
      return (
        (diagnostic['severity'] === 'info' ||
          diagnostic['severity'] === 'warning' ||
          diagnostic['severity'] === 'error') &&
        diagnostic['severity'] !== 'error' &&
        typeof diagnostic['code'] === 'string' &&
        diagnostic['code'].trim() !== '' &&
        typeof diagnostic['message'] === 'string' &&
        diagnostic['message'].trim() !== ''
      );
    }) ||
    !Array.isArray(receipt.conversion_loss) ||
    receipt.conversion_loss.length !== 0
  ) {
    refuseDocument(
      'KF-DOC-COMPILE-004',
      'only a succeeded, qualified, complete, resolved, provenance-covered, lossless compilation may be accepted',
      { runId },
    );
  }
  if (
    receipt.requested_by_action !== receipt.basis_created_by_action ||
    receipt.requested_by_action.trim() === ''
  ) {
    refuseDocument(
      'KF-DOC-002',
      'compilation run is not tied to the action that authorized its exact Basis',
      { runId },
    );
  }
  const authorization = await actionReceipt(tx, receipt.requested_by_action);
  const parameters = actionParameters(authorization, 'KF-DOC-002');
  if (
    authorization.action_type !== 'request_document_compilation' ||
    authorization.target_ids.length !== 1 ||
    authorization.target_ids[0] !== object.id ||
    parameters['basis_id'] !== receipt.basis_id ||
    parameters['basis'] === null ||
    typeof parameters['basis'] !== 'object' ||
    Array.isArray(parameters['basis']) ||
    (parameters['basis'] as Record<string, unknown>)['basisDigest'] !== receipt.basis_digest
  ) {
    refuseDocument('KF-DOC-002', 'compilation request receipt does not authorize this run', {
      runId,
      requestActionId: receipt.requested_by_action,
    });
  }
  return receipt;
};
