import type { KeyObject } from 'node:crypto';
import type { Tx } from '@kf/database';
import { loadAuthorizedPublicationProjection } from './authority.js';
import { verifyPublicationBundle } from './bundle.js';
import type {
  AuthorizedPublicationProjection,
  PublicationProjectionRequest,
  SignedPublicationBundle,
} from './types.js';

/**
 * Return an already-signed publication candidate only after current RLS-visible authority,
 * exact receipt identity, trusted signature, and byte digests all verify.
 */
export async function loadApprovedPublicProjection(
  tx: Tx,
  request: PublicationProjectionRequest,
  candidate: unknown,
  trustedSigningKeys: ReadonlyMap<string, KeyObject>,
): Promise<SignedPublicationBundle> {
  const authority = await loadAuthorizedPublicationProjection(tx, request);
  const findings = verifyPublicationBundle(candidate, trustedSigningKeys);
  if (findings.length > 0) {
    throw new Error(`publication bundle is not safe to serve: ${findings.join('; ')}`);
  }
  const bundle = candidate as SignedPublicationBundle;
  const mismatch = authorityMismatch(authority, bundle);
  if (mismatch !== undefined) {
    throw new Error(`publication bundle is not authorized for this projection: ${mismatch}`);
  }
  return bundle;
}

function authorityMismatch(
  authority: AuthorizedPublicationProjection,
  bundle: SignedPublicationBundle,
): string | undefined {
  const manifest = bundle.manifest;
  const expected: Readonly<Record<string, string>> = {
    publication_id: authority.publicationId,
    publication_action_id: authority.publicationActionId,
    acceptance_action_id: authority.acceptanceActionId,
    controlled_revision_id: authority.controlledRevisionId,
    controlled_content_version_id: authority.controlledContentVersionId,
    compiled_view_id: authority.compiledViewId,
    compiled_view_digest: authority.compiledViewDigest,
    compiled_view_media_type: authority.compiledViewMediaType,
    publication_target_id: authority.publicationTargetId,
    publication_target_policy_digest: authority.publicationTargetPolicyDigest,
    classification: authority.classification,
    lifecycle_state: authority.lifecycleState,
    published_at: authority.publishedAt,
  };
  for (const [field, value] of Object.entries(expected)) {
    if ((manifest as unknown as Record<string, unknown>)[field] !== value)
      return `${field} mismatch`;
  }
  return undefined;
}
