import type { FastifyInstance } from 'fastify';
import { explainAccess } from '@kf/authorization';
import { setResolvedAccessContext, withTransaction } from '@kf/database';
import { enumeratePermittedSet } from '@kf/documents';
import { unidentified } from '../actions.js';
import type { DocumentRoutesOptions } from './contracts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * `GET /objects/:id/access[?person=<uuid>]` — why can (or can't) a person see this object?
 *
 * The answer is the policy path (ADR 0016): organization membership, clearance, classification,
 * grant coverage, exclusions, holds — each a fact already in the database, in the order the
 * permitted set applies them, with the deciding step named. The caller must be able to see the
 * object themselves; otherwise the answer is _not found_, so asking about a colleague can never
 * reveal a record the asker has no access to. `person` defaults to the caller.
 */
export function registerAccessExplanationRoute(
  app: FastifyInstance,
  options: DocumentRoutesOptions,
): void {
  app.get<{ Params: { id: string }; Querystring: { person?: string } }>(
    '/objects/:id/access',
    async (request, reply) => {
      if (!UUID.test(request.params.id)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const person = request.query.person;
      if (person !== undefined && !UUID.test(person)) {
        return reply
          .code(400)
          .send({ error: 'invalid_parameter', message: 'person must be a uuid' });
      }
      let identity;
      try {
        identity = await options.identify({
          headers: request.headers as Record<string, unknown>,
        });
      } catch (error: unknown) {
        return reply.code(401).send(unidentified(error));
      }

      return withTransaction(options.pool, async (tx) => {
        await setResolvedAccessContext(tx, {
          subjectId: identity.actorId,
          assignmentId: identity.actingRoleId,
          organizationId: identity.organizationId,
          requestedClassification: identity.maxClassification,
        });
        const permitted = await enumeratePermittedSet(
          tx,
          identity.actorId,
          identity.organizationId,
        );
        if (!permitted.some((member) => member.objectId === request.params.id)) {
          return reply.code(404).send({ error: 'not_found' });
        }
        const explanation = await explainAccess(tx, {
          personId: person ?? identity.actorId,
          organizationId: identity.organizationId,
          objectId: request.params.id,
        });
        return reply
          .header('x-kf-explanation-digest', explanation.explanationDigest)
          .send(explanation);
      });
    },
  );
}
