/**
 * Fastify application factory.
 *
 * Kept separate from `server.ts` so tests can build an app and call `inject()` without
 * binding a port.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import type { ApiConfig } from './config.js';

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
    environment: config.environment,
  }));

  app.get('/ready', async (_request, reply) => {
    const checks: Record<string, 'ok' | 'unconfigured'> = {
      database: config.databaseUrl ? 'ok' : 'unconfigured',
    };
    // Gate 3 replaces this with a real `SELECT 1` against the pool. Until the kernel
    // exists, report unconfigured honestly rather than claiming readiness.
    const ready = Object.values(checks).every((v) => v === 'ok');
    return reply.code(ready ? 200 : 503).send({ service: SERVICE_NAME, ready, checks });
  });

  return app;
}
