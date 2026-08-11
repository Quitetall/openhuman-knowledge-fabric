/**
 * Fastify application factory.
 *
 * Kept separate from `server.ts` so tests can build an app and call `inject()` without
 * binding a port.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { createDispatcher } from '@kf/actions';
import { createPool, withTransaction, type Pool } from '@kf/database';
import { assessReadiness } from '@kf/operations';
import {
  WORK_CONTROL_EFFECTS,
  WORK_CONTROL_MATERIALIZERS,
  WORK_CONTROL_PRECONDITIONS,
} from '@kf/work-control';
import type { ApiConfig } from './config.js';
import { registerActionRoutes } from './routes/actions.js';

export const SERVICE_NAME = 'openhuman-knowledge-fabric-api';

/**
 * Liveness and readiness are deliberately different questions.
 *
 * `/health` answers "is this process running" — it must not touch a dependency, or a
 * database blip would cause an orchestrator to kill an otherwise healthy process.
 * `/ready` answers "can this process serve traffic" and is where dependency checks belong.
 */
export async function buildApp(config: ApiConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Structured JSON logs (directive §3 observability). Pretty-printing is a
      // developer-tooling concern and is applied outside the process.
      formatters: { level: (label) => ({ level: label }) },
    },
    // Every request carries a correlation id; actions record it in the audit event.
    genReqId: () => crypto.randomUUID(),
  });

  // Return the correlation id to the caller. An id that only appears in server logs cannot
  // be quoted in a support request or matched against the audit event it produced.
  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });

  app.get('/health', async () => ({
    service: SERVICE_NAME,
    status: 'ok',
    // Deliberately no environment name, version or build id. This endpoint is
    // unauthenticated, and naming the deployment is free reconnaissance for no operational
    // benefit — the caller already knows which host it dialled.
  }));

  let pool: Pool | undefined;
  if (config.databaseUrl !== undefined && config.databaseUrl !== '') {
    pool = createPool({ connectionString: config.databaseUrl });
    app.addHook('onClose', async () => {
      await pool?.end();
    });
  }

  app.get('/ready', async (_request, reply) => {
    const checks: Record<string, 'ok' | 'unconfigured' | 'failing'> = {
      database: pool === undefined ? 'unconfigured' : 'ok',
    };
    if (pool !== undefined) {
      try {
        // A real round trip. "The pool object exists" is not readiness — it says nothing
        // about whether the database is reachable, which is the only question being asked.
        await withTransaction(pool, async (tx) => tx.query('select 1'));
      } catch {
        checks['database'] = 'failing';
      }
    }
    const ready = Object.values(checks).every((v) => v === 'ok');
    return reply.code(ready ? 200 : 503).send({ service: SERVICE_NAME, ready, checks });
  });

  if (pool !== undefined) {
    /**
     * Deep readiness, for an operator rather than an orchestrator.
     *
     * Separate from `/ready` on purpose: a load balancer asks "can this process serve a
     * request", and answering that with a full chain verification would take a database
     * outage and turn it into a restart loop. This one answers "is the system in the state
     * it is supposed to be in", which is a slower and much more interesting question.
     */
    app.get('/readiness', async (_request, reply) => {
      const report = await assessReadiness(pool);
      return reply.code(report.ready ? 200 : 503).send(report);
    });

    const execute = createDispatcher(pool, {
      materializers: WORK_CONTROL_MATERIALIZERS,
      effects: WORK_CONTROL_EFFECTS,
      preconditions: WORK_CONTROL_PRECONDITIONS,
    });
    await registerActionRoutes(app, {
      pool,
      execute,
      // Header-supplied identity is a development affordance and nothing else. Reaching
      // production with it would be a total authentication bypass, so the decision is made
      // here from configuration rather than left to a request-time flag someone can flip.
      trustHeaders: config.environment === 'development' || config.environment === 'test',
    });
  }

  return app;
}
