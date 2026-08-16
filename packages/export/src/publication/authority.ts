import type { Tx } from '@kf/database';
import type { AuthorizedPublicationProjection, PublicationProjectionRequest } from './types.js';
import { SHA256, canonicalInstant, requireText } from './validation.js';

const authorizedPublicationProjections = new WeakSet<object>();

export function isAuthorizedPublicationProjection(value: object): boolean {
  return authorizedPublicationProjections.has(value);
}

/** Resolve one publication boundary through PostgreSQL authority and active RLS context. */
export async function loadAuthorizedPublicationProjection(
  tx: Tx,
  request: PublicationProjectionRequest,
): Promise<AuthorizedPublicationProjection> {
  requireText(request.publicationId, 'publicationId');
  requireText(request.controlledRevisionId, 'controlledRevisionId');
  requireText(request.compiledViewId, 'compiledViewId');
  const row = await tx.maybeOne<{
    publication_id: string;
    publication_action_id: string;
    acceptance_action_id: string;
    controlled_revision_id: string;
    controlled_content_version_id: string;
    compiled_view_id: string;
    compiled_view_digest: string;
    compiled_view_media_type: string;
    publication_target_id: string;
    publication_target_policy_digest: string;
    document_classification: string;
    effective_classification: string;
    lifecycle_state: string;
    published_at: Date | string;
  }>(
    `select publication.id as publication_id,
            publication.action_id as publication_action_id,
            publication.acceptance_action_id,
            o.id as controlled_revision_id,
            publication.controlled_content_version_id,
            v.id as compiled_view_id,
            publication.compiled_view_digest,
            v.media_type as compiled_view_media_type,
            publication.publication_target_id,
            publication.publication_target_policy_digest,
            o.classification as document_classification,
            publication.effective_classification,
            o.lifecycle_state,
            publication.published_at
       from content.document_publication publication
       join quality.controlled_document d
         on d.id = publication.controlled_document_id
        and d.content_version = publication.controlled_content_version_id
       join core.object o on o.id = d.id
       join content.compiled_view v
         on v.id = publication.compiled_view_id
        and v.content_digest = publication.compiled_view_digest
       join content.compilation_run r on r.id = v.compilation_run_id
       join content.artifact_version av on av.id = v.artifact_version_id
       join content.artifact a on a.id = av.artifact_id
       join core.object artifact_object on artifact_object.id = a.id
       join core.action publication_action
         on publication_action.id = publication.action_id
        and publication_action.action_type = 'publish_document_view'
       join core.action acceptance_action
         on acceptance_action.id = publication.acceptance_action_id
        and acceptance_action.action_type = 'accept_document_compilation'
       join content.document_publication_target target
         on target.id = publication.publication_target_id
        and target.organization_id = publication.organization_id
        and target.policy_digest = publication.publication_target_policy_digest
      where publication.id = $1 and o.id = $2 and v.id = $3
        and publication.controlled_content_version_id = v.artifact_version_id
        and o.classification = 'public'
        and publication.effective_classification = 'public'
        and v.effective_classification = publication.effective_classification
        and artifact_object.classification = 'public'
        and o.lifecycle_state = 'effective'
        and r.run_status = 'succeeded' and not r.draft_only
        and jsonb_array_length(r.hir_provenance) > 0
        and jsonb_array_length(r.cir_provenance) > 0
        and r.unresolved_references = '[]'::jsonb
        and r.omitted_subgraphs = '[]'::jsonb
        and r.conversion_loss = '[]'::jsonb`,
    [request.publicationId, request.controlledRevisionId, request.compiledViewId],
  );
  const publishedAt =
    row === undefined
      ? undefined
      : row.published_at instanceof Date
        ? row.published_at.toISOString()
        : canonicalInstant(row.published_at)
          ? row.published_at
          : undefined;
  if (
    row === undefined ||
    row.publication_id !== request.publicationId ||
    row.controlled_revision_id !== request.controlledRevisionId ||
    row.compiled_view_id !== request.compiledViewId ||
    !SHA256.test(row.compiled_view_digest) ||
    row.compiled_view_media_type.trim() === '' ||
    !SHA256.test(row.publication_target_policy_digest) ||
    row.document_classification !== 'public' ||
    row.effective_classification !== 'public' ||
    row.lifecycle_state !== 'effective' ||
    publishedAt === undefined
  ) {
    throw new Error('document view is not authorized for public publication');
  }
  const projection: AuthorizedPublicationProjection = Object.freeze({
    publicationId: row.publication_id,
    publicationActionId: row.publication_action_id,
    acceptanceActionId: row.acceptance_action_id,
    controlledRevisionId: row.controlled_revision_id,
    controlledContentVersionId: row.controlled_content_version_id,
    compiledViewId: row.compiled_view_id,
    compiledViewDigest: row.compiled_view_digest,
    compiledViewMediaType: row.compiled_view_media_type,
    publicationTargetId: row.publication_target_id,
    publicationTargetPolicyDigest: row.publication_target_policy_digest,
    classification: 'public',
    lifecycleState: 'effective',
    publishedAt,
  });
  authorizedPublicationProjections.add(projection);
  return projection;
}
