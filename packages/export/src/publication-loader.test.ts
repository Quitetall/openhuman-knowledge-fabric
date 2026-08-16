import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalize, digestBytes } from '@kf/canonicalization';
import type { Pool } from '@kf/database';
import { describe, expect, it, vi } from 'vitest';
import {
  createApprovedPublicProjectionLoader,
  type PublicationBundleStore,
} from './publication.js';
import type { PublicationManifest, SignedPublicationBundle } from './publication/types.js';

const REQUEST = {
  publicationId: 'publication-01',
  controlledRevisionId: 'document-01',
  compiledViewId: 'view-01',
} as const;
const ORGANIZATION_ID = 'organization-01';
const BYTES = Buffer.from('<h1>Public</h1>');
const DIGEST = digestBytes(BYTES);

function signedBundle(privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']) {
  const manifest: PublicationManifest = {
    format_version: 'kf-publication-v1',
    publication_id: REQUEST.publicationId,
    publication_action_id: 'publication-action-01',
    acceptance_action_id: 'acceptance-action-01',
    controlled_revision_id: REQUEST.controlledRevisionId,
    controlled_content_version_id: 'content-version-01',
    compiled_view_id: REQUEST.compiledViewId,
    compiled_view_digest: DIGEST,
    compiled_view_media_type: 'text/html',
    publication_target_id: 'publication-target-01',
    publication_target_policy_digest: 'a'.repeat(64),
    classification: 'public',
    lifecycle_state: 'effective',
    published_at: '2026-08-15T12:00:00.000Z',
    files: [
      {
        path: 'index.html',
        media_type: 'text/html',
        size_bytes: BYTES.byteLength,
        sha256: DIGEST,
      },
    ],
  };
  return {
    manifest,
    signature: {
      algorithm: 'Ed25519' as const,
      key_id: 'publication-key-01',
      value_base64: sign(null, Buffer.from(canonicalize(manifest)), privateKey).toString('base64'),
    },
    files: [{ path: 'index.html', mediaType: 'text/html', bytes: BYTES }],
  } satisfies SignedPublicationBundle;
}

function authorityRow() {
  return {
    publication_id: REQUEST.publicationId,
    publication_action_id: 'publication-action-01',
    acceptance_action_id: 'acceptance-action-01',
    controlled_revision_id: REQUEST.controlledRevisionId,
    controlled_content_version_id: 'content-version-01',
    compiled_view_id: REQUEST.compiledViewId,
    compiled_view_digest: DIGEST,
    compiled_view_media_type: 'text/html',
    publication_target_id: 'publication-target-01',
    publication_target_policy_digest: 'a'.repeat(64),
    document_classification: 'public',
    effective_classification: 'public',
    lifecycle_state: 'effective',
    published_at: new Date('2026-08-15T12:00:00.000Z'),
  };
}

function pool(queries: { text: string; values: readonly unknown[] }[]): Pool {
  const client = {
    async query(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });
      return {
        rows: text.includes('from content.document_publication publication')
          ? [authorityRow()]
          : [],
      };
    },
    release: vi.fn(),
  };
  return { connect: vi.fn(async () => client) } as unknown as Pool;
}

describe('configured approved-public projection loader', () => {
  it('binds public-only RLS and feeds the exact stored candidate to the verifier', async () => {
    const signer = generateKeyPairSync('ed25519');
    const bundle = signedBundle(signer.privateKey);
    const load = vi.fn(async () => ({
      organizationId: ORGANIZATION_ID,
      encodedSizeBytes: 1_024,
      candidate: bundle,
    }));
    const queries: { text: string; values: readonly unknown[] }[] = [];
    const loader = createApprovedPublicProjectionLoader({
      pool: pool(queries),
      bundleStore: { load } satisfies PublicationBundleStore,
      trustedSigningKeys: new Map([['publication-key-01', signer.publicKey]]),
      maxStoredBundleBytes: 2_048,
    });

    await expect(loader(REQUEST)).resolves.toEqual(bundle);
    expect(load).toHaveBeenCalledWith(REQUEST, 2_048);
    expect(queries).toContainEqual({
      text: 'select core.set_access_context($1, $2)',
      values: [ORGANIZATION_ID, 'public'],
    });
    expect(queries.map((query) => query.text)).toEqual([
      'begin',
      'select core.set_access_context($1, $2)',
      expect.stringContaining('from content.document_publication publication'),
      'commit',
    ]);
  });

  it('returns not found without opening a database transaction', async () => {
    const signer = generateKeyPairSync('ed25519');
    const configuredPool = pool([]);
    const loader = createApprovedPublicProjectionLoader({
      pool: configuredPool,
      bundleStore: { load: vi.fn(async () => undefined) },
      trustedSigningKeys: new Map([['publication-key-01', signer.publicKey]]),
    });

    await expect(loader(REQUEST)).resolves.toBeUndefined();
    expect(configuredPool.connect).not.toHaveBeenCalled();
  });

  it('refuses oversized store results before database authorization', async () => {
    const signer = generateKeyPairSync('ed25519');
    const configuredPool = pool([]);
    const loader = createApprovedPublicProjectionLoader({
      pool: configuredPool,
      bundleStore: {
        load: vi.fn(async () => ({
          organizationId: ORGANIZATION_ID,
          encodedSizeBytes: 2_049,
          candidate: signedBundle(signer.privateKey),
        })),
      },
      trustedSigningKeys: new Map([['publication-key-01', signer.publicKey]]),
      maxStoredBundleBytes: 2_048,
    });

    await expect(loader(REQUEST)).rejects.toThrow(/byte ceiling/);
    expect(configuredPool.connect).not.toHaveBeenCalled();
  });

  it('refuses missing or non-public trust configuration at composition time', () => {
    const signer = generateKeyPairSync('ed25519');
    const bundleStore = { load: vi.fn(async () => undefined) };
    expect(() =>
      createApprovedPublicProjectionLoader({
        pool: pool([]),
        bundleStore,
        trustedSigningKeys: new Map(),
      }),
    ).toThrow(/at least one trusted/);
    expect(() =>
      createApprovedPublicProjectionLoader({
        pool: pool([]),
        bundleStore,
        trustedSigningKeys: new Map([['publication-key-01', signer.privateKey]]),
      }),
    ).toThrow(/public Ed25519/);
  });
});
