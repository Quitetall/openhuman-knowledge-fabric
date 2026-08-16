import type { FastifyInstance } from 'fastify';
import { setAccessContext, withTransaction } from '@kf/database';
import { unidentified } from '../actions.js';
import {
  DEFAULT_DOCUMENT_SOURCE_DOWNLOAD_MAX_BYTES,
  type DocumentRoutesOptions,
} from './contracts.js';
import {
  DocumentBytesUnavailable,
  documentSourceBytes,
  readVerifiedDocumentBytes,
} from './source-bytes.js';

const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

function downloadMediaType(mediaType: string): string {
  return MEDIA_TYPE.test(mediaType) ? mediaType : 'application/octet-stream';
}

function extensionFor(mediaType: string): string {
  return (
    {
      'text/plain': '.txt',
      'text/markdown': '.md',
      'text/html': '.html',
      'application/pdf': '.pdf',
      'application/json': '.json',
      'application/vnd.oasis.opendocument.text': '.odt',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    }[mediaType] ?? '.bin'
  );
}

export function registerDocumentSourceRoute(
  app: FastifyInstance,
  options: DocumentRoutesOptions,
): void {
  app.get<{ Params: { id: string } }>('/documents/:id/source', async (request, reply) => {
    let identity;
    try {
      identity = await options.identify({ headers: request.headers as Record<string, unknown> });
    } catch (error: unknown) {
      return reply.code(401).send(unidentified(error));
    }
    if (options.store === undefined) {
      return reply.code(503).send({ error: 'artifact_store_unconfigured' });
    }
    const maxBytes = options.maxSourceDownloadBytes ?? DEFAULT_DOCUMENT_SOURCE_DOWNLOAD_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      request.log.error('invalid document source download ceiling');
      return reply.code(503).send({ error: 'immutable_source_unavailable' });
    }
    let source;
    try {
      source = await withTransaction(options.pool, async (tx) => {
        await setAccessContext(tx, {
          organizationId: identity.organizationId,
          maxClassification: identity.maxClassification,
        });
        return documentSourceBytes(tx, request.params.id, maxBytes);
      });
    } catch (error: unknown) {
      if (error instanceof DocumentBytesUnavailable && error.failure === 'too_large') {
        return reply.code(413).send({ error: 'source_download_limit_exceeded' });
      }
      request.log.error({ err: error }, 'document source metadata failed verification');
      return reply.code(409).send({ error: 'immutable_source_unavailable' });
    }
    if (source === undefined) return reply.code(404).send({ error: 'not_found' });
    let bytes: Buffer;
    try {
      bytes = await readVerifiedDocumentBytes(options.store, source);
    } catch (error: unknown) {
      if (error instanceof DocumentBytesUnavailable) {
        return reply.code(409).send({
          error:
            error.failure === 'digest_mismatch'
              ? 'source_digest_mismatch'
              : 'immutable_source_unavailable',
        });
      }
      request.log.error({ err: error }, 'immutable document source read failed');
      return reply.code(503).send({ error: 'immutable_source_unavailable' });
    }
    const mediaType = downloadMediaType(source.mediaType);
    const fileName = `${source.documentNumber}-${source.revision}`.replace(/[^A-Za-z0-9._-]/g, '_');
    const fileNameWithExtension = `${fileName}${extensionFor(mediaType)}`;
    return reply
      .header('cache-control', 'private, no-store')
      .header(
        'content-disposition',
        `attachment; filename="${fileNameWithExtension}"; filename*=UTF-8''${encodeURIComponent(fileNameWithExtension)}`,
      )
      .header('etag', `"sha256:${source.sha256}"`)
      .header('x-content-type-options', 'nosniff')
      .type(mediaType)
      .send(bytes);
  });
}
