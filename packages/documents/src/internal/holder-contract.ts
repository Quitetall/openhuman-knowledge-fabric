import { optionalString, requireString } from '@kf/record-atoms';
import type { SourceHolder } from '../compiler.js';
import { requireCommit, requireDigest, requireRecord } from './action-payload.js';

export function sourceHolderFromPayload(
  payload: Readonly<Record<string, unknown>> | undefined,
  subjectId: string,
): SourceHolder {
  const holder = requireRecord(payload, 'holder');
  const kind = requireString(holder, 'kind');
  const contentDigest = requireDigest(holder, 'content_digest');
  if (kind === 'fabric_native') {
    return {
      kind,
      subjectId,
      artifactVersionId: requireString(holder, 'artifact_version_id'),
      contentDigest,
    };
  }
  if (kind === 'git') {
    const submoduleCommitSha = optionalString(holder, 'submodule_commit_sha');
    if (submoduleCommitSha !== null && !/^[0-9a-f]{40}$/.test(submoduleCommitSha)) {
      throw new Error('holder.submodule_commit_sha must be a full lowercase Git commit');
    }
    return {
      kind,
      subjectId,
      repository: requireString(holder, 'repository'),
      commitSha: requireCommit(holder, 'commit_sha'),
      path: requireString(holder, 'path'),
      submoduleCommitSha,
      contentDigest,
    };
  }
  if (kind === 'external') {
    return {
      kind,
      subjectId,
      authority: requireString(holder, 'authority'),
      revision: requireString(holder, 'revision'),
      contentDigest,
    };
  }
  throw new Error('holder.kind must be fabric_native, git, or external');
}
