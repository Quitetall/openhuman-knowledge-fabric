import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { digestOf } from '@kf/artifacts';
import type { Pool } from '@kf/database';
import { registerDocumentRoutes } from './documents.js';
import type { ApprovedPublicProjection, DocumentRoutesOptions } from './documents/contracts.js';

const request = {
  publicationId: 'publication-1',
  controlledRevisionId: 'document-1',
  compiledViewId: 'view-1',
};
const bytes = Buffer.from('<h1>Approved public view</h1>');

function options(
  loader?: DocumentRoutesOptions['loadApprovedPublicProjection'],
): DocumentRoutesOptions {
  return {
    pool: {} as Pool,
    identify: vi.fn(),
    store: undefined,
    preflightInTransaction: vi.fn(async () => undefined),
    executeInTransaction: vi.fn(),
    ...(loader === undefined ? {} : { loadApprovedPublicProjection: loader }),
  };
}

function bundle(): ApprovedPublicProjection {
  return {
    manifest: {
      format_version: 'kf-publication-v1',
      publication_id: request.publicationId,
      publication_action_id: 'publication-action-1',
      acceptance_action_id: 'acceptance-action-1',
      controlled_revision_id: request.controlledRevisionId,
      controlled_content_version_id: 'controlled-content-version-1',
      compiled_view_id: request.compiledViewId,
      compiled_view_digest: digestOf(bytes),
      compiled_view_media_type: 'text/html',
      publication_target_id: 'publication-target-1',
      publication_target_policy_digest: 'a'.repeat(64),
      classification: 'public' as const,
      lifecycle_state: 'effective' as const,
      published_at: '2026-08-15T12:00:00.000Z',
      files: [
        {
          path: 'index.html',
          media_type: 'text/html',
          size_bytes: bytes.byteLength,
          sha256: digestOf(bytes),
        },
      ],
    },
    signature: {
      algorithm: 'Ed25519' as const,
      key_id: 'publication-key-1',
      value_base64: Buffer.alloc(64, 1).toString('base64'),
    },
    files: [{ path: 'index.html', mediaType: 'text/html', bytes }],
  };
}

describe('approved public publication projection route', () => {
  it('serves only the already-authorized signed bundle returned by the verifier seam', async () => {
    const load = vi.fn(async () => bundle());
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(app, options(load));

    const response = await app.inject({
      method: 'GET',
      url: '/publications/publication-1/revisions/document-1/views/view-1',
    });

    expect(response.statusCode).toBe(200);
    expect(load).toHaveBeenCalledWith(request);
    expect(response.headers['content-type']).toContain(
      'application/vnd.openhuman.kf-publication+json',
    );
    expect(response.json()).toMatchObject({
      manifest: { classification: 'public', lifecycle_state: 'effective' },
      signature: { algorithm: 'Ed25519', key_id: 'publication-key-1' },
      files: [{ path: 'index.html', bytesBase64: bytes.toString('base64') }],
    });
  });

  it('refuses a verifier result whose exact requested receipt identity drifts', async () => {
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(
      app,
      options(async () => ({
        ...bundle(),
        manifest: { ...bundle().manifest, compiled_view_id: 'another-view' },
      })),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/publications/publication-1/revisions/document-1/views/view-1',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'public_projection_unavailable' });
  });

  it('refuses a verifier result with a malformed signed-bundle receipt', async () => {
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(
      app,
      options(async () => ({
        ...bundle(),
        signature: { ...bundle().signature, value_base64: 'not-a-signature' },
      })),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/publications/publication-1/revisions/document-1/views/view-1',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'public_projection_unavailable' });
  });

  it('fails closed when no approved-public verifier/storage adapter is composed', async () => {
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(app, options());

    const response = await app.inject({
      method: 'GET',
      url: '/publications/publication-1/revisions/document-1/views/view-1',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'public_projection_unconfigured' });
  });
});
