import type { DocumentProposalSourceHolder } from './contracts.js';
import { exactKeys, nonEmpty, record, sha256 } from './validation.js';

const GIT_COMMIT = /^[0-9a-f]{40}$/;

export function sourceHolder(value: unknown): DocumentProposalSourceHolder {
  const holder = record(value, 'holder');
  if (holder['kind'] === 'fabric_native') {
    exactKeys(holder, ['kind', 'artifact_version_id', 'content_digest'], 'fabric-native holder');
    return Object.freeze({
      kind: holder['kind'],
      artifact_version_id: nonEmpty(holder['artifact_version_id'], 'holder.artifact_version_id'),
      content_digest: sha256(holder['content_digest'], 'holder.content_digest'),
    });
  }
  if (holder['kind'] === 'external') {
    exactKeys(holder, ['kind', 'authority', 'revision', 'content_digest'], 'external holder');
    return Object.freeze({
      kind: holder['kind'],
      authority: nonEmpty(holder['authority'], 'holder.authority'),
      revision: nonEmpty(holder['revision'], 'holder.revision'),
      content_digest: sha256(holder['content_digest'], 'holder.content_digest'),
    });
  }
  if (holder['kind'] !== 'git') throw new Error('holder.kind is not supported');
  exactKeys(
    holder,
    ['kind', 'repository', 'commit_sha', 'path', 'submodule_commit_sha', 'content_digest'],
    'git holder',
  );
  const commitSha = nonEmpty(holder['commit_sha'], 'holder.commit_sha');
  if (!GIT_COMMIT.test(commitSha)) {
    throw new Error('holder.commit_sha must be a full lowercase hexadecimal Git commit');
  }
  const submoduleCommitSha = holder['submodule_commit_sha'];
  if (
    submoduleCommitSha !== null &&
    (typeof submoduleCommitSha !== 'string' || !GIT_COMMIT.test(submoduleCommitSha))
  ) {
    throw new Error(
      'holder.submodule_commit_sha must be null or a full lowercase hexadecimal Git commit',
    );
  }
  return Object.freeze({
    kind: holder['kind'],
    repository: nonEmpty(holder['repository'], 'holder.repository'),
    commit_sha: commitSha,
    path: nonEmpty(holder['path'], 'holder.path'),
    submodule_commit_sha: submoduleCommitSha,
    content_digest: sha256(holder['content_digest'], 'holder.content_digest'),
  });
}
