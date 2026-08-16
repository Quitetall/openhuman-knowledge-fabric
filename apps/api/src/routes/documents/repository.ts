import type { Tx } from '@kf/database';

export interface ImportedFragmentSource extends Record<string, unknown> {
  readonly fragment_id: string;
  readonly fragment_revision_id: string;
  readonly stable_key: string;
  readonly holder_id: string;
  readonly revision_holder_id: string;
  readonly holder_kind: 'fabric_native' | 'git' | 'external';
  readonly artifact_version_id: string | null;
  readonly content_digest: string;
  readonly media_type: string;
  readonly classification: string;
  readonly document_policy: 'ordinary' | 'controlled' | 'regulated';
}

interface SourceProvenanceRow extends Record<string, unknown> {
  readonly fragment_id: string;
  readonly fragment_revision_id: string;
  readonly stable_key: string;
  readonly document_policy: 'ordinary' | 'controlled' | 'regulated';
  readonly holder_id: string;
  readonly holder_kind: 'fabric_native';
  readonly artifact_version_id: string;
  readonly content_digest: string;
  readonly media_type: string;
  readonly classification: string;
  readonly revision_state: string;
  readonly revision_digest: string;
  readonly holder_recorded_at: Date;
  readonly holder_recorded_by_action: string;
  readonly revision_created_at: Date;
  readonly revision_created_by_action: string;
}

export interface ImportedControlledDocument extends Record<string, unknown> {
  readonly id: string;
  readonly title: string;
  readonly document_number: string;
  readonly revision: string;
  readonly document_class: string;
  readonly owning_role: string;
  readonly content_version_id: string | null;
}

export type SourceProvenance =
  | { readonly status: 'not_recorded' | 'ambiguous' }
  | {
      readonly status: 'recorded';
      readonly holderKind: 'fabric_native';
      readonly fragmentId: string;
      readonly fragmentRevisionId: string;
      readonly stableKey: string;
      readonly documentPolicy: 'ordinary' | 'controlled' | 'regulated';
      readonly holderId: string;
      readonly artifactVersionId: string;
      readonly contentDigest: string;
      readonly mediaType: string;
      readonly classification: string;
      readonly revisionState: string;
      readonly revisionDigest: string;
      readonly holderRecordedAt: string;
      readonly holderRecordedByAction: string;
      readonly revisionCreatedAt: string;
      readonly revisionCreatedByAction: string;
    };

/** Serialize one authoritative import identity, including its first absent-row creation. */
export async function lockDocumentImport(
  tx: Tx,
  organizationId: string,
  stableKey: string,
): Promise<void> {
  const lockKey = JSON.stringify(['kf.document-import', organizationId, stableKey]);
  await tx.query(
    `select /* document.lock-import */
            pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
    [lockKey],
  );
}

export async function currentImportSource(
  tx: Tx,
  organizationId: string,
  stableKey: string,
): Promise<ImportedFragmentSource | undefined> {
  return tx.maybeOne<ImportedFragmentSource>(
    `select /* document.current-import-source */
              s.object_id as fragment_id, r.id as fragment_revision_id, s.stable_key,
              h.id as holder_id, r.holder_id as revision_holder_id, h.holder_kind,
              h.fabric_artifact_version_id as artifact_version_id, h.content_digest,
              r.media_type, r.classification, s.document_policy
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

export async function sourceCreatedByAction(
  tx: Tx,
  organizationId: string,
  actionId: string,
): Promise<ImportedFragmentSource | undefined> {
  return tx.maybeOne<ImportedFragmentSource>(
    `select /* document.source-by-action */
              s.object_id as fragment_id, r.id as fragment_revision_id, s.stable_key,
              h.id as holder_id, r.holder_id as revision_holder_id, h.holder_kind,
              h.fabric_artifact_version_id as artifact_version_id, h.content_digest,
              r.media_type, r.classification, s.document_policy
         from content.authored_fragment_revision r
         join content.document_subject s on s.id = r.fragment_id
         join core.object o on o.id = s.object_id
         join content.document_source_holder h
           on h.subject_id = s.id and h.id = r.holder_id
        where r.created_by_action = $1 and o.organization_id = $2`,
    [actionId, organizationId],
  );
}

export async function controlledDocumentSourceProvenance(
  tx: Tx,
  documentId: string,
  organizationId: string,
): Promise<SourceProvenance> {
  const rows = await tx.query<SourceProvenanceRow>(
    `select /* document.source-provenance */
            s.object_id as fragment_id, r.id as fragment_revision_id, s.stable_key,
            s.document_policy, h.id as holder_id, h.holder_kind,
            h.fabric_artifact_version_id as artifact_version_id, h.content_digest,
            r.media_type, r.classification, r.revision_state, r.revision_digest,
            h.recorded_at as holder_recorded_at,
            h.recorded_by_action as holder_recorded_by_action,
            r.created_at as revision_created_at,
            r.created_by_action as revision_created_by_action
       from quality.controlled_document d
       join content.document_source_holder h
         on h.holder_kind = 'fabric_native'
        and h.fabric_artifact_version_id = d.content_version
       join content.document_subject s on s.id = h.subject_id and s.subject_kind = 'fragment'
       join core.object o on o.id = s.object_id and o.organization_id = $2
       join content.authored_fragment_revision r
         on r.fragment_id = s.id and r.holder_id = h.id
      where d.id = $1
      order by h.recorded_at, r.created_at, r.id
      limit 2`,
    [documentId, organizationId],
  );
  if (rows.length === 0) return { status: 'not_recorded' };
  if (rows.length !== 1) return { status: 'ambiguous' };
  const row = rows[0]!;
  return {
    status: 'recorded',
    holderKind: row.holder_kind,
    fragmentId: row.fragment_id,
    fragmentRevisionId: row.fragment_revision_id,
    stableKey: row.stable_key,
    documentPolicy: row.document_policy,
    holderId: row.holder_id,
    artifactVersionId: row.artifact_version_id,
    contentDigest: row.content_digest,
    mediaType: row.media_type,
    classification: row.classification,
    revisionState: row.revision_state,
    revisionDigest: row.revision_digest,
    holderRecordedAt: row.holder_recorded_at.toISOString(),
    holderRecordedByAction: row.holder_recorded_by_action,
    revisionCreatedAt: row.revision_created_at.toISOString(),
    revisionCreatedByAction: row.revision_created_by_action,
  };
}

export async function importedControlledDocument(
  tx: Tx,
  organizationId: string,
  documentId: string,
): Promise<ImportedControlledDocument | undefined> {
  return tx.maybeOne<ImportedControlledDocument>(
    `select /* document.imported-controlled-document */
              d.id, o.title, d.document_number, d.revision, d.document_class,
              d.owning_role, d.content_version as content_version_id
         from quality.controlled_document d
         join core.object o on o.id = d.id
        where d.id = $1 and o.organization_id = $2`,
    [documentId, organizationId],
  );
}
