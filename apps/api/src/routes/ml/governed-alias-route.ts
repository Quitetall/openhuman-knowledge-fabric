import type { FastifyInstance } from 'fastify';
import { IdentityRejected } from '@kf/authorization';
import { setAccessContext, withTransaction } from '@kf/database';
import { CallerRejected, unidentified } from '../actions.js';
import type { MlRoutesOptions } from '../ml.js';
import { MlSchemaUnavailable, requireMlSchema } from '../../schema-contract.js';
import { GovernedAliasUnverifiable, readGovernedAlias } from './governed-alias.js';
import { GOVERNED_ALIAS_TOKEN } from './validation.js';

export function registerGovernedAliasRoute(app: FastifyInstance, options: MlRoutesOptions): void {
  app.get<{ Params: { aliasId: string } }>(
    '/ml/governed-aliases/:aliasId',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      let caller;
      try {
        caller = await options.identify({
          headers: request.headers as Record<string, unknown>,
        });
      } catch (error: unknown) {
        if (error instanceof CallerRejected || error instanceof IdentityRejected) {
          return reply.code(401).send(unidentified(error));
        }
        request.log.error({ err: error }, 'governed alias caller identification failed');
        return reply.code(500).send({ error: 'internal_error', requestId: request.id });
      }

      if (!GOVERNED_ALIAS_TOKEN.test(request.params.aliasId)) {
        return reply.code(400).send({
          error: 'invalid_governed_alias',
          message: 'governed alias must be an opaque lowercase registry identifier',
        });
      }

      try {
        const projection = await withTransaction(options.pool, async (tx) => {
          await tx.query('set transaction isolation level repeatable read, read only');
          await setAccessContext(tx, {
            organizationId: caller.organizationId,
            maxClassification: caller.maxClassification,
          });
          await requireMlSchema(tx);
          return readGovernedAlias(tx, caller.organizationId, request.params.aliasId);
        });
        return reply.send(projection);
      } catch (error: unknown) {
        if (error instanceof MlSchemaUnavailable) {
          return reply.code(503).send({ error: 'ml_schema_unavailable' });
        }
        if (error instanceof GovernedAliasUnverifiable) {
          return reply.code(503).send({
            error: 'governed_alias_unverifiable',
            message: error.message,
          });
        }
        request.log.error({ err: error }, 'governed alias projection failed');
        return reply.code(500).send({ error: 'internal_error', requestId: request.id });
      }
    },
  );
}
