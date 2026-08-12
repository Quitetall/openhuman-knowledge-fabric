/** Human-facing document routes composed from artifact, parser, action, and projection atoms. */

import type { FastifyInstance } from 'fastify';
import { ActionRejected, type ActionRequest, type ActionResult } from '@kf/actions';
import { digestOf, type ObjectStore } from '@kf/artifacts';
import { setAccessContext, withTransaction, type Pool } from '@kf/database';
import {
  artifactKindForDocumentClass,
  getDocument,
  listDocuments,
  mediaTypeForDocumentFile,
} from '@kf/documents';
import { unidentified, type IdentifyCaller } from './actions.js';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
interface DocumentImportBody {
  readonly title?: unknown;
  readonly documentNumber?: unknown;
  readonly revision?: unknown;
  readonly documentClass?: unknown;
  readonly owningRole?: unknown;
  readonly fileName?: unknown;
  readonly mediaType?: unknown;
  readonly contentBase64?: unknown;
  readonly idempotencyKey?: unknown;
}

function required(body: DocumentImportBody, key: keyof DocumentImportBody): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${String(key)} is required`);
  }
  return value;
}

function decodeBase64(value: string): Buffer {
  if (value.length > Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4) {
    throw new TypeError('document exceeds 10 MiB limit');
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError('contentBase64 is not valid base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0) throw new TypeError('document source is empty');
  if (bytes.length > MAX_UPLOAD_BYTES) throw new TypeError('document exceeds 10 MiB limit');
  return bytes;
}

export interface DocumentRoutesOptions {
  readonly pool: Pool;
  readonly identify: IdentifyCaller;
  readonly store: ObjectStore | undefined;
  readonly execute: (request: ActionRequest) => Promise<ActionResult>;
}

export async function registerDocumentRoutes(
  app: FastifyInstance,
  options: DocumentRoutesOptions,
): Promise<void> {
  async function caller(request: { headers: Record<string, unknown> }) {
    return options.identify(request);
  }

  app.get('/documents', async (request, reply) => {
    let identity;
    try {
      identity = await caller({ headers: request.headers as Record<string, unknown> });
    } catch (error: unknown) {
      return reply.code(401).send(unidentified(error));
    }
    return withTransaction(options.pool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: identity.organizationId,
        maxClassification: identity.maxClassification,
      });
      return { documents: await listDocuments(tx) };
    });
  });

  app.get<{ Params: { id: string } }>('/documents/:id', async (request, reply) => {
    let identity;
    try {
      identity = await caller({ headers: request.headers as Record<string, unknown> });
    } catch (error: unknown) {
      return reply.code(401).send(unidentified(error));
    }
    return withTransaction(options.pool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: identity.organizationId,
        maxClassification: identity.maxClassification,
      });
      const document = await getDocument(tx, request.params.id);
      return document === undefined
        ? reply.code(404).send({ error: 'not_found' })
        : reply.send(document);
    });
  });

  app.post<{ Body: DocumentImportBody }>('/documents', async (request, reply) => {
    let identity;
    try {
      identity = await caller({ headers: request.headers as Record<string, unknown> });
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
      const body = request.body ?? {};
      const title = required(body, 'title');
      const documentNumber = required(body, 'documentNumber');
      const revision = required(body, 'revision');
      const documentClass = required(body, 'documentClass');
      const owningRole = required(body, 'owningRole');
      const fileName = required(body, 'fileName');
      const declaredMediaType = required(body, 'mediaType');
      const mediaType = mediaTypeForDocumentFile(fileName, declaredMediaType);
      const idempotencyKey = required(body, 'idempotencyKey');
      if (idempotencyKey.length < 8 || idempotencyKey.length > 96) {
        throw new TypeError('idempotencyKey must contain 8 to 96 characters');
      }
      if (mediaType === undefined) {
        throw new TypeError(
          `file ${JSON.stringify(fileName)} with media type ${JSON.stringify(declaredMediaType)} is not parseable`,
        );
      }
      const bytes = decodeBase64(required(body, 'contentBase64'));
      const sha256 = digestOf(bytes);
      const key = `document-imports/${sha256}`;
      await options.store.put(key, bytes, mediaType);

      const common = {
        actorId: identity.actorId,
        actingRoleId: identity.actingRoleId,
        organizationId: identity.organizationId,
        maxClassification: identity.maxClassification,
        targetIds: [],
        requestId: String(request.id),
      } as const;
      const artifact = await options.execute({
        ...common,
        actionType: 'attach_evidence',
        idempotencyKey: `${idempotencyKey}-artifact`,
        payload: {
          title: fileName,
          artifact_kind: artifactKindForDocumentClass(documentClass),
          sha256,
          size_bytes: bytes.length,
          media_type: mediaType,
          storage_uri: key,
          revision_label: revision,
        },
      });
      const artifactId = artifact.objectIds[0];
      if (artifactId === undefined) throw new Error('attach_evidence returned no artifact id');
      const version = await withTransaction(options.pool, async (tx) => {
        await setAccessContext(tx, {
          organizationId: identity.organizationId,
          maxClassification: identity.maxClassification,
        });
        return tx.one<{ id: string }>(
          `select id from content.artifact_version
            where artifact_id = $1 order by version_no desc limit 1`,
          [artifactId],
        );
      });
      const document = await options.execute({
        ...common,
        actionType: 'add_controlled_document',
        idempotencyKey: `${idempotencyKey}-document`,
        payload: {
          title,
          document_number: documentNumber,
          revision,
          document_class: documentClass,
          owning_role: owningRole,
          content_version: version.id,
        },
      });
      const documentId = document.objectIds[0];
      if (documentId === undefined) throw new Error('add_controlled_document returned no id');
      return reply.code(document.replayed ? 200 : 201).send({
        id: documentId,
        artifactId,
        sha256,
        replayed: artifact.replayed && document.replayed,
      });
    } catch (error: unknown) {
      if (error instanceof TypeError) {
        return reply.code(400).send({ error: 'invalid_document', message: error.message });
      }
      if (error instanceof ActionRejected) {
        return reply.code(422).send({
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
  });
}
