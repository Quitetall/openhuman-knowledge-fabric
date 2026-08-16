import { generateKeyPairSync } from 'node:crypto';
import { digestBytes } from '@kf/canonicalization';
import type { Tx } from '@kf/database';
import { describe, expect, it } from 'vitest';
import { loadAuthorizedPublicationProjection } from './publication/authority.js';
import { buildAuthorizedPublicationBundle } from './publication/build.js';
import { verifyPublicationBundle } from './publication/bundle.js';
import type { AuthorizedPublicationProjection } from './publication/types.js';

const BYTES = Buffer.from('<h1>Public</h1>');

function fabricatedAuthority(): AuthorizedPublicationProjection {
  return {
    publicationId: 'publication-01',
    publicationActionId: 'publish-action-01',
    acceptanceActionId: 'acceptance-action-01',
    controlledRevisionId: 'revision-01',
    controlledContentVersionId: 'content-version-01',
    compiledViewId: 'view-01',
    compiledViewDigest: digestBytes(BYTES),
    compiledViewMediaType: 'text/html',
    publicationTargetId: 'website-target-01',
    publicationTargetPolicyDigest: 'b'.repeat(64),
    classification: 'public',
    lifecycleState: 'effective',
    publishedAt: '2026-08-14T20:00:00.000Z',
  };
}

function authorityTx(): Tx {
  return {
    async maybeOne() {
      return {
        publication_id: 'publication-01',
        publication_action_id: 'publish-action-01',
        acceptance_action_id: 'acceptance-action-01',
        controlled_revision_id: 'revision-01',
        controlled_content_version_id: 'content-version-01',
        compiled_view_id: 'view-01',
        compiled_view_digest: digestBytes(BYTES),
        compiled_view_media_type: 'text/html',
        publication_target_id: 'website-target-01',
        publication_target_policy_digest: 'b'.repeat(64),
        document_classification: 'public',
        effective_classification: 'public',
        lifecycle_state: 'effective',
        published_at: new Date('2026-08-14T20:00:00.000Z'),
      };
    },
  } as unknown as Tx;
}

describe('publication bundle service', () => {
  it('does not let a structurally fabricated authority reach the signer', () => {
    const { privateKey } = generateKeyPairSync('ed25519');

    expect(() =>
      buildAuthorizedPublicationBundle(
        {
          authority: fabricatedAuthority(),
          files: [{ path: 'index.html', mediaType: 'text/html', bytes: BYTES }],
        },
        { keyId: 'publish-2026-01', privateKey },
      ),
    ).toThrow(/DB-authorized publication projection/);
  });

  it('builds a verifiable bundle only after the database authority lookup', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const authority = await loadAuthorizedPublicationProjection(authorityTx(), {
      publicationId: 'publication-01',
      controlledRevisionId: 'revision-01',
      compiledViewId: 'view-01',
    });

    const bundle = buildAuthorizedPublicationBundle(
      {
        authority,
        files: [{ path: 'index.html', mediaType: 'text/html', bytes: BYTES }],
      },
      { keyId: 'publish-2026-01', privateKey },
    );

    expect(verifyPublicationBundle(bundle, new Map([['publish-2026-01', publicKey]]))).toEqual([]);
    expect(bundle.manifest).toMatchObject({
      publication_id: 'publication-01',
      publication_action_id: 'publish-action-01',
      acceptance_action_id: 'acceptance-action-01',
      classification: 'public',
      lifecycle_state: 'effective',
      compiled_view_digest: digestBytes(BYTES),
    });
  });
});
