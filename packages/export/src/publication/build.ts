import { sign, type KeyObject } from 'node:crypto';
import { compareCanonicalText, digestBytes } from '@kf/canonicalization';
import { isAuthorizedPublicationProjection } from './authority.js';
import type {
  AuthorizedPublicationProjection,
  PublicationFile,
  PublicationManifest,
  SignedPublicationBundle,
} from './types.js';
import { canonicalManifestBytes, requireText, safePath } from './validation.js';

interface PublicationBuildInput {
  readonly authority: AuthorizedPublicationProjection;
  readonly files: readonly PublicationFile[];
}

interface PublicationSigner {
  readonly keyId: string;
  readonly privateKey: KeyObject;
}

/** Package-internal service boundary; deliberately absent from the public package barrel. */
export function buildAuthorizedPublicationBundle(
  input: PublicationBuildInput,
  signer: PublicationSigner,
): SignedPublicationBundle {
  if (!isAuthorizedPublicationProjection(input.authority)) {
    throw new Error('publication requires a DB-authorized publication projection');
  }
  requireText(signer.keyId, 'keyId');
  if (signer.privateKey.type !== 'private' || signer.privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('publication signing key must be a private Ed25519 key');
  }
  if (input.files.length !== 1) {
    throw new Error('publication must contain exactly the authorized compiled view');
  }

  const seen = new Set<string>();
  const files = [...input.files]
    .map((file) => {
      if (!safePath(file.path)) throw new Error(`${file.path} is not a safe relative path`);
      if (seen.has(file.path)) throw new Error(`duplicate publication path ${file.path}`);
      seen.add(file.path);
      requireText(file.mediaType, `media type for ${file.path}`);
      return { ...file, bytes: Buffer.from(file.bytes) };
    })
    .sort((left, right) => compareCanonicalText(left.path, right.path));
  const compiledFile = files[0]!;
  if (
    digestBytes(compiledFile.bytes) !== input.authority.compiledViewDigest ||
    compiledFile.mediaType !== input.authority.compiledViewMediaType
  ) {
    throw new Error('publication bytes must be the exact authorized compiled view');
  }

  const manifest: PublicationManifest = {
    format_version: 'kf-publication-v1',
    publication_id: input.authority.publicationId,
    publication_action_id: input.authority.publicationActionId,
    acceptance_action_id: input.authority.acceptanceActionId,
    controlled_revision_id: input.authority.controlledRevisionId,
    controlled_content_version_id: input.authority.controlledContentVersionId,
    compiled_view_id: input.authority.compiledViewId,
    compiled_view_digest: input.authority.compiledViewDigest,
    compiled_view_media_type: input.authority.compiledViewMediaType,
    publication_target_id: input.authority.publicationTargetId,
    publication_target_policy_digest: input.authority.publicationTargetPolicyDigest,
    classification: 'public',
    lifecycle_state: input.authority.lifecycleState,
    published_at: input.authority.publishedAt,
    files: files.map((file) => ({
      path: file.path,
      media_type: file.mediaType,
      size_bytes: file.bytes.byteLength,
      sha256: digestBytes(file.bytes),
    })),
  };
  return {
    manifest,
    signature: {
      algorithm: 'Ed25519',
      key_id: signer.keyId,
      value_base64: sign(null, canonicalManifestBytes(manifest), signer.privateKey).toString(
        'base64',
      ),
    },
    files,
  };
}
