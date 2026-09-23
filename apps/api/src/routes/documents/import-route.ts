import type { FastifyInstance } from 'fastify';
import { ActionRejected } from '@kf/actions';
import { ArtifactRejected, verifyUpload } from '@kf/artifacts';
import { DocumentParseRefused, preparseDocument, withPreparsedDocuments } from '@kf/documents';
import { deniedPathRule, formatContentRefusal, scanContent } from '../../ingest/content-policy.js';
import { unidentified } from '../actions.js';
import { documentParseRefusalBody } from '../actions/errors.js';
import {
  DOCUMENT_IMPORT_BODY_LIMIT_BYTES,
  ImportIdempotencyConflict,
  SourceHolderConflict,
  type DocumentActionContext,
  type DocumentImportBody,
  type DocumentRoutesOptions,
} from './contracts.js';
import { preflightDocumentImport } from './import-preflight.js';
import { persistDocumentImport } from './import-transaction.js';
import { parseDocumentImport } from './validation.js';

export function registerDocumentImportRoute(
  app: FastifyInstance,
  options: DocumentRoutesOptions,
): void {
  app.post<{ Body: DocumentImportBody }>(
    '/documents',
    { bodyLimit: DOCUMENT_IMPORT_BODY_LIMIT_BYTES },
    async (request, reply) => {
      let identity;
      try {
        identity = await options.identify({
          headers: request.headers as Record<string, unknown>,
        });
      } catch (error: unknown) {
        return reply.code(401).send(unidentified(error));
      }
      if (options.store === undefined) {
        return reply.code(503).send({
          error: 'artifact_store_unconfigured',
          message: 'Document import is unavailable because no artifact store is configured.',
        });
      }

      try {
        const source = parseDocumentImport(request.body ?? {}, identity.organizationId);
        // The same content policy as ingest: an import is bytes entering KF by another door.
        const refused =
          deniedPathRule(source.fileName) ?? scanContent(source.fileName, source.bytes);
        if (refused !== undefined) {
          return reply.code(422).send({
            error: 'content_refused',
            message: formatContentRefusal(refused),
            detail: {
              rule: refused.ruleId,
              ...(refused.line === undefined ? {} : { line: refused.line }),
              ...(refused.part === undefined ? {} : { part: refused.part }),
            },
          });
        }
        const common: DocumentActionContext = {
          actorId: identity.actorId,
          actingRoleId: identity.actingRoleId,
          organizationId: identity.organizationId,
          maxClassification: identity.maxClassification,
          targetIds: [],
          requestId: String(request.id),
        };
        await preflightDocumentImport(options, identity, source, common);
        // Parsed with no transaction open, before the bytes are stored; see ingest-route.ts.
        const preparsed =
          options.documentParser === undefined
            ? undefined
            : await preparseDocument(options.documentParser, source.bytes, source.mediaType);
        await options.store.putIfAbsent(source.storageKey, source.bytes, source.mediaType);
        await verifyUpload(options.store, {
          key: source.storageKey,
          claimedSha256: source.sha256,
          claimedSizeBytes: source.bytes.length,
        });
        const imported = await withPreparsedDocuments(preparsed && [preparsed], () =>
          persistDocumentImport(options, identity, source, common),
        );
        return reply.code(imported.statusCode).send(imported.body);
      } catch (error: unknown) {
        if (error instanceof SourceHolderConflict) {
          return reply.code(409).send({ error: 'source_holder_conflict', message: error.message });
        }
        if (error instanceof ImportIdempotencyConflict) {
          return reply.code(409).send({ error: 'idempotency_conflict', message: error.message });
        }
        if (error instanceof ArtifactRejected) {
          const occupiedKeyConflict =
            error.failure === 'digest_mismatch' ||
            error.failure === 'size_mismatch' ||
            error.failure === 'empty_object';
          return reply.code(occupiedKeyConflict ? 409 : 503).send({
            error: occupiedKeyConflict ? 'artifact_conflict' : 'artifact_store_rejected',
            failure: error.failure,
            message: error.message,
          });
        }
        if (error instanceof TypeError) {
          return reply.code(400).send({ error: 'invalid_document', message: error.message });
        }
        if (error instanceof DocumentParseRefused) {
          return reply.code(422).send(documentParseRefusalBody(error));
        }
        if (error instanceof ActionRejected) {
          return reply.code(error.failure === 'idempotency_conflict' ? 409 : 422).send({
            error: error.failure,
            message: error.message,
            detail: error.detail,
          });
        }
        if (
          typeof error === 'object' &&
          error !== null &&
          (error as { code?: unknown; constraint?: unknown }).code === '23505' &&
          (error as { constraint?: unknown }).constraint ===
            'controlled_document_document_number_revision_key'
        ) {
          return reply.code(409).send({
            error: 'duplicate_document',
            message: 'That document number and revision already exist.',
          });
        }
        request.log.error({ err: error }, 'document import failed');
        return reply.code(500).send({ error: 'internal_error', requestId: request.id });
      }
    },
  );
}
