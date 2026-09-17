import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TokenVerifier } from '@kf/authorization';
import { setResolvedAccessContext, withReadTransaction, type Pool, type Tx } from '@kf/database';
import { searchIn } from '@kf/search';
import {
  ContextSourceRefused,
  contextSourceReferencesIn,
  readContextSourceIn,
  type ContextSourceReference,
} from '@kf/documents';
import { createCallerIdentifier } from './actions/auth.js';
import type { Caller } from './actions/contracts.js';

/** Private local transport. Never register with development header identity. */
export async function registerContextSourceRoutes(
  app: FastifyInstance,
  options: { readonly pool: Pool; readonly verifier: TokenVerifier },
): Promise<void> {
  const identify = createCallerIdentifier(options.pool, options.verifier);
  async function execute(
    request: FastifyRequest,
    reply: FastifyReply,
    operation: (tx: Tx, caller: Caller) => Promise<unknown>,
  ) {
    void reply.header('cache-control', 'no-store');
    const peer = request.raw.socket.remoteAddress;
    if (peer !== '127.0.0.1' && peer !== '::1' && peer !== '::ffff:127.0.0.1') {
      return reply.code(403).send({ error: 'local_transport_required' });
    }
    const control = new AbortController();
    const disconnect = () => control.abort();
    reply.raw.once('close', disconnect);
    const deadline = setTimeout(() => control.abort(), 10_000);
    deadline.unref();
    try {
      let caller;
      try {
        caller = await identify({ headers: request.headers });
      } catch {
        return reply.code(401).send({ error: 'caller_unidentified' });
      }
      control.signal.throwIfAborted();
      const result = await withReadTransaction(options.pool, control.signal, (tx) =>
        operation(tx, caller),
      );
      control.signal.throwIfAborted();
      if (result === undefined) return reply.code(404).send({ error: 'source_unavailable' });
      return reply.send(result);
    } catch (error: unknown) {
      if (error instanceof ContextSourceRefused) {
        return reply
          .code(error.reason === 'revision_mismatch' ? 409 : 422)
          .send({ error: error.reason });
      }
      return reply.code(503).send({ error: 'source_unavailable' });
    } finally {
      clearTimeout(deadline);
      reply.raw.removeListener('close', disconnect);
    }
  }
  app.post<{ Body: ContextSourceReference }>(
    '/context-source/read',
    {
      bodyLimit: 4096,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['adapter', 'record', 'revision', 'digest'],
          properties: {
            adapter: { const: 'knowledge-fabric' },
            record: { type: 'string', minLength: 1, maxLength: 128 },
            revision: { type: 'string', pattern: '^[0-9a-f]{64}$' },
            digest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          },
        },
      },
    },
    (request, reply) =>
      execute(request, reply, (tx, caller) => readContextSourceIn(tx, caller, request.body)),
  );
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
      execute(request, reply, async (tx, caller) => {
        const maxClassification = await setResolvedAccessContext(tx, {
          subjectId: caller.actorId,
          assignmentId: caller.actingRoleId,
          organizationId: caller.organizationId,
          requestedClassification: caller.maxClassification,
        });
        const hits = await searchIn(
          tx,
          { organizationId: caller.organizationId, maxClassification },
          { text: request.body.query, limit: request.body.limit },
        );
        const references = await contextSourceReferencesIn(
          tx,
          caller,
          hits.map((hit) => hit.objectId),
        );
        return { references };
      }),
  );
}
