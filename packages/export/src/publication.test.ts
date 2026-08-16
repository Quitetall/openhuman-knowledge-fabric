import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { canonicalize, digestBytes } from '@kf/canonicalization';
import type { Tx } from '@kf/database';
import { describe, expect, it } from 'vitest';
import * as packageRoot from './index.js';
import * as publication from './publication.js';

const COMPILED_BYTES = Buffer.from('<h1>Public</h1>');
const COMPILED_DIGEST = digestBytes(COMPILED_BYTES);
const REQUEST = {
  publicationId: 'publication-01',
  controlledRevisionId: 'revision-01',
  compiledViewId: 'view-01',
} as const;

const AUTHORITY_ROW = {
  publication_id: 'publication-01',
  publication_action_id: 'publish-action-01',
  acceptance_action_id: 'acceptance-action-01',
  controlled_revision_id: 'revision-01',
  controlled_content_version_id: 'content-version-01',
  compiled_view_id: 'view-01',
  compiled_view_digest: COMPILED_DIGEST,
  compiled_view_media_type: 'text/html',
  publication_target_id: 'website-target-01',
  publication_target_policy_digest: 'b'.repeat(64),
  document_classification: 'public',
  effective_classification: 'public',
  lifecycle_state: 'effective',
  published_at: new Date('2026-08-14T20:00:00.000Z'),
};

function authorityTx(override: Readonly<Record<string, unknown>> | null = {}): Tx {
  return {
    async maybeOne(sql: string, params: readonly unknown[]) {
      expect(sql.trimStart()).toMatch(/^select\b/i);
      expect(sql).toContain('from content.document_publication publication');
      expect(sql).toContain("publication_action.action_type = 'publish_document_view'");
      expect(sql).toContain("acceptance_action.action_type = 'accept_document_compilation'");
      expect(params).toEqual(['publication-01', 'revision-01', 'view-01']);
      return override === null ? undefined : { ...AUTHORITY_ROW, ...override };
    },
  } as unknown as Tx;
}

function signedBundle(privateKey: KeyObject): publication.SignedPublicationBundle {
  const manifest: publication.PublicationManifest = {
    format_version: 'kf-publication-v1',
    publication_id: 'publication-01',
    publication_action_id: 'publish-action-01',
    acceptance_action_id: 'acceptance-action-01',
    controlled_revision_id: 'revision-01',
    controlled_content_version_id: 'content-version-01',
    compiled_view_id: 'view-01',
    compiled_view_digest: COMPILED_DIGEST,
    compiled_view_media_type: 'text/html',
    publication_target_id: 'website-target-01',
    publication_target_policy_digest: 'b'.repeat(64),
    classification: 'public',
    lifecycle_state: 'effective',
    published_at: '2026-08-14T20:00:00.000Z',
    files: [
      {
        path: 'index.html',
        media_type: 'text/html',
        size_bytes: COMPILED_BYTES.byteLength,
        sha256: COMPILED_DIGEST,
      },
    ],
  };
  return {
    manifest,
    signature: {
      algorithm: 'Ed25519',
      key_id: 'publish-2026-01',
      value_base64: sign(null, Buffer.from(canonicalize(manifest), 'utf8'), privateKey).toString(
        'base64',
      ),
    },
    files: [{ path: 'index.html', mediaType: 'text/html', bytes: COMPILED_BYTES }],
  };
}

function signedManifestOverride(
  privateKey: KeyObject,
  override: Readonly<Record<string, unknown>>,
): unknown {
  const bundle = signedBundle(privateKey);
  const manifest = { ...bundle.manifest, ...override };
  return {
    ...bundle,
    manifest,
    signature: {
      ...bundle.signature,
      value_base64: sign(
        null,
        Buffer.from(canonicalize(manifest as never), 'utf8'),
        privateKey,
      ).toString('base64'),
    },
  };
}

describe('approved-public publication projection', () => {
  it('exposes only read-only projection and verification capabilities', () => {
    expect(Object.keys(publication).sort()).toEqual([
      'DEFAULT_STORED_PUBLICATION_BUNDLE_MAX_BYTES',
      'createApprovedPublicProjectionLoader',
      'loadApprovedPublicProjection',
      'verifyPublicationBundle',
    ]);
    expect(packageRoot).not.toHaveProperty('buildAuthorizedPublicationBundle');
    expect(packageRoot).not.toHaveProperty('loadAuthorizedPublicationProjection');
  });

  it('serves an already-authorized, already-signed public bundle without mutation', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const bundle = signedBundle(privateKey);

    await expect(
      publication.loadApprovedPublicProjection(
        authorityTx(),
        REQUEST,
        bundle,
        new Map([['publish-2026-01', publicKey]]),
      ),
    ).resolves.toEqual(bundle);
  });

  it.each([
    ['missing receipt', null],
    ['non-public document', { document_classification: 'internal' }],
    ['non-public effective classification', { effective_classification: 'confidential' }],
    ['not effective', { lifecycle_state: 'approved' }],
  ] as const)('fails closed for %s authority', async (_label, override) => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    await expect(
      publication.loadApprovedPublicProjection(
        authorityTx(override),
        REQUEST,
        signedBundle(privateKey),
        new Map([['publish-2026-01', publicKey]]),
      ),
    ).rejects.toThrow(/not authorized for public publication/);
  });

  it('accepts only trusted public Ed25519 verification keys', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    await expect(
      publication.loadApprovedPublicProjection(
        authorityTx(),
        REQUEST,
        signedBundle(privateKey),
        new Map([['publish-2026-01', privateKey]]),
      ),
    ).rejects.toThrow(/public Ed25519/);
  });

  it('fails closed for an unsigned bundle', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const { signature: _signature, ...unsigned } = signedBundle(privateKey);
    await expect(
      publication.loadApprovedPublicProjection(
        authorityTx(),
        REQUEST,
        unsigned,
        new Map([['publish-2026-01', publicKey]]),
      ),
    ).rejects.toThrow(/signature must be an object/);
  });

  it('fails closed when supplied bytes do not match the signed digest', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const bundle = signedBundle(privateKey);
    const changedBytes = {
      ...bundle,
      files: [{ ...bundle.files[0]!, bytes: Buffer.from('<h1>Changed</h1>') }],
    };
    await expect(
      publication.loadApprovedPublicProjection(
        authorityTx(),
        REQUEST,
        changedBytes,
        new Map([['publish-2026-01', publicKey]]),
      ),
    ).rejects.toThrow(/digest mismatch/);
  });

  it.each([
    ['non-public material', { classification: 'internal' }, /classification must be public/],
    ['unapproved material', { lifecycle_state: 'approved' }, /lifecycle_state must be effective/],
  ] as const)('fails closed for correctly signed %s', async (_label, override, expected) => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    await expect(
      publication.loadApprovedPublicProjection(
        authorityTx(),
        REQUEST,
        signedManifestOverride(privateKey, override),
        new Map([['publish-2026-01', publicKey]]),
      ),
    ).rejects.toThrow(expected);
  });

  it('fails closed when a valid signed bundle names a different authority receipt', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    await expect(
      publication.loadApprovedPublicProjection(
        authorityTx(),
        REQUEST,
        signedManifestOverride(privateKey, { publication_id: 'publication-02' }),
        new Map([['publish-2026-01', publicKey]]),
      ),
    ).rejects.toThrow(/publication_id mismatch/);
  });

  it('fails closed for an unknown or incorrect publication signing key', async () => {
    const signer = generateKeyPairSync('ed25519');
    const other = generateKeyPairSync('ed25519');
    const bundle = signedBundle(signer.privateKey);

    await expect(
      publication.loadApprovedPublicProjection(authorityTx(), REQUEST, bundle, new Map()),
    ).rejects.toThrow(/unknown publication signing key/);
    await expect(
      publication.loadApprovedPublicProjection(
        authorityTx(),
        REQUEST,
        bundle,
        new Map([['publish-2026-01', other.publicKey]]),
      ),
    ).rejects.toThrow(/manifest signature invalid/);
  });

  it('reports malformed untrusted input through the read-only verifier', () => {
    expect(publication.verifyPublicationBundle(null, new Map())).toEqual([
      'bundle must be an object',
    ]);
  });
});
