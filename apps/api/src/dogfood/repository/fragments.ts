import type { Tx } from '@kf/database';
import type { CurrentFragmentSource } from './contracts.js';

export async function currentFragmentSource(
  tx: Tx,
  organizationId: string,
  stableKey: string,
): Promise<CurrentFragmentSource | undefined> {
  return tx.maybeOne<CurrentFragmentSource>(
    `/* dogfood.current-fragment-source */
     select s.object_id as "objectId", h.id as "holderId",
            r.holder_id as "revisionHolderId", h.holder_kind as "holderKind",
            h.fabric_artifact_version_id as "artifactVersionId",
            h.content_digest as "contentDigest", r.id as "revisionId",
            r.media_type as "mediaType", r.classification
       from content.document_subject s
       join core.object o on o.id = s.object_id
       join content.document_source_holder h on h.id = s.current_holder_id
       join content.authored_fragment_revision r on r.fragment_id = s.id
      where s.stable_key = $1 and s.subject_kind = 'fragment'
        and o.organization_id = $2
        and not exists (
          select 1 from content.authored_fragment_revision next
           where next.previous_revision_id = r.id
        )
      for update of s`,
    [stableKey, organizationId],
  );
}

export async function fragmentRevisionCreatedByAction(
  tx: Tx,
  organizationId: string,
  actionId: string,
): Promise<{ readonly objectId: string; readonly revisionId: string }> {
  return tx.one<{ objectId: string; revisionId: string }>(
    `select s.object_id as "objectId", r.id as "revisionId"
       from content.authored_fragment_revision r
       join content.document_subject s on s.id = r.fragment_id
       join core.object o on o.id = s.object_id
      where r.created_by_action = $1 and o.organization_id = $2`,
    [actionId, organizationId],
  );
}
