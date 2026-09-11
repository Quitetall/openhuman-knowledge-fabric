import type { FastifyInstance } from 'fastify';
import { setAccessContext, withTransaction } from '@kf/database';
import { readGranted, readGrantedSubset } from './read-grant.js';
import { getDocument, listDocuments } from '@kf/documents';
import { unidentified } from '../actions.js';
import type { DocumentRoutesOptions } from './contracts.js';
import { controlledDocumentSourceProvenance } from './repository.js';

export function registerDocumentReadRoutes(
  app: FastifyInstance,
  options: DocumentRoutesOptions,
): void {
  app.get('/documents', async (request, reply) => {
    let identity;
    try {
      identity = await options.identify({
        headers: request.headers as Record<string, unknown>,
      });
    } catch (error: unknown) {
      return reply.code(401).send(unidentified(error));
    }
    return withTransaction(options.pool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: identity.organizationId,
        maxClassification: identity.maxClassification,
      });
      return { documents: await readGrantedSubset(tx, identity, await listDocuments(tx)) };
    });
  });

  app.get<{ Params: { id: string } }>('/documents/:id', async (request, reply) => {
    let identity;
    try {
      identity = await options.identify({
        headers: request.headers as Record<string, unknown>,
      });
    } catch (error: unknown) {
      return reply.code(401).send(unidentified(error));
    }
    return withTransaction(options.pool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: identity.organizationId,
        maxClassification: identity.maxClassification,
      });
      const document = await getDocument(tx, request.params.id);
      if (document === undefined) return reply.code(404).send({ error: 'not_found' });
      if (!(await readGranted(tx, identity, document.id))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const sourceProvenance = await controlledDocumentSourceProvenance(
        tx,
        document.id,
        identity.organizationId,
      );
      return reply.send({ ...document, sourceProvenance });
    });
  });
}
