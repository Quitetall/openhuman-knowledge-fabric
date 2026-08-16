import type { Tx } from '@kf/database';
import type {
  CurrentCompositionInput,
  CurrentCompositionRow,
  CurrentCompositionSource,
} from './contracts.js';

export async function currentCompositionSource(
  tx: Tx,
  organizationId: string,
  stableKey: string,
): Promise<CurrentCompositionSource | undefined> {
  const row = await tx.maybeOne<CurrentCompositionRow>(
    `/* dogfood.current-composition-source */
     select s.object_id as "objectId", h.id as "holderId",
            revision_holder.id as "revisionHolderId",
            h.holder_kind as "holderKind",
            h.fabric_artifact_version_id as "artifactVersionId",
            h.content_digest as "contentDigest", r.id as "revisionId", o.classification
       from content.document_subject s
       join core.object o on o.id = s.object_id
       join content.document_source_holder h on h.id = s.current_holder_id
       join content.composition_revision r on r.composition_id = s.id
       join content.document_source_holder revision_holder
         on revision_holder.subject_id = s.id
        and revision_holder.recorded_by_action = r.created_by_action
      where s.stable_key = $1 and s.subject_kind = 'composition'
        and o.organization_id = $2
        and not exists (
          select 1 from content.composition_revision next
           where next.previous_revision_id = r.id
        )
      for update of s`,
    [stableKey, organizationId],
  );
  if (row === undefined) return undefined;
  const inputs = await tx.query<CurrentCompositionInput>(
    `select ordinal, input_role as "inputRole",
            fragment_revision_id as "fragmentRevisionId"
       from content.composition_input
      where composition_revision_id = $1
      order by ordinal`,
    [row.revisionId],
  );
  return { ...row, inputs };
}

export async function compositionRevisionCreatedByAction(
  tx: Tx,
  organizationId: string,
  actionId: string,
): Promise<{ readonly objectId: string; readonly revisionId: string }> {
  return tx.one<{ objectId: string; revisionId: string }>(
    `select s.object_id as "objectId", r.id as "revisionId"
       from content.composition_revision r
       join content.document_subject s on s.id = r.composition_id
       join core.object o on o.id = s.object_id
      where r.created_by_action = $1 and o.organization_id = $2`,
    [actionId, organizationId],
  );
}
