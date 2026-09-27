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
 * One file per request, inline as base64, up to the size its bytes can be downloaded back at
 * (`INGEST_MAX_SOURCE_BYTES`).
 * The classification is the record's own and is refused above the session's ceiling by the
 * insert policy, exactly as everywhere else.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ActionRejected } from '@kf/actions';
import { ArtifactRejected, verifyUpload } from '@kf/artifacts';
import { digestBytes } from '@kf/canonicalization';
import { withTransaction } from '@kf/database';
import {
  DocumentParseRefused,
  evidenceStorageKey,
  preparseDocument,
  withPreparsedDocuments,
} from '@kf/documents';
import { OBJECT_TITLE_MAX_CHARACTERS, objectTitleProblem } from '@kf/record-atoms';
import { deniedPathRule, formatContentRefusal, scanContent } from '../../ingest/content-policy.js';
import { refuseUnidentified } from '../actions.js';
import { documentParseRefusalBody } from '../actions/errors.js';
import {
  INGEST_BODY_LIMIT_BYTES,
  INGEST_MAX_SOURCE_BYTES,
  type DocumentRoutesOptions,
} from './contracts.js';

export interface IngestBody {
  readonly title?: unknown;
  readonly artifactKind?: unknown;
  readonly classification?: unknown;
  readonly mediaType?: unknown;
  readonly contentBase64?: unknown;
  readonly revisionLabel?: unknown;
  readonly reason?: unknown;
  readonly idempotencyKey?: unknown;
  /** The artifact this file was made from (a text extraction, a rendition); see attach_evidence. */
  readonly derivedFrom?: unknown;
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
  readonly derivedFrom?: string;
}

const CLASSIFICATION_RANK: Readonly<Record<string, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

/** Unknown names rank above everything, so an unrecognised label never passes a ceiling. */
function classificationRank(value: string): number {
  return CLASSIFICATION_RANK[value] ?? Number.POSITIVE_INFINITY;
}

function text(value: unknown, field: string, max = 512): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new TypeError(`${field} must be a non-empty string of at most ${String(max)} characters`);
  }
  // PostgreSQL text cannot hold NUL; refused here rather than failing the insert with a 500.
  if (value.includes('\u0000')) throw new TypeError(`${field} must not contain NUL characters`);
  return value.trim();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new TypeError(`${field} must be the uuid of an artifact`);
  }
  return value.toLowerCase();
}

export function parseIngest(body: IngestBody): ParsedIngest {
  // The record's own limit (core.object: 1 to 240 characters), refused before a byte is stored.
  // Not truncated: a title is how people find and cite the record, so a shortened one is a name
  // nobody chose. The caller shortens it knowing what it is (the fixture loaders do).
  const title = text(body.title, 'title', OBJECT_TITLE_MAX_CHARACTERS * 2);
  const titleProblem = objectTitleProblem(title);
  if (titleProblem !== undefined) throw new TypeError(titleProblem);
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
  if (bytes.length > INGEST_MAX_SOURCE_BYTES) {
    throw new TypeError(
      `the file is ${String(bytes.length)} bytes; ingest takes at most ${String(INGEST_MAX_SOURCE_BYTES)}, the size a source can be downloaded back at`,
    );
  }
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
    ...(body.derivedFrom === undefined
      ? {}
      : { derivedFrom: uuid(body.derivedFrom, 'derivedFrom') }),
  };
  return out;
}

export function registerIngestRoute(app: FastifyInstance, options: DocumentRoutesOptions): void {
  app.post<{ Body: IngestBody }>(
    '/ingest',
    { bodyLimit: INGEST_BODY_LIMIT_BYTES },
    async (request, reply) => {
      let identity;
      try {
        identity = await options.identify({ headers: request.headers as Record<string, unknown> });
      } catch (error: unknown) {
        return refuseUnidentified(reply, error);
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
        // What never enters KF (credentials, bank details, tax identifiers), refused before the
        // bytes go anywhere. The CLI checks too; this is the check that cannot be skipped.
        const refused = deniedPathRule(source.title) ?? scanContent(source.title, source.bytes);
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
        // Everything that can refuse this request without the bytes being stored runs BEFORE
        // the put. The object store is outside the transaction and immutable: bytes written
        // for a request that is then refused stay there, unreferenced, until the sweep finds
        // them. So the classification ceiling and the act's authority are rehearsed first.
        // Passing is not authority — the dispatcher below repeats every check.
        if (
          classificationRank(source.classification) > classificationRank(identity.maxClassification)
        ) {
          return reply.code(403).send({
            error: 'classification_not_granted',
            message: 'the classification is above what this session may create',
          });
        }
        await withTransaction(options.pool, (tx) =>
          options.preflightInTransaction(
            tx,
            {
              actionType: 'attach_evidence',
              actorId: identity.actorId,
              actingRoleId: identity.actingRoleId,
              organizationId: identity.organizationId,
              maxClassification: identity.maxClassification,
              attestation: identity.attestation,
              targetIds: [],
              idempotencyKey: 'kf-ingest-http-preflight',
              requestId: String(request.id),
              ...(source.reason === undefined ? {} : { reason: source.reason }),
            },
            [
              {
                id: randomUUID(),
                object_type: 'artifact',
                lifecycle_state: 'draft',
                row_version: '0',
                organization_id: identity.organizationId,
                created_by: identity.actorId,
              },
            ],
          ),
        );
        // Parsed now, with no transaction open and before a byte is stored: a source pandoc
        // refuses is refused here, and the act's transaction below only checks that this parse
        // is bound to the exact bytes it verifies. In-process only; the payload cannot carry it.
        const preparsed =
          options.documentParser === undefined
            ? undefined
            : await preparseDocument(options.documentParser, source.bytes, source.mediaType);
        // Content-addressed under the organization, as the CLI keys it: the same bytes ingested
        // twice occupy one object, and a different file can never overwrite them.
        const storageKey = evidenceStorageKey('ingest', identity.organizationId, source.sha256);
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
          ...(source.derivedFrom === undefined ? {} : { derived_from: source.derivedFrom }),
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
        const result = await withPreparsedDocuments(preparsed && [preparsed], () =>
          withTransaction(options.pool, (tx) =>
            options.executeInTransaction(tx, {
              actionType: 'attach_evidence',
              actorId: identity.actorId,
              actingRoleId: identity.actingRoleId,
              organizationId: identity.organizationId,
              maxClassification: identity.maxClassification,
              attestation: identity.attestation,
              targetIds: [],
              payload,
              idempotencyKey,
              requestId: String(request.id),
              ...(source.reason === undefined ? {} : { reason: source.reason }),
            }),
          ),
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
