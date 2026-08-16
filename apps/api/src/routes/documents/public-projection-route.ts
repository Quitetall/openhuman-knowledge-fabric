import type { FastifyInstance } from 'fastify';
import { digestOf } from '@kf/artifacts';
import {
  DEFAULT_DOCUMENT_PROJECTION_DOWNLOAD_MAX_BYTES,
  type ApprovedPublicProjection,
  type DocumentRoutesOptions,
  type PublicProjectionRequest,
} from './contracts.js';

const SHA256 = /^[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function canonicalInstant(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function canonicalEd25519Signature(value: unknown): boolean {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !BASE64.test(value)) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.byteLength === 64 && bytes.toString('base64') === value;
}

function safePath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.startsWith('/') || value.includes('\\')) {
    return false;
  }
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function safeBundle(
  request: PublicProjectionRequest,
  bundle: ApprovedPublicProjection,
  maxBytes: number,
): boolean {
  const manifest = bundle.manifest;
  if (
    manifest.format_version !== 'kf-publication-v1' ||
    manifest.publication_id !== request.publicationId ||
    !nonEmpty(manifest.publication_action_id) ||
    !nonEmpty(manifest.acceptance_action_id) ||
    manifest.controlled_revision_id !== request.controlledRevisionId ||
    !nonEmpty(manifest.controlled_content_version_id) ||
    manifest.compiled_view_id !== request.compiledViewId ||
    !SHA256.test(manifest.compiled_view_digest) ||
    !nonEmpty(manifest.compiled_view_media_type) ||
    !nonEmpty(manifest.publication_target_id) ||
    !SHA256.test(manifest.publication_target_policy_digest) ||
    manifest.classification !== 'public' ||
    manifest.lifecycle_state !== 'effective' ||
    !canonicalInstant(manifest.published_at) ||
    bundle.signature.algorithm !== 'Ed25519' ||
    !nonEmpty(bundle.signature.key_id) ||
    !canonicalEd25519Signature(bundle.signature.value_base64) ||
    manifest.files.length !== 1 ||
    bundle.files.length !== 1
  ) {
    return false;
  }
  const claim = manifest.files[0]!;
  const file = bundle.files[0]!;
  if (!(file.bytes instanceof Uint8Array)) return false;
  const bytes = Buffer.from(file.bytes);
  return (
    bytes.byteLength <= maxBytes &&
    safePath(claim.path) &&
    claim.path === file.path &&
    claim.media_type === manifest.compiled_view_media_type &&
    claim.media_type === file.mediaType &&
    claim.size_bytes === bytes.byteLength &&
    claim.sha256 === manifest.compiled_view_digest &&
    claim.sha256 === digestOf(bytes)
  );
}

export function registerPublicProjectionRoute(
  app: FastifyInstance,
  options: DocumentRoutesOptions,
): void {
  app.get<{
    Params: { publicationId: string; controlledRevisionId: string; compiledViewId: string };
  }>(
    '/publications/:publicationId/revisions/:controlledRevisionId/views/:compiledViewId',
    async (request, reply) => {
      if (options.loadApprovedPublicProjection === undefined) {
        return reply.code(503).send({ error: 'public_projection_unconfigured' });
      }
      const projectionRequest = {
        publicationId: request.params.publicationId,
        controlledRevisionId: request.params.controlledRevisionId,
        compiledViewId: request.params.compiledViewId,
      };
      const maxBytes =
        options.maxProjectionDownloadBytes ?? DEFAULT_DOCUMENT_PROJECTION_DOWNLOAD_MAX_BYTES;
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        return reply.code(503).send({ error: 'public_projection_unavailable' });
      }
      try {
        const bundle = await options.loadApprovedPublicProjection(projectionRequest);
        if (bundle === undefined) return reply.code(404).send({ error: 'not_found' });
        if (!safeBundle(projectionRequest, bundle, maxBytes)) {
          request.log.error('approved public projection failed HTTP boundary verification');
          return reply.code(409).send({ error: 'public_projection_unavailable' });
        }
        const body = Buffer.from(
          JSON.stringify({
            manifest: bundle.manifest,
            signature: bundle.signature,
            files: bundle.files.map((file) => ({
              path: file.path,
              mediaType: file.mediaType,
              bytesBase64: Buffer.from(file.bytes).toString('base64'),
            })),
          }),
        );
        return reply
          .header('cache-control', 'public, max-age=300, must-revalidate')
          .header('etag', `"sha256:${digestOf(body)}"`)
          .header('x-content-type-options', 'nosniff')
          .type('application/vnd.openhuman.kf-publication+json')
          .send(body);
      } catch (error: unknown) {
        request.log.error({ err: error }, 'approved public projection load failed');
        return reply.code(404).send({ error: 'not_found' });
      }
    },
  );
}
