import type { ActionEffect, PreconditionCheck } from '@kf/actions';
import { requireString } from '@kf/record-atoms';
import type { DocumentClassification } from '../compiler.js';
import { refuseDocument } from './action-payload.js';
import {
  actionParameters,
  actionReceipt,
  type CompilationRunReceipt,
} from './compilation-receipts.js';
import { assertActiveFragmentRevisions } from './composition-retirement.js';
import { touchDocumentObject } from './composition-store.js';
import { assertTechnicalDocumentAuthority } from './document-authority.js';
import { COMPOSITION_TARGET, requireDocumentTarget } from './target-classification.js';

interface PublicationActions {
  readonly assertPublishDocumentView: PreconditionCheck;
  readonly publishDocumentView: ActionEffect;
}

export function createPublicationActions(): PublicationActions {
  interface CompiledViewReceipt
    extends
      Record<string, unknown>,
      Pick<
        CompilationRunReceipt,
        | 'run_id'
        | 'run_digest'
        | 'run_status'
        | 'draft_only'
        | 'semantic_digest'
        | 'hir_provenance'
        | 'cir_provenance'
        | 'unresolved_references'
        | 'omitted_subgraphs'
        | 'diagnostics'
        | 'conversion_loss'
        | 'requested_by_action'
        | 'basis_id'
        | 'basis_digest'
        | 'target_profiles'
        | 'basis_created_by_action'
        | 'target_object_id'
        | 'compiler_enabled'
        | 'hir_provenance_complete'
        | 'cir_provenance_complete'
      > {
    readonly view_id: string;
    readonly view_target: string;
    readonly content_digest: string;
    readonly artifact_version_id: string;
    readonly effective_classification: DocumentClassification;
  }

  const assertPublishDocumentView: PreconditionCheck = async (tx, request, objects) => {
    await assertTechnicalDocumentAuthority(tx, request, objects);
    const object = requireDocumentTarget(objects, COMPOSITION_TARGET, request.actionType);
    const publicationTarget = requireString(request.payload, 'publication_target_id');
    const viewId = requireString(request.payload, 'compiled_view_id');
    const compiledViewDigest = requireString(request.payload, 'compiled_view_digest');
    const view = await tx.maybeOne<CompiledViewReceipt>(
      `select v.id as view_id, v.target as view_target, v.content_digest,
              v.artifact_version_id, v.effective_classification,
              r.id as run_id, r.run_digest, r.run_status, r.draft_only, r.semantic_digest,
              r.hir_provenance, r.cir_provenance, r.unresolved_references,
              r.omitted_subgraphs, r.diagnostics, r.conversion_loss,
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
         from content.compiled_view v
         join content.compilation_run r on r.id = v.compilation_run_id
         join content.compilation_basis b on b.id = r.basis_id
         join content.composition_revision cr on cr.id = b.root_composition_revision_id
         join content.document_subject s on s.id = cr.composition_id
        where v.id = $1`,
      [viewId],
    );
    if (
      view === undefined ||
      view.target_object_id !== object.id ||
      view.content_digest !== compiledViewDigest ||
      !Array.isArray(view.target_profiles) ||
      !view.target_profiles.some(
        (profile) =>
          profile !== null &&
          typeof profile === 'object' &&
          !Array.isArray(profile) &&
          (profile as Record<string, unknown>)['target'] === view.view_target,
      )
    ) {
      refuseDocument('KF-DOC-PUBLISH-001', 'compiled view is missing or targets another document', {
        viewId,
      });
    }
    const target = await tx.maybeOne<{ id: string; max_rank: number }>(
      `select target.id, classification.rank as max_rank
         from content.document_publication_target target
         join registry.classification classification
           on classification.id = target.max_classification
        where target.id = $1 and target.organization_id = $2
          and not exists (
            select 1 from content.document_publication_target_retirement retired
             where retired.target_id = target.id
          )`,
      [publicationTarget, request.organizationId],
    );
    if (target === undefined) {
      refuseDocument('KF-DOC-PUBLISH-003', 'publication target is missing or retired', {
        publicationTarget,
      });
    }
    const viewRank = await tx.one<{ rank: number }>(
      'select rank from registry.classification where id = $1',
      [view.effective_classification],
    );
    if (viewRank.rank > target.max_rank) {
      refuseDocument('KF-DOC-PUBLISH-004', 'compiled view classification exceeds target max', {
        publicationTarget,
      });
    }
    const acceptanceId = requireString(request.payload, 'acceptance_action_id');
    const acceptance = await actionReceipt(tx, acceptanceId);
    const parameters = actionParameters(acceptance, 'KF-DOC-PUBLISH-002');
    if (
      acceptance.action_type !== 'accept_document_compilation' ||
      acceptance.target_ids.length !== 1 ||
      acceptance.target_ids[0] !== object.id ||
      parameters['run_id'] !== view.run_id ||
      parameters['run_digest'] !== view.run_digest ||
      view.run_status !== 'succeeded' ||
      view.draft_only ||
      !view.compiler_enabled ||
      !view.hir_provenance_complete ||
      !view.cir_provenance_complete ||
      !Array.isArray(view.hir_provenance) ||
      view.hir_provenance.length === 0 ||
      !Array.isArray(view.cir_provenance) ||
      view.cir_provenance.length === 0 ||
      !Array.isArray(view.unresolved_references) ||
      view.unresolved_references.length !== 0 ||
      !Array.isArray(view.omitted_subgraphs) ||
      view.omitted_subgraphs.length !== 0 ||
      !Array.isArray(view.conversion_loss) ||
      view.conversion_loss.length !== 0
    ) {
      refuseDocument(
        'KF-DOC-PUBLISH-002',
        'publication requires the exact accepted, qualified compilation run',
        { viewId, acceptanceId },
      );
    }
    const basisFragments = await tx.query<{ fragment_revision_id: string }>(
      `select fragment_revision_id
         from content.compilation_basis_fragment
        where basis_id = $1
        order by fragment_revision_id`,
      [view.basis_id],
    );
    await assertActiveFragmentRevisions(
      tx,
      basisFragments.map((row) => row.fragment_revision_id),
      'KF-DOC-PUBLISH-005',
    );
    const controlledDocumentId = requireString(request.payload, 'controlled_document_id');
    const contentVersionId = requireString(request.payload, 'controlled_content_version_id');
    const controlledDocument = await tx.maybeOne<{
      id: string;
      content_version: string | null;
      lifecycle_state: string;
      classification: string;
      organization_id: string;
    }>(
      `select cd.id, cd.content_version, o.lifecycle_state, o.classification, o.organization_id
         from quality.controlled_document cd
         join core.object o on o.id = cd.id
        where cd.id = $1
        for share of o`,
      [controlledDocumentId],
    );
    if (
      controlledDocument === undefined ||
      controlledDocument.content_version !== contentVersionId ||
      controlledDocument.content_version !== view.artifact_version_id ||
      controlledDocument.lifecycle_state !== 'effective' ||
      controlledDocument.organization_id !== request.organizationId
    ) {
      refuseDocument(
        'KF-DOC-PUBLISH-005',
        'publication requires the exact effective controlled document revision',
        { controlledDocumentId, contentVersionId },
      );
    }
    const controlledRank = await tx.one<{ rank: number }>(
      'select rank from registry.classification where id = $1',
      [controlledDocument.classification],
    );
    if (controlledRank.rank < viewRank.rank) {
      refuseDocument('KF-DOC-PUBLISH-006', 'controlled document classification is below the view', {
        controlledDocumentId,
      });
    }
  };

  const publishDocumentView: ActionEffect = async (tx, request, objects, ctx) => {
    const object = requireDocumentTarget(objects, COMPOSITION_TARGET, request.actionType);
    await tx.one<{ id: string }>(
      `insert into content.document_publication
         (action_id, acceptance_action_id, organization_id, subject_id, compiled_view_id,
          compiled_view_digest, controlled_document_id, controlled_content_version_id,
          publication_target_id, publication_target_policy_digest, effective_classification,
          published_by)
       select $1, $2, $3, $4, view.id, view.content_digest, controlled.id,
              controlled.content_version, target.id, target.policy_digest,
              view.effective_classification, $5
         from content.compiled_view view
         join quality.controlled_document controlled on controlled.id = $6
         join content.document_publication_target target on target.id = $7
        where view.id = $8
        returning id`,
      [
        ctx.actionId,
        requireString(request.payload, 'acceptance_action_id'),
        request.organizationId,
        object.id,
        request.actorId,
        requireString(request.payload, 'controlled_document_id'),
        requireString(request.payload, 'publication_target_id'),
        requireString(request.payload, 'compiled_view_id'),
      ],
    );
    await touchDocumentObject(tx, request, object.id);
  };

  return { assertPublishDocumentView, publishDocumentView };
}
