import type { FastifyInstance } from 'fastify';
import { setResolvedAccessContext, withTransaction, type Pool } from '@kf/database';
import { allocationOf } from '@kf/identifiers';
import { unidentified } from './actions.js';
import type { IdentifyCaller } from './actions/contracts.js';

const ENTERPRISE_ID = /^[A-Z]{2,5}-[A-Z]{2,5}-[0-9]{4,9}(-[0-9]{6})?-[0-9]$/;

/**
 * `GET /identifiers/:enterpriseId` — the allocation receipt for an identifier (ADR 0018).
 *
 * The receipt is the ledger row: which object, which namespace and sequence, who, and by
 * which recorded act, with the server's `allocated_at`. An identifier the caller cannot see the
 * object of — or one that was never allocated here — reads as _not found_, so the route cannot
 * be used to enumerate what exists.
 */
export async function registerIdentifierRoutes(
  app: FastifyInstance,
  options: { readonly pool: Pool; readonly identify: IdentifyCaller },
): Promise<void> {
  app.get<{ Params: { enterpriseId: string } }>(
    '/identifiers/:enterpriseId',
    async (request, reply) => {
      if (!ENTERPRISE_ID.test(request.params.enterpriseId)) {
        return reply.code(404).send({ error: 'not_found' });
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
        const allocation = await allocationOf(tx, request.params.enterpriseId);
        if (allocation === undefined) return reply.code(404).send({ error: 'not_found' });
        return reply.send({
          enterprise_id: allocation.enterprise_id,
          object_id: allocation.object_id,
          namespace: allocation.qualified_code,
          sequence: Number(allocation.sequence),
          allocated_at: allocation.allocated_at.toISOString(),
          allocated_by: allocation.allocated_by,
          allocated_by_action: allocation.allocated_by_action,
        });
      });
    },
  );
}
