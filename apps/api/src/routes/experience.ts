/**
 * The experience's reads (ADR 0040; SAS §24B): the dashboard, the living organization overview,
 * the master-document page, and the organization's role presets.
 *
 *   GET /dashboard         one layout for everyone, every panel under the reader's grants (RQ-262)
 *   GET /overview          the living organization overview as this reader may read it (RQ-268);
 *                          404 when no grant reaches the overview record, which says nothing
 *                          about whether one exists
 *   GET /master-document   the reader's scope compiled, overview first when in scope (RQ-267);
 *                          `?type=<object type>&after=<object id>&limit=<n>` pages one section
 *   GET /roles             the organization's role presets and inclusions, as far as the reader
 *                          can see their scopes (RQ-269)
 *
 * Every one binds the caller as a principal and reads under that binding. None writes: compiling
 * the master record is `POST /master-record/compile`, an act, which the master-document page asks
 * for with a click.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { listRolePresets } from '@kf/authorization';
import { setResolvedAccessContext, withTransaction, type Pool, type Tx } from '@kf/database';
import { readOrganizationOverview } from '@kf/documents';
import type { ProjectionDefinitionSet } from '@kf/projections';
import { refuseUnidentified, type Caller, type IdentifyCaller } from './actions.js';
import { readDashboard } from './experience/dashboard.js';
import { MASTER_DOCUMENT_PAGE_LIMIT, readMasterDocument } from './experience/master-document.js';

export interface ExperienceRoutesOptions {
  readonly pool: Pool;
  readonly identify: IdentifyCaller;
  /** The compiled projection definitions; without them the overview is never in scope. */
  readonly projections?: ProjectionDefinitionSet;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBJECT_TYPE = /^[a-z][a-z0-9_]{0,63}$/;

function refusalOf(error: unknown): { status: number; body: Record<string, unknown> } | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
  if (code === '42501' || /classification|clearance/i.test(message)) {
    return { status: 403, body: { error: 'classification_not_granted' } };
  }
  return undefined;
}

async function asReader<T>(
  options: ExperienceRoutesOptions,
  request: FastifyRequest,
  reply: FastifyReply,
  read: (tx: Tx, caller: Caller) => Promise<T>,
): Promise<FastifyReply | T> {
  let caller: Caller;
  try {
    caller = await options.identify({ headers: request.headers as Record<string, unknown> });
  } catch (error: unknown) {
    return refuseUnidentified(reply, error);
  }
  try {
    return await withTransaction(options.pool, async (tx) => {
      await setResolvedAccessContext(tx, {
        subjectId: caller.actorId,
        assignmentId: caller.actingRoleId,
        organizationId: caller.organizationId,
        requestedClassification: caller.maxClassification,
        attestation: caller.attestation,
      });
      return read(tx, caller);
    });
  } catch (error: unknown) {
    const refusal = refusalOf(error);
    if (refusal !== undefined) return reply.code(refusal.status).send(refusal.body);
    throw error;
  }
}

export function registerExperienceRoutes(
  app: FastifyInstance,
  options: ExperienceRoutesOptions,
): void {
  app.get('/dashboard', async (request, reply) =>
    asReader(options, request, reply, async (tx, caller) =>
      reply
        .header('cache-control', 'private, no-store')
        .send(await readDashboard(tx, caller, options.projections)),
    ),
  );

  app.get('/overview', async (request, reply) =>
    asReader(options, request, reply, async (tx, caller) => {
      const definition = options.projections?.byId('organization_overview');
      const answer =
        definition === undefined
          ? ({ status: 'not_in_scope' } as const)
          : await readOrganizationOverview(
              tx,
              { personId: caller.actorId, organizationId: caller.organizationId },
              definition,
            );
      if (answer.status !== 'ready') return reply.code(404).send({ error: 'not_found' });
      return reply.header('cache-control', 'private, no-store').send(answer);
    }),
  );

  app.get<{ Querystring: { type?: string; after?: string; limit?: string } }>(
    '/master-document',
    async (request, reply) => {
      const { type, after, limit } = request.query;
      if (type !== undefined && !OBJECT_TYPE.test(type)) {
        return reply
          .code(400)
          .send({ error: 'invalid_parameter', message: 'type is an object type' });
      }
      if (after !== undefined && (type === undefined || !UUID.test(after))) {
        return reply.code(400).send({
          error: 'invalid_parameter',
          message: 'after is an object id, and pages one section: name it with type',
        });
      }
      const size = limit === undefined ? undefined : Number(limit);
      if (
        size !== undefined &&
        (!Number.isInteger(size) || size < 1 || size > MASTER_DOCUMENT_PAGE_LIMIT)
      ) {
        return reply.code(400).send({
          error: 'invalid_parameter',
          message: `limit is 1 to ${String(MASTER_DOCUMENT_PAGE_LIMIT)}`,
        });
      }
      return asReader(options, request, reply, async (tx, caller) =>
        reply.header('cache-control', 'private, no-store').send(
          await readMasterDocument(tx, caller, options.projections, {
            ...(type === undefined ? {} : { objectType: type }),
            ...(after === undefined ? {} : { after }),
            ...(size === undefined ? {} : { limit: size }),
          }),
        ),
      );
    },
  );

  app.get('/roles', async (request, reply) =>
    asReader(options, request, reply, async (tx, caller) =>
      reply.header('cache-control', 'private, no-store').send({
        format: 'kf-role-presets-v1',
        organizationId: caller.organizationId,
        roles: await listRolePresets(tx, caller.organizationId),
      }),
    ),
  );
}
