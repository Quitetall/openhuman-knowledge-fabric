import {
  SHA256,
  canonicalInstant,
  closedKeys,
  isRecord,
  requiredText,
  safePath,
  type ValidationState,
} from './validation.js';

export const PUBLICATION_MANIFEST_KEYS = [
  'format_version',
  'publication_id',
  'publication_action_id',
  'acceptance_action_id',
  'controlled_revision_id',
  'controlled_content_version_id',
  'compiled_view_id',
  'compiled_view_digest',
  'compiled_view_media_type',
  'publication_target_id',
  'publication_target_policy_digest',
  'classification',
  'lifecycle_state',
  'published_at',
  'files',
] as const;

export interface ManifestInspection {
  readonly publicationId: string | undefined;
  readonly publicationActionId: string | undefined;
  readonly acceptanceActionId: string | undefined;
  readonly controlledRevisionId: string | undefined;
  readonly controlledContentVersionId: string | undefined;
  readonly compiledViewId: string | undefined;
  readonly compiledViewDigest: string | undefined;
  readonly compiledViewMediaType: string | undefined;
  readonly publicationTargetId: string | undefined;
  readonly publicationTargetPolicyDigest: string | undefined;
  readonly filesAreArray: boolean;
}

export function inspectManifest(
  manifest: Record<string, unknown>,
  state: ValidationState,
): ManifestInspection {
  const formatVersion = requiredText(state, manifest, 'format_version', 'manifest.format_version');
  const publicationId = requiredText(state, manifest, 'publication_id', 'manifest.publication_id');
  const publicationActionId = requiredText(
    state,
    manifest,
    'publication_action_id',
    'manifest.publication_action_id',
  );
  const acceptanceActionId = requiredText(
    state,
    manifest,
    'acceptance_action_id',
    'manifest.acceptance_action_id',
  );
  const controlledRevisionId = requiredText(
    state,
    manifest,
    'controlled_revision_id',
    'manifest.controlled_revision_id',
  );
  const controlledContentVersionId = requiredText(
    state,
    manifest,
    'controlled_content_version_id',
    'manifest.controlled_content_version_id',
  );
  const compiledViewId = requiredText(
    state,
    manifest,
    'compiled_view_id',
    'manifest.compiled_view_id',
  );
  const compiledViewDigest = requiredText(
    state,
    manifest,
    'compiled_view_digest',
    'manifest.compiled_view_digest',
  );
  const compiledViewMediaType = requiredText(
    state,
    manifest,
    'compiled_view_media_type',
    'manifest.compiled_view_media_type',
  );
  const publicationTargetId = requiredText(
    state,
    manifest,
    'publication_target_id',
    'manifest.publication_target_id',
  );
  const publicationTargetPolicyDigest = requiredText(
    state,
    manifest,
    'publication_target_policy_digest',
    'manifest.publication_target_policy_digest',
  );
  const classification = requiredText(state, manifest, 'classification', 'manifest.classification');
  const lifecycleState = requiredText(
    state,
    manifest,
    'lifecycle_state',
    'manifest.lifecycle_state',
  );
  const publishedAt = requiredText(state, manifest, 'published_at', 'manifest.published_at');

  if (formatVersion !== undefined && formatVersion !== 'kf-publication-v1') {
    state.findings.push('manifest.format_version must be kf-publication-v1');
  }
  if (classification !== undefined && classification !== 'public') {
    state.findings.push('manifest.classification must be public');
  }
  if (lifecycleState !== undefined && lifecycleState !== 'effective') {
    state.findings.push('manifest.lifecycle_state must be effective');
  }
  if (compiledViewDigest !== undefined && !SHA256.test(compiledViewDigest)) {
    state.findings.push('manifest.compiled_view_digest must be a lowercase hexadecimal digest');
  }
  if (publicationTargetPolicyDigest !== undefined && !SHA256.test(publicationTargetPolicyDigest)) {
    state.findings.push(
      'manifest.publication_target_policy_digest must be a lowercase hexadecimal digest',
    );
  }
  if (publishedAt !== undefined && !canonicalInstant(publishedAt)) {
    state.findings.push('manifest.published_at must be a canonical ISO-8601 instant');
  }

  const files = manifest.files;
  const filesAreArray = Array.isArray(files);
  if (!filesAreArray) {
    state.findings.push('manifest.files must be an array');
    state.structurallyValid = false;
  } else {
    inspectManifestFiles(files, compiledViewDigest, compiledViewMediaType, state);
  }
  return {
    publicationId,
    publicationActionId,
    acceptanceActionId,
    controlledRevisionId,
    controlledContentVersionId,
    compiledViewId,
    compiledViewDigest,
    compiledViewMediaType,
    publicationTargetId,
    publicationTargetPolicyDigest,
    filesAreArray,
  };
}

function inspectManifestFiles(
  files: unknown[],
  compiledViewDigest: string | undefined,
  compiledViewMediaType: string | undefined,
  state: ValidationState,
): void {
  if (files.length !== 1) {
    state.findings.push('manifest.files must contain exactly the authorized compiled view');
  }
  for (const [index, unknownEntry] of files.entries()) {
    if (!isRecord(unknownEntry)) {
      state.findings.push(`manifest.files[${index}] must be an object`);
      state.structurallyValid = false;
      continue;
    }
    closedKeys(
      unknownEntry,
      ['path', 'media_type', 'size_bytes', 'sha256'],
      `manifest.files[${index}]`,
      state.findings,
    );
    const path = requiredText(state, unknownEntry, 'path', `manifest.files[${index}].path`);
    requiredText(state, unknownEntry, 'media_type', `manifest.files[${index}].media_type`);
    if (path !== undefined && !safePath(path)) state.findings.push(`${path}: unsafe manifest path`);
    if (!Number.isSafeInteger(unknownEntry.size_bytes) || Number(unknownEntry.size_bytes) < 0) {
      state.findings.push(
        `${path ?? `manifest.files[${index}]`}: size_bytes must be a non-negative safe integer`,
      );
    }
    if (typeof unknownEntry.sha256 !== 'string') {
      state.findings.push(`${path ?? `manifest.files[${index}]`}: sha256 must be a string`);
      state.structurallyValid = false;
    } else if (!SHA256.test(unknownEntry.sha256)) {
      state.findings.push(
        `${path ?? `manifest.files[${index}]`}: sha256 must be a lowercase hexadecimal digest`,
      );
    }
  }
  const compiledFile = files[0];
  if (isRecord(compiledFile)) {
    if (compiledViewDigest !== undefined && compiledFile.sha256 !== compiledViewDigest) {
      state.findings.push('manifest file digest does not match manifest.compiled_view_digest');
    }
    if (compiledViewMediaType !== undefined && compiledFile.media_type !== compiledViewMediaType) {
      state.findings.push('manifest file media type does not match authorized compiled view');
    }
  }
}
