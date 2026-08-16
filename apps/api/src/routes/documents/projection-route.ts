import type { FastifyInstance } from 'fastify';
import { setAccessContext, withTransaction } from '@kf/database';
import { unidentified } from '../actions.js';
import {
  DEFAULT_DOCUMENT_PROJECTION_DOWNLOAD_MAX_BYTES,
  type DocumentRoutesOptions,
} from './contracts.js';
import { documentProjectionBytes } from './projection-bytes.js';
import { DocumentBytesUnavailable, readVerifiedDocumentBytes } from './source-bytes.js';
import { resolveWorkspaceTarget } from './workspace-repository.js';

const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

function extensionFor(mediaType: string): string {
  return (
    {
      'text/plain': '.txt',
      'text/markdown': '.md',
      'text/html': '.html',
      'application/pdf': '.pdf',
      'application/json': '.json',
      'application/epub+zip': '.epub',
    }[mediaType] ?? '.bin'
  );
}

export function registerDocumentProjectionRoute(
  app: FastifyInstance,
  options: DocumentRoutesOptions,
): void {
  app.get<{ Params: { id: string; viewId: string } }>(
    '/documents/:id/projections/:viewId',
    async (request, reply) => {
      let identity;
      try {
        identity = await options.identify({ headers: request.headers as Record<string, unknown> });
      } catch (error: unknown) {
        return reply.code(401).send(unidentified(error));
      }
      if (options.store === undefined) {
        return reply.code(503).send({ error: 'artifact_store_unconfigured' });
      }
      const maxBytes =
        options.maxProjectionDownloadBytes ?? DEFAULT_DOCUMENT_PROJECTION_DOWNLOAD_MAX_BYTES;
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        request.log.error('invalid document projection download ceiling');
        return reply.code(503).send({ error: 'immutable_projection_unavailable' });
      }
      let projection;
      try {
        projection = await withTransaction(options.pool, async (tx) => {
          await setAccessContext(tx, {
            organizationId: identity.organizationId,
            maxClassification: identity.maxClassification,
          });
          const workspace = await resolveWorkspaceTarget(tx, request.params.id);
          if (workspace.status !== 'ready') return undefined;
          return documentProjectionBytes(
            tx,
            workspace.row.basis_id,
            request.params.viewId,
            maxBytes,
          );
        });
      } catch (error: unknown) {
        if (error instanceof DocumentBytesUnavailable && error.failure === 'too_large') {
          return reply.code(413).send({ error: 'projection_download_limit_exceeded' });
        }
        request.log.error({ err: error }, 'document projection metadata failed verification');
        return reply.code(409).send({ error: 'immutable_projection_unavailable' });
      }
      if (projection === undefined) return reply.code(404).send({ error: 'not_found' });
      let bytes: Buffer;
      try {
        bytes = await readVerifiedDocumentBytes(options.store, projection);
      } catch (error: unknown) {
        if (error instanceof DocumentBytesUnavailable) {
          return reply.code(409).send({ error: 'projection_digest_mismatch' });
        }
        request.log.error({ err: error }, 'immutable document projection read failed');
        return reply.code(503).send({ error: 'immutable_projection_unavailable' });
      }
      const mediaType = MEDIA_TYPE.test(projection.mediaType)
        ? projection.mediaType
        : 'application/octet-stream';
      const stem = `${request.params.id}-${projection.target}`.replace(/[^A-Za-z0-9._-]/g, '_');
      const fileName = `${stem}${extensionFor(mediaType)}`;
      return reply
        .header('cache-control', 'private, no-store')
        .header(
          'content-disposition',
          `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        )
        .header('etag', `"sha256:${projection.sha256}"`)
        .header('x-content-type-options', 'nosniff')
        .type(mediaType)
        .send(bytes);
    },
  );
}
