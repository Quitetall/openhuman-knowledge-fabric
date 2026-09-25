/**
 * The context source LAMU's context compiler reads (`lamu-api/src/context_kf.rs`).
 *
 *   POST /context-source/retrieve {query, limit} → {references: [SourceRef]}
 *   POST /context-source/read     SourceRef       → kf.context-source-record/v1
 *
 * The same governed path as `fixtures/veracier/context-example.mjs`, done in the server: the
 * caller's semantic list from composed search, re-checked as search re-checks it (§64A), kept to the
 * members of their `agent_context` projection (§59, KF-SAS-RQ-115), and each record's text read under
 * their grants. A SourceRef's `revision` is the record's master-record member digest and its `digest`
 * the SHA-256 of the exact text `read` returns.
 *
 * CURRENT AUTHORITY ON EVERY CALL. Both routes identify the caller from the bearer token through
 * kf-attestor and bind the principal in every transaction, and decide from live rows, never from what
 * an earlier call returned. `read` answers:
 *
 *   200 — the record is in the caller's live permitted set at the same revision and text digest, and
 *         their latest master record still claims exactly that set (its corpus digest is recorded);
 *   409 KF-CTX-003 — the record is still readable but its revision or text moved;
 *   409 KF-CTX-004 / 005 — readable and unchanged, but the caller's master record is stale or absent,
 *         so there is no current agent_context to bind the disclosure to (compile it first);
 *   403 KF-CTX-002 — no longer readable, and one of the caller's own master records included it;
 *   404 KF-CTX-001 — anything else: absent, another organization's, above the ceiling, or never
 *         granted. One body, byte for byte, whatever the reason.
 *
 * 403 versus 404, and what each leaks: a 403 tells the caller the record exists and they may not read
 * it now. It is given only when a master record of theirs — which they can read, and which lists the
 * record's id and title — included it, so it confirms nothing KF had not already disclosed to them.
 * Everything else is 404 with an identical body, recorded without naming the record, so neither the
 * answer nor the log distinguishes a foreign record from one that never existed. The decision reads
 * only rows the caller's bound session can see; nothing about a record outside it is queried.
 *
 * DISCLOSURES AND REFUSALS ARE RECORDED (`search.context_disclosure`, a transient observation under
 * §64B) in the same transaction as the decision, and the answer is sent only after it commits. The
 * declared agent of a delegated token (ADR 0035) is written by the database from the attestation.
 * No text is kept: not cached, not logged, not recorded.
 *
 * LOCAL ONLY. The record says `localOnly: true`, so the routes answer only a direct loopback
 * connection carrying no forwarding header, as `/readiness` judges one. A reverse proxy in front of
 * them would make that label false and is not a supported deployment.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ObjectStore, StoreRegistry } from '@kf/artifacts';
import { AttestorUnavailable, reaches as grantReaches, readCoverage } from '@kf/authorization';
import { digestBytes } from '@kf/canonicalization';
import { bindPrincipal, PrincipalRefused, withTransaction, type Pool, type Tx } from '@kf/database';
import type { SemanticRetrieval } from '@kf/retrieval';
import { composeSearch, type SemanticRanker } from '@kf/search';
import type { Caller, IdentifyCaller } from './actions.js';
import { refuseUnidentified } from './actions.js';
import { degradedReadFrom, readVerifiedDocumentBytes } from './documents/source-bytes.js';
import {
  agentContextCorpus,
  CONTEXT_REFUSALS,
  CONTEXT_SOURCE_ADAPTER,
  CONTEXT_SOURCE_RECORD_SCHEMA,
  decodeText,
  describeText,
  MAX_CONTEXT_RESPONSE_BYTES,
  onceIncluded,
  recordContextDisclosure,
  referenceOf,
  referencesDigest,
  type ContextDisclosure,
  type ContextRefusal,
  type ContextSourceRecord,
  type SourceReference,
} from './context-source/record.js';

export interface ContextSourceRoutesOptions {
  readonly pool: Pool;
  readonly identify: IdentifyCaller;
  /** The working store the record text is read from. Absent: both routes answer 503. */
  readonly store: ObjectStore | undefined;
  /** Every store this instance can reach, for a degraded read from a verified copy (ADR 0017). */
  readonly stores?: StoreRegistry;
  /** The retrieval engine. Absent: `retrieve` refuses (KF-CTX-006); there is no lexical fallback. */
  readonly semantic?: Pick<SemanticRetrieval, 'rank'>;
}

const HEX64 = '^[0-9a-f]{64}$';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const LOOPBACK_PEERS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** A direct loopback connection: a forwarded request is judged as the remote caller it is. */
function directLoopback(request: FastifyRequest): boolean {
  const forwarded =
    request.headers['x-forwarded-for'] !== undefined ||
    request.headers['forwarded'] !== undefined ||
    request.headers['x-real-ip'] !== undefined;
  return !forwarded && LOOPBACK_PEERS.has(request.socket.remoteAddress ?? '');
}

type Outcome<T> = { readonly refused: ContextRefusal } | { readonly answer: T };

function refusalBody(refusal: ContextRefusal): { error: string; rule: string } {
  return { error: refusal, rule: CONTEXT_REFUSALS[refusal].rule };
}

export async function registerContextSourceRoutes(
  app: FastifyInstance,
  options: ContextSourceRoutesOptions,
): Promise<void> {
  /** Identify, then run `serve`; every failure that is not a decision is a 503 naming nothing. */
  async function handle(
    request: FastifyRequest,
    reply: FastifyReply,
    serve: (caller: Caller, store: ObjectStore) => Promise<FastifyReply>,
  ): Promise<FastifyReply> {
    if (!directLoopback(request)) {
      return reply.code(403).send({ error: 'local_transport_required' });
    }
    let caller: Caller;
    try {
      caller = await options.identify({ headers: request.headers as Record<string, unknown> });
    } catch (error: unknown) {
      return refuseUnidentified(reply, error);
    }
    if (options.store === undefined) {
      return reply.code(503).send({ error: 'artifact_store_unconfigured' });
    }
    try {
      return await serve(caller, options.store);
    } catch (error: unknown) {
      // Out of scope reads as absent, and an attestor outage as itself (app.ts's handler).
      if (error instanceof PrincipalRefused || error instanceof AttestorUnavailable) throw error;
      // The error, never the text: nothing here has a record's text in its message.
      request.log.error({ err: error }, 'context source failed');
      return reply.code(503).send({ error: 'source_unavailable' });
    }
  }

  /** A transaction bound as the caller, every time. */
  const bound = <T>(caller: Caller, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    withTransaction(options.pool, async (tx) => {
      await bindPrincipal(tx, caller);
      return fn(tx);
    });

  async function refuse(
    reply: FastifyReply,
    caller: Caller,
    entry: ContextDisclosure & { readonly refusal: ContextRefusal },
  ): Promise<FastifyReply> {
    await bound(caller, (tx) => recordContextDisclosure(tx, entry));
    return reply.code(CONTEXT_REFUSALS[entry.refusal].status).send(refusalBody(entry.refusal));
  }

  app.post<{ Body: { query: string; limit: number } }>(
    '/context-source/retrieve',
    {
      bodyLimit: 4096,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['query', 'limit'],
          properties: {
            query: { type: 'string', minLength: 1, maxLength: 512 },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
        },
      },
    },
    (request, reply) =>
      handle(request, reply, async (caller) => {
        const semantic = options.semantic;
        if (semantic === undefined) {
          return refuse(reply, caller, {
            operation: 'retrieve',
            refusal: 'semantic_ranking_unavailable',
          });
        }
        // The ceiling the database bound, not the one asked for (ADR 0033): the engine is asked at
        // the clamped clearance, and every transaction below binds the same principal.
        let ceiling = caller.maxClassification;
        const run = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
          withTransaction(options.pool, async (tx) => {
            ceiling = await bindPrincipal(tx, caller);
            return fn(tx);
          });
        const coverage = await run((tx) => readCoverage(tx, caller));
        const ranker: SemanticRanker = {
          rank: (runner, ranked) => semantic.rank(runner, { ...ranked, coverage }),
        };
        // Composed search, exactly as GET /search composes it: the engine's ids re-checked under
        // row security and grants, the trace digest recorded (RQ-219), the query recorded (§64B).
        const composed = await composeSearch(
          run,
          {
            organizationId: caller.organizationId,
            maxClassification: ceiling,
            attestation: caller.attestation,
          },
          { text: request.body.query, limit: request.body.limit },
          {
            grants: {
              reaches: (id, classification) => grantReaches(coverage, { id, classification }),
            },
            semantic: ranker,
            record: true,
          },
        );
        if (composed.semantic === undefined) {
          return refuse(reply, caller, {
            operation: 'retrieve',
            refusal: 'semantic_ranking_unavailable',
          });
        }
        const hits = composed.semantic.hits;

        const outcome = await bound(
          caller,
          async (tx): Promise<Outcome<{ references: SourceReference[] }>> => {
            const corpus = await agentContextCorpus(tx, caller);
            if (corpus.status !== 'current') {
              await recordContextDisclosure(tx, { operation: 'retrieve', refusal: corpus.status });
              return { refused: corpus.status };
            }
            const references: SourceReference[] = [];
            let omitted = 0;
            for (const hit of hits) {
              const member = corpus.members.get(hit.objectId);
              // Outside the agent_context projection (an exclusion or a hold the search re-check
              // does not apply), or text the consumer could not take: left out, and counted.
              const text = member === undefined ? undefined : await describeText(tx, member);
              if (member === undefined || text === undefined || text.oversize) {
                omitted += 1;
                continue;
              }
              references.push(referenceOf(member, text.digest));
            }
            await recordContextDisclosure(tx, {
              operation: 'retrieve',
              corpusDigest: corpus.corpusDigest,
              referencesDigest: referencesDigest(references),
              referenceCount: references.length,
              omittedCount: omitted,
            });
            return { answer: { references } };
          },
        );
        if ('refused' in outcome) {
          return reply
            .code(CONTEXT_REFUSALS[outcome.refused].status)
            .send(refusalBody(outcome.refused));
        }
        return reply.send(outcome.answer);
      }),
  );

  app.post<{ Body: SourceReference }>(
    '/context-source/read',
    {
      bodyLimit: 4096,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['adapter', 'record', 'revision', 'digest'],
          properties: {
            adapter: { const: CONTEXT_SOURCE_ADAPTER },
            record: { type: 'string', minLength: 1, maxLength: 128 },
            revision: { type: 'string', pattern: HEX64 },
            digest: { type: 'string', pattern: HEX64 },
          },
        },
      },
    },
    (request, reply) =>
      handle(request, reply, async (caller, store) => {
        const reference = request.body;
        // Not an identifier this Fabric issues, so nothing it could name: the one not-found answer.
        if (!UUID.test(reference.record)) {
          return refuse(reply, caller, { operation: 'read', refusal: 'not_found' });
        }
        const outcome = await bound(caller, async (tx): Promise<Outcome<ContextSourceRecord>> => {
          const decline = async (
            refusal: ContextRefusal,
            named: boolean,
          ): Promise<Outcome<ContextSourceRecord>> => {
            await recordContextDisclosure(tx, {
              operation: 'read',
              refusal,
              ...(named
                ? {
                    objectId: reference.record,
                    revision: reference.revision,
                    textDigest: reference.digest,
                  }
                : {}),
            });
            return { refused: refusal };
          };

          const corpus = await agentContextCorpus(tx, caller);
          const member = corpus.members.get(reference.record);
          if (member === undefined) {
            return (await onceIncluded(tx, caller, reference.record))
              ? decline('grant_withdrawn', true)
              : decline('not_found', false);
          }
          const text = await describeText(tx, member);
          if (member.contentDigest !== reference.revision || text.digest !== reference.digest) {
            return decline('revision_mismatch', true);
          }
          if (corpus.status !== 'current') return decline(corpus.status, true);
          if (text.oversize) return decline('source_text_unavailable', true);

          let body: string | undefined;
          if (text.kind === 'facts') {
            body = text.text;
          } else {
            try {
              const served = await readVerifiedDocumentBytes(
                store,
                text.source,
                options.stores === undefined
                  ? undefined
                  : degradedReadFrom(options.pool, caller, options.stores, text.source.versionId),
              );
              body = decodeText(served.bytes);
            } catch {
              body = undefined;
            }
          }
          // The bytes were verified against the version's recorded SHA-256; encoding the text back
          // proves the string LAMU receives hashes to the digest it was promised.
          if (body === undefined || digestBytes(Buffer.from(body, 'utf8')) !== reference.digest) {
            return decline('source_text_unavailable', true);
          }
          const record: ContextSourceRecord = {
            schema: CONTEXT_SOURCE_RECORD_SCHEMA,
            source: {
              adapter: CONTEXT_SOURCE_ADAPTER,
              record: member.objectId,
              revision: member.contentDigest,
              digest: reference.digest,
            },
            text: body,
            classification: member.classification,
            trust: 'untrusted',
            localOnly: true,
            retention: 'ephemeral',
          };
          if (Buffer.byteLength(JSON.stringify(record), 'utf8') > MAX_CONTEXT_RESPONSE_BYTES) {
            return decline('source_text_unavailable', true);
          }
          await recordContextDisclosure(tx, {
            operation: 'read',
            corpusDigest: corpus.corpusDigest,
            objectId: member.objectId,
            revision: member.contentDigest,
            textDigest: reference.digest,
          });
          return { answer: record };
        });
        if ('refused' in outcome) {
          return reply
            .code(CONTEXT_REFUSALS[outcome.refused].status)
            .send(refusalBody(outcome.refused));
        }
        return reply.send(outcome.answer);
      }),
  );
}
