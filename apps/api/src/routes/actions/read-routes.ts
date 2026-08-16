import type { FastifyInstance } from 'fastify';
import { DEFAULT_REASON_REQUIRED } from '@kf/actions';
import { withTransaction, type Pool, type Tx } from '@kf/database';
import { projectProgress } from '@kf/work-control';
import { unidentified } from './auth.js';
import type { Caller, IdentifyCaller } from './contracts.js';

interface ReadRouteOptions {
  readonly pool: Pool;
  readonly identify: IdentifyCaller;
}

export function registerReadRoutes(app: FastifyInstance, options: ReadRouteOptions): void {
  registerProjectReadRoute(app, options);
  registerAvailableActionsRoute(app, options);
  registerHistoryRoute(app, options);
}

async function identifyCaller(
  identify: IdentifyCaller,
  headers: Record<string, unknown>,
): Promise<Caller> {
  return identify({ headers });
}

async function setAccessContext(tx: Tx, caller: Caller): Promise<void> {
  await tx.query('select core.set_access_context($1, $2)', [
    caller.organizationId,
    caller.maxClassification,
  ]);
}

function registerProjectReadRoute(app: FastifyInstance, options: ReadRouteOptions): void {
  app.get<{ Params: { id: string } }>('/projects/:id', async (request, reply) => {
    let caller: Caller;
    try {
      caller = await identifyCaller(options.identify, request.headers as Record<string, unknown>);
    } catch (err: unknown) {
      return reply.code(401).send(unidentified(err));
    }

    return withTransaction(options.pool, async (tx) => {
      await setAccessContext(tx, caller);
      const project = await tx.maybeOne<Record<string, unknown>>(
        `select o.id, o.enterprise_id, o.title, o.lifecycle_state, o.row_version,
                p.project_code, p.objective, p.sponsor_id, p.started_on, p.target_completion
           from core.object o
           join work.initiative_project p on p.id = o.id
          where o.id = $1`,
        [request.params.id],
      );
      if (project === undefined) return reply.code(404).send({ error: 'not_found' });

      const packages = await tx.query<Record<string, unknown>>(
        `select o.id, o.title, o.lifecycle_state, wp.sequence_no, wp.acceptance_criterion
           from work.work_package wp
           join core.object o on o.id = wp.id
          where wp.project_id = $1 order by wp.sequence_no`,
        [request.params.id],
      );

      return reply.send({
        ...project,
        packages,
        progress: await projectProgress(tx, request.params.id),
      });
    });
  });
}

function registerAvailableActionsRoute(app: FastifyInstance, options: ReadRouteOptions): void {
  app.get<{ Params: { id: string } }>('/objects/:id/available-actions', async (request, reply) => {
    let caller: Caller;
    try {
      caller = await identifyCaller(options.identify, request.headers as Record<string, unknown>);
    } catch (err: unknown) {
      return reply.code(401).send(unidentified(err));
    }

    return withTransaction(options.pool, async (tx) => {
      await setAccessContext(tx, caller);
      const object = await tx.maybeOne<{ object_type: string; lifecycle_state: string }>(
        'select object_type, lifecycle_state from core.object where id = $1',
        [request.params.id],
      );
      if (object === undefined) return reply.code(404).send({ error: 'not_found' });

      const transitions = await tx.query<{ action_id: string; to_state: string }>(
        `select t.action_id, t.to_state
           from registry.state_transition t
          where t.object_type = $1 and t.from_state = $2
          order by t.action_id, t.to_state`,
        [object.object_type, object.lifecycle_state],
      );

      const byAction = new Map<string, string[]>();
      for (const transition of transitions) {
        byAction.set(transition.action_id, [
          ...(byAction.get(transition.action_id) ?? []),
          transition.to_state,
        ]);
      }

      return reply.send({
        objectId: request.params.id,
        objectType: object.object_type,
        state: object.lifecycle_state,
        actions: [...byAction.entries()].map(([actionType, toStates]) => ({
          actionType,
          toStates,
          requiresChoice: toStates.length > 1,
          reasonRequired: DEFAULT_REASON_REQUIRED.includes(actionType),
        })),
      });
    });
  });
}

function registerHistoryRoute(app: FastifyInstance, options: ReadRouteOptions): void {
  app.get<{ Params: { id: string } }>('/objects/:id/history', async (request, reply) => {
    let caller: Caller;
    try {
      caller = await identifyCaller(options.identify, request.headers as Record<string, unknown>);
    } catch (err: unknown) {
      return reply.code(401).send(unidentified(err));
    }

    return withTransaction(options.pool, async (tx) => {
      await setAccessContext(tx, caller);
      const visible = await tx.maybeOne<{ id: string }>(
        'select id from core.object where id = $1',
        [request.params.id],
      );
      if (visible === undefined) return reply.code(404).send({ error: 'not_found' });

      const events = await tx.query<Record<string, unknown>>(
        `select e.seq, e.action_type, e.actor_id, e.acting_role_id, e.recorded_at,
                e.effective_at, e.reason, e.digest
           from core.audit_event e
          where e.object_id = $1 or $1 = any(
                  select unnest(a.target_ids) from core.action a where a.id = e.action_id)
          order by e.seq`,
        [request.params.id],
      );
      return reply.send({ objectId: request.params.id, events });
    });
  });
}
