/**
 * `POST /ingest` — a file becomes a record, over HTTP, as the person sending it.
 *
 * `kf ingest` did this with a database owner credential in hand, which no engineer's laptop
 * has and no agent should. Everything the CLI did is a request a session can make: the bytes
 * go to the object store under a content-addressed key, the upload is verified, and
 * `attach_evidence` is dispatched with the same payload the CLI built — so the record, the
 * act and the audit entry are indistinguishable from a CLI ingest. Nothing here reaches past
 * the dispatcher.
 *
 * One file per request, inline as base64, up to the same limit the document import allows.
 * The classification is the record's own and is refused above the session's ceiling by the
 * insert policy, exactly as everywhere else.
 */

import type { FastifyInstance } from 'fastify';
import { ActionRejected } from '@kf/actions';
import { ArtifactRejected, verifyUpload } from '@kf/artifacts';
import { digestBytes } from '@kf/canonicalization';
import { withTransaction } from '@kf/database';
import { unidentified } from '../actions.js';
import { DOCUMENT_IMPORT_BODY_LIMIT_BYTES, type DocumentRoutesOptions } from './contracts.js';

export interface IngestBody {
  readonly title?: unknown;
  readonly artifactKind?: unknown;
  readonly classification?: unknown;
  readonly mediaType?: unknown;
  readonly contentBase64?: unknown;
  readonly revisionLabel?: unknown;
  readonly reason?: unknown;
  readonly idempotencyKey?: unknown;
}

const ARTIFACT_KINDS = new Set([
  'document',
  'cad',
  'drawing',
  'bom',
  'source_code',
  'binary',
  'dataset',
  'model',
  'test_evidence',
  'message_snapshot',
  'invoice_evidence',
  'payment_evidence',
  'other',
]);

interface ParsedIngest {
  readonly title: string;
  readonly artifactKind: string;
  readonly classification: string;
  readonly mediaType: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly revisionLabel?: string;
  readonly reason?: string;
  readonly idempotencyKey?: string;
}

function text(value: unknown, field: string, max = 512): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new TypeError(`${field} must be a non-empty string of at most ${String(max)} characters`);
  }
  return value.trim();
}

export function parseIngest(body: IngestBody): ParsedIngest {
  const title = text(body.title, 'title');
  const artifactKind = text(body.artifactKind, 'artifactKind', 64);
  if (!ARTIFACT_KINDS.has(artifactKind)) {
    throw new TypeError(`artifactKind must be one of ${[...ARTIFACT_KINDS].join(', ')}`);
  }
  const classification = text(body.classification, 'classification', 32);
  const mediaType = text(body.mediaType, 'mediaType', 255);
  if (typeof body.contentBase64 !== 'string' || body.contentBase64 === '') {
    throw new TypeError('contentBase64 must be the file, base64-encoded');
  }
  const bytes = Buffer.from(body.contentBase64, 'base64');
  if (bytes.length === 0) throw new TypeError('contentBase64 decodes to nothing');
  if (bytes.toString('base64').replace(/=+$/, '') !== body.contentBase64.replace(/=+$/, '')) {
    throw new TypeError('contentBase64 is not valid base64');
  }
  const out: ParsedIngest = {
    title,
    artifactKind,
    classification,
    mediaType,
    bytes,
    sha256: digestBytes(bytes),
    ...(body.revisionLabel === undefined
      ? {}
      : { revisionLabel: text(body.revisionLabel, 'revisionLabel', 128) }),
    ...(body.reason === undefined ? {} : { reason: text(body.reason, 'reason', 2000) }),
    ...(body.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: text(body.idempotencyKey, 'idempotencyKey', 200) }),
  };
  return out;
}

export function registerIngestRoute(app: FastifyInstance, options: DocumentRoutesOptions): void {
  app.post<{ Body: IngestBody }>(
    '/ingest',
    { bodyLimit: DOCUMENT_IMPORT_BODY_LIMIT_BYTES },
    async (request, reply) => {
      let identity;
      try {
        identity = await options.identify({ headers: request.headers as Record<string, unknown> });
      } catch (error: unknown) {
        return reply.code(401).send(unidentified(error));
      }
      if (options.store === undefined) {
        return reply.code(503).send({
          error: 'artifact_store_unconfigured',
          message: 'Ingest is unavailable because no artifact store is configured.',
        });
      }
      const store = options.store;
      try {
        const source = parseIngest(request.body ?? {});
        // Content-addressed under the organization, as the CLI keys it: the same bytes ingested
        // twice occupy one object, and a different file can never overwrite them.
        const storageKey = `ingest/${identity.organizationId}/${source.sha256}`;
        const uploaded = await store.putIfAbsent(storageKey, source.bytes, source.mediaType);
        await verifyUpload(store, {
          key: storageKey,
          claimedSha256: source.sha256,
          claimedSizeBytes: source.bytes.length,
        });
        if (uploaded.versionId === undefined) {
          return reply.code(503).send({
            error: 'artifact_store_rejected',
            message: 'the object store returned no immutable version for the upload',
          });
        }
        const payload = {
          classification: source.classification,
          title: source.title,
          artifact_kind: source.artifactKind,
          sha256: source.sha256,
          size_bytes: source.bytes.length,
          media_type: source.mediaType,
          storage_uri: storageKey,
          ...(source.revisionLabel === undefined ? {} : { revision_label: source.revisionLabel }),
        };
        const idempotencyKey =
          source.idempotencyKey ??
          `kf-ingest-http-v1-${digestBytes(
            Buffer.from(
              JSON.stringify([
                identity.organizationId,
                identity.actorId,
                source.sha256,
                source.title,
              ]),
            ),
          )}`;
        const result = await withTransaction(options.pool, (tx) =>
          options.executeInTransaction(tx, {
            actionType: 'attach_evidence',
            actorId: identity.actorId,
            actingRoleId: identity.actingRoleId,
            organizationId: identity.organizationId,
            maxClassification: identity.maxClassification,
            targetIds: [],
            payload,
            idempotencyKey,
            requestId: String(request.id),
            ...(source.reason === undefined ? {} : { reason: source.reason }),
          }),
        );
        const artifactId = result.objectIds[0];
        return reply.code(result.replayed ? 200 : 201).send({
          artifactId,
          actionId: result.actionId,
          auditDigest: result.auditDigest,
          sha256: source.sha256,
          sizeBytes: source.bytes.length,
          classification: source.classification,
          replayed: result.replayed,
        });
      } catch (error: unknown) {
        if (error instanceof TypeError) {
          return reply.code(400).send({ error: 'invalid_ingest', message: error.message });
        }
        if (error instanceof ArtifactRejected) {
          const conflict =
            error.failure === 'digest_mismatch' ||
            error.failure === 'size_mismatch' ||
            error.failure === 'empty_object';
          return reply.code(conflict ? 409 : 503).send({
            error: conflict ? 'artifact_conflict' : 'artifact_store_rejected',
            failure: error.failure,
            message: error.message,
          });
        }
        if (error instanceof ActionRejected) {
          return reply.code(error.failure === 'idempotency_conflict' ? 409 : 422).send({
            error: error.failure,
            message: error.message,
            detail: error.detail,
          });
        }
        // The insert policy refusing a classification above the session ceiling arrives as a
        // row-level security violation; it is the caller's mistake, not the server's.
        if (
          typeof error === 'object' &&
          error !== null &&
          (error as { code?: unknown }).code === '42501'
        ) {
          return reply.code(403).send({
            error: 'classification_not_granted',
            message: 'the classification is above what this session may create',
          });
        }
        request.log.error({ err: error }, 'ingest failed');
        return reply.code(500).send({ error: 'internal_error', requestId: request.id });
      }
    },
  );
}
