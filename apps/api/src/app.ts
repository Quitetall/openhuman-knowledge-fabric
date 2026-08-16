/**
 * Fastify application factory.
 *
 * Kept separate from `server.ts` so tests can build an app and call `inject()` without
 * binding a port.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { S3ObjectStore, type ObjectStore } from '@kf/artifacts';
import { createPool, withTransaction, type Pool } from '@kf/database';
import { TokenVerifier } from '@kf/authorization';
import {
  createDocumentActionAtoms,
  PandocDocumentParser,
  type DocumentParser,
} from '@kf/documents';
import {
  createFabricDispatcher,
  createFabricTransactionalDispatcher,
  createFabricTransactionalPreflight,
} from '@kf/orchestrator';
import { assessReadiness } from '@kf/operations';
import type { ApiConfig } from './config.js';
import { createCallerIdentifier, registerActionRoutes } from './routes/actions.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerMlRoutes } from './routes/ml.js';
import { registerSearchRoutes } from './routes/search.js';
import { hasRequiredSchema } from './schema-contract.js';

export const SERVICE_NAME = 'openhuman-knowledge-fabric-api';

/**
 * Liveness and readiness are deliberately different questions.
 *
 * `/health` answers "is this process running" — it must not touch a dependency, or a
 * database blip would cause an orchestrator to kill an otherwise healthy process.
 * `/ready` answers "can this process serve traffic" and is where dependency checks belong.
 */
export interface AppDependencies {
  readonly objectStore?: ObjectStore;
  readonly documentParser?: DocumentParser;
}

export async function buildApp(
  config: ApiConfig,
  dependencies: AppDependencies = {},
): Promise<FastifyInstance> {
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

    // Transport and content security.
    //
    // TLS is terminated upstream — this process speaks HTTP to a proxy on a private network,
    // which is the normal arrangement and the one `config.tlsTerminatedUpstream` makes the
    // deployment state out loud. What this process CAN do is refuse to be useful over plain
    // HTTP anyway:
    //
    //   HSTS tells a browser never to try http:// for this host again, which closes the
    //   downgrade window that exists on the very first request.
    //   nosniff stops a JSON error body being executed as script if it is ever fetched
    //   cross-origin.
    //   DENY on framing: nothing here should ever be embedded, and a UI that approves
    //   payments is exactly what clickjacking is for.
    //   no-store, because responses carry records the browser cache has no business keeping.
    if (config.environment === 'production' || config.environment === 'staging') {
      void reply.header('strict-transport-security', 'max-age=63072000; includeSubDomains');
    }
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('x-frame-options', 'DENY');
    void reply.header('referrer-policy', 'no-referrer');
    void reply.header('cache-control', 'no-store');
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
      database: pool === undefined ? 'unconfigured' : 'failing',
      schema: pool === undefined ? 'unconfigured' : 'failing',
    };
    if (pool !== undefined) {
      try {
        // A real round trip. "The pool object exists" is not readiness — it says nothing
        // about whether the database is reachable, which is the only question being asked.
        await withTransaction(pool, async (tx) => {
          await tx.query('select 1');
          checks['database'] = 'ok';
          checks['schema'] = (await hasRequiredSchema(tx)) ? 'ok' : 'failing';
        });
      } catch {
        checks['database'] = 'failing';
        checks['schema'] = 'failing';
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

    const objectStore =
      dependencies.objectStore ??
      (config.artifactStore === undefined ? undefined : new S3ObjectStore(config.artifactStore));
    const parser = dependencies.documentParser ?? new PandocDocumentParser();
    const documentAtoms =
      objectStore === undefined
        ? undefined
        : createDocumentActionAtoms({ store: objectStore, parser });
    const execute = createFabricDispatcher(pool, documentAtoms);
    const executeInTransaction = createFabricTransactionalDispatcher(documentAtoms);
    const preflightInTransaction = createFabricTransactionalPreflight(documentAtoms);
    const verifier = config.identity === undefined ? undefined : new TokenVerifier(config.identity);
    const identify = createCallerIdentifier(pool, verifier);
    await registerActionRoutes(app, {
      pool,
      execute,
      ...(verifier === undefined ? {} : { verifier }),
      // Header-supplied identity is a development affordance and nothing else, and it is
      // reachable only when no identity provider is configured — `registerActionRoutes`
      // ignores headers entirely once a verifier exists, rather than falling back to them,
      // because a fallback activates exactly when the provider is unreachable.
      trustHeaders: config.environment === 'development' || config.environment === 'test',
    });
    await registerDocumentRoutes(app, {
      pool,
      executeInTransaction,
      preflightInTransaction,
      identify,
      store: objectStore,
    });
    await registerMlRoutes(app, { pool, identify, executeInTransaction });
    await registerSearchRoutes(app, { pool, identify });
  }

  return app;
}
