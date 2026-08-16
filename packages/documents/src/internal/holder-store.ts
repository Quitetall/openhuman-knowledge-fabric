import type { Tx } from '@kf/database';
import type { SourceHolder } from '../compiler.js';
import { refuseDocument } from './action-payload.js';

export async function insertSourceHolder(
  tx: Tx,
  input: {
    readonly id: string;
    readonly subjectId: string;
    readonly previousHolderId: string | null;
    readonly holder: SourceHolder;
    readonly conversionLoss: readonly unknown[];
    readonly migrationReason: string | null;
    readonly reversibleMigrationPlan: string | null;
    readonly actorId: string;
    readonly actionId: string;
  },
): Promise<void> {
  await tx.query(
    `insert into content.document_source_holder
       (id, subject_id, previous_holder_id, holder_kind, fabric_artifact_version_id,
        git_repository, git_commit_sha, git_path, git_submodule_commit_sha,
        external_authority, external_revision, content_digest, conversion_loss,
        migration_reason, reversible_migration_plan, recorded_by, recorded_by_action)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      input.id,
      input.subjectId,
      input.previousHolderId,
      input.holder.kind,
      input.holder.kind === 'fabric_native' ? input.holder.artifactVersionId : null,
      input.holder.kind === 'git' ? input.holder.repository : null,
      input.holder.kind === 'git' ? input.holder.commitSha : null,
      input.holder.kind === 'git' ? input.holder.path : null,
      input.holder.kind === 'git' ? input.holder.submoduleCommitSha : null,
      input.holder.kind === 'external' ? input.holder.authority : null,
      input.holder.kind === 'external' ? input.holder.revision : null,
      input.holder.contentDigest,
      JSON.stringify(input.conversionLoss),
      input.migrationReason,
      input.reversibleMigrationPlan,
      input.actorId,
      input.actionId,
    ],
  );
}

export interface HolderRow extends Record<string, unknown> {
  readonly subject_id: string;
  readonly holder_id: string;
  readonly holder_kind: 'fabric_native' | 'git' | 'external';
  readonly fabric_artifact_version_id: string | null;
  readonly git_repository: string | null;
  readonly git_commit_sha: string | null;
  readonly git_path: string | null;
  readonly git_submodule_commit_sha: string | null;
  readonly external_authority: string | null;
  readonly external_revision: string | null;
  readonly content_digest: string;
}

export function sourceHolderFromRow(row: HolderRow): SourceHolder {
  if (row.holder_kind === 'fabric_native' && row.fabric_artifact_version_id !== null) {
    return {
      kind: row.holder_kind,
      subjectId: row.subject_id,
      artifactVersionId: row.fabric_artifact_version_id,
      contentDigest: row.content_digest,
    };
  }
  if (
    row.holder_kind === 'git' &&
    row.git_repository !== null &&
    row.git_commit_sha !== null &&
    row.git_path !== null
  ) {
    return {
      kind: row.holder_kind,
      subjectId: row.subject_id,
      repository: row.git_repository,
      commitSha: row.git_commit_sha,
      path: row.git_path,
      submoduleCommitSha: row.git_submodule_commit_sha,
      contentDigest: row.content_digest,
    };
  }
  if (
    row.holder_kind === 'external' &&
    row.external_authority !== null &&
    row.external_revision !== null
  ) {
    return {
      kind: row.holder_kind,
      subjectId: row.subject_id,
      authority: row.external_authority,
      revision: row.external_revision,
      contentDigest: row.content_digest,
    };
  }
  return refuseDocument('KF-DOC-001', 'stored Source Holder is incomplete', {
    subjectId: row.subject_id,
    holderId: row.holder_id,
  });
}
