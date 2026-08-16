import type { Tx } from '@kf/database';
import type { WorkspaceCompositionInput, WorkspaceCompositionNode } from './contracts.js';
import { iso } from './support.js';

interface CompositionNodeRow extends Record<string, unknown> {
  readonly revision_id: string;
  readonly subject_id: string;
  readonly object_id: string;
  readonly title: string;
  readonly stable_key: string;
  readonly revision_digest: string;
  readonly classification: string;
  readonly created_at: Date;
}

interface CompositionInputRow extends Record<string, unknown> {
  readonly composition_revision_id: string;
  readonly ordinal: number;
  readonly role: WorkspaceCompositionInput['role'];
  readonly target_id: string;
  readonly target_title: string | null;
  readonly content_digest: string | null;
}

export async function compositionNodes(
  tx: Tx,
  basisId: string,
): Promise<readonly WorkspaceCompositionNode[]> {
  const rows = await tx.query<CompositionNodeRow>(
    `select /* document.workspace-composition-nodes */
            revision.id as revision_id,
            subject.id as subject_id,
            object.id as object_id,
            object.title,
            subject.stable_key,
            revision.revision_digest,
            revision.classification,
            revision.created_at
       from content.compilation_basis_composition member
       join content.composition_revision revision on revision.id = member.composition_revision_id
       join content.document_subject subject on subject.id = revision.composition_id
       join core.object object on object.id = subject.object_id
      where member.basis_id = $1
      order by revision.created_at, revision.id`,
    [basisId],
  );
  return rows.map((row) => ({
    revisionId: row.revision_id,
    subjectId: row.subject_id,
    objectId: row.object_id,
    title: row.title,
    stableKey: row.stable_key,
    revisionDigest: row.revision_digest,
    classification: row.classification,
    createdAt: iso(row.created_at),
  }));
}

export async function compositionInputs(
  tx: Tx,
  basisId: string,
): Promise<readonly WorkspaceCompositionInput[]> {
  const rows = await tx.query<CompositionInputRow>(
    `select /* document.workspace-composition-inputs */
            input.composition_revision_id,
            input.ordinal,
            input.input_role as role,
            coalesce(input.fragment_revision_id, input.child_composition_revision_id,
                     input.resource_version_id, input.binding_id, input.compiled_view_id)
              as target_id,
            coalesce(fragment_object.title, composition_object.title, artifact.title,
                     binding.selector, compiled_view.target) as target_title,
            coalesce(input.content_digest, fragment_revision.content_digest,
                     artifact.sha256, binding.value_digest, compiled_view.content_digest)
              as content_digest
       from content.compilation_basis_composition member
       join content.composition_input input
         on input.composition_revision_id = member.composition_revision_id
       left join content.authored_fragment_revision fragment_revision
         on fragment_revision.id = input.fragment_revision_id
       left join content.document_subject fragment_subject
         on fragment_subject.id = fragment_revision.fragment_id
       left join core.object fragment_object on fragment_object.id = fragment_subject.object_id
       left join content.composition_revision child_revision
         on child_revision.id = input.child_composition_revision_id
       left join content.document_subject composition_subject
         on composition_subject.id = child_revision.composition_id
       left join core.object composition_object on composition_object.id = composition_subject.object_id
       left join content.artifact_version artifact on artifact.id = input.resource_version_id
       left join content.typed_binding binding on binding.id = input.binding_id
       left join content.compiled_view compiled_view on compiled_view.id = input.compiled_view_id
      where member.basis_id = $1
      order by input.composition_revision_id, input.ordinal`,
    [basisId],
  );
  return rows.map((row) => ({
    compositionRevisionId: row.composition_revision_id,
    ordinal: row.ordinal,
    role: row.role,
    targetId: row.target_id,
    targetTitle: row.target_title,
    contentDigest: row.content_digest,
  }));
}
