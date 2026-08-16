import { digest } from '@kf/canonicalization';
import type {
  AuthoredFragmentRevision,
  AuthoredFragmentRevisionInput,
  SourceHolder,
} from './core-types.js';
import { classification, exactKeys, fail, GIT_COMMIT, nonEmpty, sha256 } from './primitives.js';

function sourceHolder(input: SourceHolder, fragmentId: string): SourceHolder {
  if (input.subjectId !== fragmentId) {
    fail('holder_subject_mismatch', 'source holder subjectId must equal the fragmentId');
  }
  nonEmpty(input.subjectId, 'holder.subjectId');
  sha256(input.contentDigest, 'holder.contentDigest');

  if (input.kind === 'fabric_native') {
    exactKeys(
      input,
      ['kind', 'subjectId', 'artifactVersionId', 'contentDigest'],
      'fabric_native holder',
    );
    return Object.freeze({
      kind: input.kind,
      subjectId: input.subjectId,
      artifactVersionId: nonEmpty(input.artifactVersionId, 'holder.artifactVersionId'),
      contentDigest: input.contentDigest,
    });
  }
  if (input.kind === 'git') {
    exactKeys(
      input,
      [
        'kind',
        'subjectId',
        'repository',
        'commitSha',
        'path',
        'submoduleCommitSha',
        'contentDigest',
      ],
      'git holder',
    );
    if (!GIT_COMMIT.test(input.commitSha)) {
      fail('invalid_git_commit', 'holder.commitSha must be a full lowercase hexadecimal commit');
    }
    if (input.submoduleCommitSha !== null && !GIT_COMMIT.test(input.submoduleCommitSha)) {
      fail(
        'invalid_git_commit',
        'holder.submoduleCommitSha must be null or a full lowercase hexadecimal commit',
      );
    }
    return Object.freeze({
      kind: input.kind,
      subjectId: input.subjectId,
      repository: nonEmpty(input.repository, 'holder.repository'),
      commitSha: input.commitSha,
      path: nonEmpty(input.path, 'holder.path'),
      submoduleCommitSha: input.submoduleCommitSha,
      contentDigest: input.contentDigest,
    });
  }
  if (input.kind === 'external') {
    exactKeys(
      input,
      ['kind', 'subjectId', 'authority', 'revision', 'contentDigest'],
      'external holder',
    );
    return Object.freeze({
      kind: input.kind,
      subjectId: input.subjectId,
      authority: nonEmpty(input.authority, 'holder.authority'),
      revision: nonEmpty(input.revision, 'holder.revision'),
      contentDigest: input.contentDigest,
    });
  }
  return fail('unknown_source_holder', 'source holder kind is not supported');
}

/** Construct one exact, immutable authored-source revision. */
export function createAuthoredFragmentRevision(
  input: AuthoredFragmentRevisionInput,
): AuthoredFragmentRevision {
  const claim: AuthoredFragmentRevisionInput = {
    id: nonEmpty(input.id, 'id'),
    fragmentId: nonEmpty(input.fragmentId, 'fragmentId'),
    previousRevisionId:
      input.previousRevisionId === null
        ? null
        : nonEmpty(input.previousRevisionId, 'previousRevisionId'),
    mediaType: nonEmpty(input.mediaType, 'mediaType'),
    classification: classification(input.classification, 'classification'),
    state: input.state,
    holder: sourceHolder(input.holder, input.fragmentId),
  };
  return Object.freeze({ ...claim, revisionDigest: digest(claim) });
}
