import type { Tx } from '@kf/database';
import type { WorkspaceTarget, WorkspaceTargetRow } from './contracts.js';

export async function resolveDocumentWorkbenchTarget(
  tx: Tx,
  documentId: string,
): Promise<WorkspaceTarget> {
  const rows = await tx.query<WorkspaceTargetRow>(
    `select * from (
       select /* document.workspace-targets */
              target.id as target_object_id,
              target.object_type as target_kind,
              subject.id as subject_id,
              subject.stable_key,
              subject.document_policy,
              revision.id as base_revision_id,
              target.row_version::text as target_row_version,
              revision.classification,
              holder.id as holder_id,
              holder.holder_kind,
              holder.fabric_artifact_version_id,
              holder.git_repository,
              holder.git_commit_sha,
              holder.git_path,
              holder.git_submodule_commit_sha,
              holder.external_authority,
              holder.external_revision,
              revision.content_digest,
              revision.media_type,
              basis.id as basis_id,
              basis.basis_digest,
              basis.effective_classification,
              basis.finalized_at,
              basis.target_profiles
         from quality.controlled_document document
         join content.document_source_holder holder
           on holder.holder_kind = 'fabric_native'
          and holder.fabric_artifact_version_id = document.content_version
         join content.document_subject subject
           on subject.id = holder.subject_id and subject.subject_kind = 'fragment'
          and subject.current_holder_id = holder.id
         join core.object target
           on target.id = subject.object_id and target.object_type = 'authored_fragment'
         join content.authored_fragment_revision revision
           on revision.fragment_id = subject.id and revision.holder_id = holder.id
         join content.compilation_basis_fragment member
           on member.fragment_revision_id = revision.id
         join content.compilation_basis basis
           on basis.id = member.basis_id and basis.finalized_at is not null
        where document.id = $1
          and not exists (
            select 1 from content.authored_fragment_revision successor
             where successor.fragment_id = revision.fragment_id
               and successor.previous_revision_id = revision.id
          )
       union all
       select /* document.workspace-targets */
              target.id as target_object_id,
              target.object_type as target_kind,
              subject.id as subject_id,
              subject.stable_key,
              subject.document_policy,
              revision.id as base_revision_id,
              target.row_version::text as target_row_version,
              revision.classification,
              holder.id as holder_id,
              holder.holder_kind,
              holder.fabric_artifact_version_id,
              holder.git_repository,
              holder.git_commit_sha,
              holder.git_path,
              holder.git_submodule_commit_sha,
              holder.external_authority,
              holder.external_revision,
              holder.content_digest,
              revision.media_type,
              basis.id as basis_id,
              basis.basis_digest,
              basis.effective_classification,
              basis.finalized_at,
              basis.target_profiles
         from content.document_subject subject
         join core.object target
           on target.id = subject.object_id and target.object_type = 'authored_fragment'
         join content.document_source_holder holder on holder.id = subject.current_holder_id
         join content.authored_fragment_revision revision
           on revision.fragment_id = subject.id and revision.holder_id = holder.id
         join content.compilation_basis_fragment member
           on member.fragment_revision_id = revision.id
         join content.compilation_basis basis
           on basis.id = member.basis_id and basis.finalized_at is not null
        where target.id = $1
          and subject.subject_kind = 'fragment'
          and not exists (
            select 1 from content.authored_fragment_revision successor
             where successor.fragment_id = revision.fragment_id
               and successor.previous_revision_id = revision.id
          )
       union all
       select /* document.workspace-targets */
              target.id as target_object_id,
              target.object_type as target_kind,
              subject.id as subject_id,
              subject.stable_key,
              subject.document_policy,
              revision.id as base_revision_id,
              target.row_version::text as target_row_version,
              revision.classification,
              holder.id as holder_id,
              holder.holder_kind,
              holder.fabric_artifact_version_id,
              holder.git_repository,
              holder.git_commit_sha,
              holder.git_path,
              holder.git_submodule_commit_sha,
              holder.external_authority,
              holder.external_revision,
              holder.content_digest,
              artifact.media_type,
              basis.id as basis_id,
              basis.basis_digest,
              basis.effective_classification,
              basis.finalized_at,
              basis.target_profiles
         from content.document_subject subject
         join core.object target
           on target.id = subject.object_id and target.object_type = 'document_composition'
         join content.document_source_holder holder on holder.id = subject.current_holder_id
         join content.composition_revision revision
           on revision.composition_id = subject.id and revision.holder_id = holder.id
         left join content.artifact_version artifact on artifact.id = holder.fabric_artifact_version_id
         join content.compilation_basis_composition member
           on member.composition_revision_id = revision.id
         join content.compilation_basis basis
           on basis.id = member.basis_id
          and basis.root_composition_revision_id = revision.id
          and basis.finalized_at is not null
        where target.id = $1
          and subject.subject_kind = 'composition'
          and not exists (
            select 1 from content.composition_revision successor
             where successor.composition_id = revision.composition_id
               and successor.previous_revision_id = revision.id
          )
      ) candidate
      order by finalized_at desc, basis_id
      limit 2`,
    [documentId],
  );
  if (rows.length === 0) return { status: 'unavailable' };
  if (rows.length !== 1) return { status: 'ambiguous' };
  return { status: 'ready', row: rows[0]! };
}
