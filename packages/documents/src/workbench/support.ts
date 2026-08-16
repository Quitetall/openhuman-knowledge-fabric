import type { WorkspaceHolder, WorkspaceTargetRow } from './contracts.js';

export function iso(value: Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

export function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function holderFromRow(row: WorkspaceTargetRow): WorkspaceHolder {
  if (row.holder_kind === 'git') {
    if (row.git_repository === null || row.git_commit_sha === null || row.git_path === null) {
      throw new Error('git source Holder is missing repository, commit, or path metadata');
    }
    return {
      kind: 'git',
      id: row.holder_id,
      repository: row.git_repository,
      commitSha: row.git_commit_sha,
      path: row.git_path,
      submoduleCommitSha: row.git_submodule_commit_sha,
      contentDigest: row.content_digest,
    };
  }
  if (row.holder_kind === 'external') {
    if (row.external_authority === null || row.external_revision === null) {
      throw new Error('external source Holder is missing authority or revision metadata');
    }
    return {
      kind: 'external',
      id: row.holder_id,
      authority: row.external_authority,
      revision: row.external_revision,
      contentDigest: row.content_digest,
    };
  }
  if (row.fabric_artifact_version_id === null) {
    throw new Error('fabric-native source Holder is missing artifact metadata');
  }
  return {
    kind: 'fabric_native',
    id: row.holder_id,
    artifactVersionId: row.fabric_artifact_version_id,
    contentDigest: row.content_digest,
    mediaType: row.media_type,
  };
}
