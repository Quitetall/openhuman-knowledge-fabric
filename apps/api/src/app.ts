/**
 * Fastify application factory.
 *
 * Kept separate from `server.ts` so tests can build an app and call `inject()` without
 * binding a port.
 */

import { loadProjectionDefinitions } from '@kf/projections';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  StoreAddressMismatch,
  StoreRegistry,
  createStorageActionAtoms,
  type ObjectStore,
} from '@kf/artifacts';
import {
  createPool,
  DatabaseError,
  issueAttestation,
  loginPrivilegeProblems,
  PrincipalRefused,
  readLoginPrivilege,
  registerAttestationIssuer,
  withTransaction,
  type LoginPrivilegeAllowance,
  type Pool,
} from '@kf/database';
import {
  AttestorUnavailable,
  SocketAttestor,
  TokenVerifier,
  type Attestor,
} from '@kf/authorization';
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
import {
  assessReadiness,
  compareInstalledOntology,
  describeOntologyMismatch,
  resolveReleaseOntology,
  type InstalledOntology,
  type ReadinessReport,
} from '@kf/operations';
import { timingSafeEqual } from 'node:crypto';
import type { ApiConfig } from './config.js';
import { createCallerIdentifier, registerActionRoutes } from './routes/actions.js';
import { DEFAULT_EFFECTIVE_AT_BOUNDS } from './routes/actions/effective-at.js';
import { attestorUnavailable, createHoldingsLister } from './routes/actions/auth.js';
import { registerDocumentRoutes } from './routes/documents.js';
import type { ProjectionLinks } from '@kf/projections';
import { registerMlRoutes } from './routes/ml.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerContextSourceRoutes } from './routes/context-source.js';
import { RetrievalClient, SemanticRetrieval } from '@kf/retrieval';
import { registerIdentifierRoutes } from './routes/identifiers.js';
import { registerVerificationRoutes } from './routes/verifications.js';
import { registerNeedsYouRoutes } from './routes/needs-you.js';
import { registerAgentSettingsRoutes } from './routes/agent-settings.js';
import { registerCaptureRoutes } from './routes/capture.js';
import { registerSessionRoutes } from './routes/session.js';
import { requestLogSerializers } from './request-log.js';
import { hasRequiredSchema } from './schema-contract.js';

export const SERVICE_NAME = 'openhuman-knowledge-fabric-api';

/** How long one deep-readiness assessment answers for. */
const READINESS_TTL_MS = 10_000;

const LOOPBACK_PEERS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Whether this request may see the full readiness report.
 *
 * Loopback means a DIRECT loopback connection. The TLS proxy also connects from loopback, so a
 * forwarded request (any forwarding header present) is judged as the remote caller it is. A
 * local process that adds such a header only downgrades itself.
 */
function mayReadReadinessDetail(request: FastifyRequest, token: string | undefined): boolean {
  if (token !== undefined) {
    const presented = request.headers['x-kf-readiness-token'];
    if (typeof presented === 'string') {
      const a = Buffer.from(presented);
      const b = Buffer.from(token);
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    }
  }
  const forwarded =
    request.headers['x-forwarded-for'] !== undefined ||
    request.headers['forwarded'] !== undefined ||
    request.headers['x-real-ip'] !== undefined;
  return !forwarded && LOOPBACK_PEERS.has(request.socket.remoteAddress ?? '');
}

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
  /** Where log lines go instead of stdout: a test seam, to read what the log would have said. */
  readonly logStream?: { write(line: string): void };
  /**
   * A stand-in for the retrieval engine: a test seam, as `objectStore` is. Production builds one
   * from `retrievalSocket` and nothing else.
   */
  readonly semantic?: Pick<SemanticRetrieval, 'rank'>;
}

export async function buildApp(
  config: ApiConfig,
  dependencies: AppDependencies = {},
): Promise<FastifyInstance> {
  // loadConfig refuses this too; buildApp accepts any ApiConfig, so it is refused here as well.
  if (config.deploymentProfile === 'dogfood' && config.attestorSocket === undefined) {
    throw new Error(
      'refusing to build a dogfood API without KF_ATTESTOR_SOCKET: the database binds a person ' +
        'for this login only on an attestation from kf-attestor.',
    );
  }
  // Only the development profile attests in-process, and so only its login may hold
  // kf_attestor. Anywhere else a login that could attest to people itself makes kf-attestor
  // decoration, and one that binds service actors unattested is the same hole by another door.
  const loginAllowance: LoginPrivilegeAllowance = {
    mayAttest: config.deploymentProfile === 'development',
  };
  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Structured JSON logs (directive §3 observability). Pretty-printing is a
      // developer-tooling concern and is applied outside the process.
      formatters: { level: (label) => ({ level: label }) },
      // A request is logged as its route, never its URL, and an error without the fields that
      // quote row contents (request-log.ts): query text and record text stay out of the log.
      serializers: requestLogSerializers,
      ...(dependencies.logStream === undefined ? {} : { stream: dependencies.logStream }),
    },
    // Every request carries a correlation id; actions record it in the audit event.
    genReqId: () => crypto.randomUUID(),
    // Signed master-record links carry claims plus an HMAC in one path segment. Fastify defaults
    // to 100 bytes, which rejects valid capabilities before route code can verify them. Derived
    // subset scopes carry recipient and object IDs, so the bound must cover that signed claim.
    routerOptions: { maxParamLength: 2048 },
  });

  // kf-attestor over its socket. An outage is logged once, when it starts, with the socket path,
  // and once when it ends; every request meanwhile answers 503 attestor_unavailable.
  const attestorClient =
    config.attestorSocket === undefined
      ? undefined
      : new SocketAttestor(config.attestorSocket, {
          onAvailabilityChange: (state) => {
            if (state.available) {
              app.log.info({ socket: state.socketPath }, 'kf-attestor is answering again');
            } else {
              app.log.error(
                { socket: state.socketPath, reason: state.reason },
                'kf-attestor is unreachable; bearer requests answer 503 attestor_unavailable ' +
                  'until it answers again',
              );
            }
          },
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

  // One shape for every unhandled failure. Fastify's default handler returns `err.message` on a
  // 500, and a message from pg or the S3 client names hosts, ports, roles and SQL: free
  // reconnaissance, and sometimes a record's contents quoted back in a constraint error. The
  // detail goes to the server log under the request id; the caller gets the id to quote.
  //
  // 4xx errors are Fastify's own refusals (malformed JSON, oversized body, unsupported media
  // type). Their messages describe the caller's request, not this server, so they are kept.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    // A principal the database refused to bind — no live assignment in that organization, or a
    // ceiling above clearance — is out of scope, and out of scope reads as absent (T3).
    if ((error as unknown) instanceof PrincipalRefused) {
      return reply.code(404).send({ error: 'not_found', requestId: request.id });
    }
    // Any route that let an attestor outage through rather than answering it itself.
    if ((error as unknown) instanceof AttestorUnavailable) {
      return attestorUnavailable(reply);
    }
    const status =
      typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled error');
      return reply.code(status).send({ error: 'internal_error', requestId: request.id });
    }
    return reply
      .code(status)
      .send({ error: error.code ?? 'bad_request', message: error.message, requestId: request.id });
  });

  // Fastify's default not-found handler logs "Route GET:<url> not found", query string and all,
  // and echoes the URL back. The path of a request that matched nothing is whatever the caller
  // typed, so it is neither logged (request-log.ts) nor repeated.
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: 'not_found', requestId: request.id }),
  );

  app.get('/health', async () => ({
    service: SERVICE_NAME,
    status: 'ok',
    // Deliberately no environment name, version or build id. This endpoint is
    // unauthenticated, and naming the deployment is free reconnaissance for no operational
    // benefit — the caller already knows which host it dialled.
  }));

  // The ontology this release was compiled from: the projections artifact the document routes
  // serve (KF-SAS-RQ-081). Resolved once, so startup, /readiness and the routes agree.
  const releaseOntology = resolveReleaseOntology({ artifactPath: config.projectionsArtifact });
  // Where a mismatch refuses startup rather than warning: anything that is not a developer's
  // own machine.
  const refuseOntologyMismatch =
    config.deploymentProfile === 'dogfood' ||
    config.environment === 'production' ||
    config.environment === 'staging';

  let pool: Pool | undefined;
  if (config.databaseUrl !== undefined && config.databaseUrl !== '') {
    pool = createPool({ connectionString: config.databaseUrl });
    const startupPool = pool;
    app.addHook('onClose', async () => {
      await pool?.end();
    });
    // Refuse to serve through a login that row-level security cannot bind.
    //
    // Every tenant and classification boundary in this schema is a policy, and a superuser, a
    // BYPASSRLS role or the table owner walks past all of them. A wrong credential file —
    // the migrator's URL where the application's belonged — therefore silently disabled every
    // one while /ready stayed green. Checked when the app becomes ready (listen), before any
    // request is taken.
    //
    // An UNREACHABLE database is not refused here: that is an outage, not a misconfiguration,
    // and /ready already reports it. Only a reachable, over-privileged login stops startup.
    app.addHook('onReady', async () => {
      let problems: string[];
      let login: string;
      let installedOntology: InstalledOntology | undefined;
      // A release that cannot say which ontology it carries is refused even when the database
      // is unreachable: that is a fault in the release tree, not an outage.
      if (releaseOntology.digest === undefined && refuseOntologyMismatch) {
        throw new DatabaseError(
          `refusing to serve: ${describeOntologyMismatch(releaseOntology, undefined) ?? ''}`,
        );
      }
      try {
        const privilege = await withTransaction(startupPool, (tx) => readLoginPrivilege(tx));
        problems = loginPrivilegeProblems(privilege, loginAllowance);
        login = privilege.login;
        if (
          config.deploymentProfile === 'development' &&
          attestorClient === undefined &&
          !privilege.attests
        ) {
          app.log.warn(
            { login },
            'development login does not hold kf_attestor, so the in-process attestor cannot ' +
              'vouch for anybody and every bind will be refused; re-run `pnpm dogfood:load`, ' +
              'which grants it, or set KF_ATTESTOR_SOCKET',
          );
        }
      } catch (err: unknown) {
        app.log.warn({ err }, 'database login privileges could not be checked at startup');
        return;
      }
      if (problems.length > 0) {
        throw new DatabaseError(
          `refusing to serve: database login ${JSON.stringify(login)} ${problems.join(', ')}, ` +
            'so row-level security or attestation does not bind it. DATABASE_URL must name an ' +
            'application login that inherits kf_app and nothing more.',
        );
      }
      // Read only after the login is known to be one this process may serve through: a login
      // refused above may not be able to read the registry, and that must stay a refusal.
      const expectedDigest = releaseOntology.digest;
      if (expectedDigest !== undefined) {
        try {
          installedOntology = await withTransaction(startupPool, (tx) =>
            compareInstalledOntology(tx, expectedDigest),
          );
        } catch (err: unknown) {
          app.log.warn({ err }, 'the seeded ontology digest could not be checked at startup');
          return;
        }
      }
      // The seeded ontology is the one this release was compiled from (KF-SAS-RQ-081). A
      // release switched without its migration, or a database seeded from another checkout,
      // serves states and transitions the code does not define. Refused outside development;
      // a developer mid-rebase gets a warning instead of a process that will not start.
      const ontologyProblem = describeOntologyMismatch(releaseOntology, installedOntology);
      if (ontologyProblem !== undefined) {
        if (refuseOntologyMismatch) {
          throw new DatabaseError(`refusing to serve: ${ontologyProblem}`);
        }
        app.log.warn({ source: releaseOntology.source }, `ontology digest: ${ontologyProblem}`);
      }
    });
  }

  app.get('/ready', async (_request, reply) => {
    const checks: Record<string, 'ok' | 'unconfigured' | 'failing'> = {
      database: pool === undefined ? 'unconfigured' : 'failing',
      schema: pool === undefined ? 'unconfigured' : 'failing',
      // The startup refusal covers the process's own boot; this keeps saying it for as long as
      // the process runs, so a probe never reports ready through a login RLS cannot bind.
      login: pool === undefined ? 'unconfigured' : 'failing',
      // Present only when an attestor is configured: without it no bearer caller can be bound.
      ...(attestorClient === undefined ? {} : { attestor: 'failing' as const }),
    };
    if (attestorClient !== undefined) {
      checks['attestor'] = (await attestorClient.healthy()) ? 'ok' : 'failing';
    }
    if (pool !== undefined) {
      try {
        // A real round trip. "The pool object exists" is not readiness — it says nothing
        // about whether the database is reachable, which is the only question being asked.
        await withTransaction(pool, async (tx) => {
          await tx.query('select 1');
          checks['database'] = 'ok';
          checks['schema'] = (await hasRequiredSchema(tx)) ? 'ok' : 'failing';
          checks['login'] =
            loginPrivilegeProblems(await readLoginPrivilege(tx), loginAllowance).length === 0
              ? 'ok'
              : 'failing';
        });
      } catch {
        checks['database'] = 'failing';
        checks['schema'] = 'failing';
        checks['login'] = 'failing';
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
     *
     * Two audiences, two bodies. The full report names every organization by id, counts its
     * records, states backup and checkpoint posture and quotes the text of any check that
     * could not run — reconnaissance for anybody else. An operator on this host (a direct
     * loopback connection, which is how the web app and a shell reach it) or a caller holding
     * KF_READINESS_TOKEN gets the report; everybody else gets the bare verdict.
     *
     * And one assessment per interval, not per request. The report walks the whole audit
     * chain, so an endpoint that recomputed it on every GET was a CPU and I/O lever for
     * anybody who could reach it. Concurrent callers share one run.
     */
    let cachedReadiness:
      { readonly at: number; readonly report: Promise<ReadinessReport> } | undefined;
    const readinessReport = (): Promise<ReadinessReport> => {
      const now = Date.now();
      if (cachedReadiness === undefined || now - cachedReadiness.at >= READINESS_TTL_MS) {
        const report = assessReadiness(
          pool,
          {},
          releaseOntology.digest === undefined
            ? {}
            : { expectedOntologyDigest: releaseOntology.digest },
        );
        const entry = { at: now, report };
        cachedReadiness = entry;
        // A failed run is not cached: the next caller measures again rather than being told
        // about a failure that may already be over.
        report.catch(() => {
          if (cachedReadiness === entry) cachedReadiness = undefined;
        });
      }
      return cachedReadiness.report;
    };
    app.get('/readiness', async (request, reply) => {
      const report = await readinessReport();
      // BOTH partitions, not `report.ready`.
      //
      // `report.ready` is a compatibility alias for `service.ready` — it narrowed when
      // readiness was split into service and institutional partitions, and this endpoint
      // narrowed silently with it. That made a fabric whose audit log has never been signed
      // answer 200 here, which is precisely the state this endpoint exists to surface.
      //
      // The split itself is right, and `/ready` above still follows service readiness alone
      // so a load balancer is not told to stop routing because an approval is missing. What
      // this endpoint asks is the question in its docstring — is the system in the state it
      // is supposed to be in — and that is the union.
      const inOrder = report.service.ready && report.institutional.ready;
      const status = inOrder ? 200 : 503;
      if (!mayReadReadinessDetail(request, config.readinessToken)) {
        return reply.code(status).send({ ready: inOrder });
      }
      return reply.code(status).send(report);
    });

    // Storage locations (ADR 0017): the working store is `working` in content.artifact_store;
    // a configured durable store is `durable`. Both are resolved against their registered rows
    // (KF-SAS-RQ-095): an API configured with a bucket the ledger does not call `working` refuses
    // to serve instead of writing evidence there. Deferred, not awaited here, for the same reason
    // the login check above is an onReady hook: an unreachable database is an outage `/ready`
    // reports, not a reason to exit — and no byte reaches a store before its address resolves.
    //
    // An injected `objectStore` is a test seam with no address to check; it is used as is.
    let stores: StoreRegistry | undefined;
    if (dependencies.objectStore !== undefined) {
      stores = new StoreRegistry({ working: dependencies.objectStore });
    } else if (config.artifactStore !== undefined) {
      const registry = StoreRegistry.deferredFromDatabase(pool, {
        working: config.artifactStore,
        ...(config.durableStore === undefined ? {} : { durable: config.durableStore }),
      });
      stores = registry;
      app.addHook('onReady', async () => {
        try {
          await registry.verify();
        } catch (err: unknown) {
          if (err instanceof StoreAddressMismatch) {
            throw new DatabaseError(`refusing to serve: ${err.message}`);
          }
          app.log.warn({ err }, 'object store addresses could not be checked at startup');
        }
      });
    }
    const objectStore = stores?.get('working');
    const storageAtoms = stores === undefined ? undefined : createStorageActionAtoms(stores);
    const parser = dependencies.documentParser ?? new PandocDocumentParser();
    const documentAtoms =
      objectStore === undefined
        ? undefined
        : createDocumentActionAtoms({
            store: objectStore,
            parser,
            ...(stores === undefined ? {} : { stores }),
          });
    const execute = createFabricDispatcher(pool, documentAtoms, undefined, undefined, storageAtoms);
    const executeInTransaction = createFabricTransactionalDispatcher(
      documentAtoms,
      undefined,
      undefined,
      storageAtoms,
    );
    const preflightInTransaction = createFabricTransactionalPreflight(
      documentAtoms,
      undefined,
      undefined,
      storageAtoms,
    );
    const verifier = config.identity === undefined ? undefined : new TokenVerifier(config.identity);
    // Where a bearer token becomes an attested caller. kf-attestor over its socket whenever one
    // is configured — always, under dogfood. Otherwise (development only; buildApp refused
    // dogfood above) the same verification runs in-process over this pool, whose development
    // login holds kf_attestor.
    // No identity provider still means no bearer path at all, attestor or not.
    const tokens: Attestor | TokenVerifier | undefined =
      verifier === undefined ? undefined : (attestorClient ?? verifier);
    if (config.deploymentProfile === 'development') {
      // Header identity has no token to attest, and the development workspace is visibly
      // non-authoritative: its binds get an attestation from this login directly. The database
      // refuses the issue for any login without kf_attestor, which is every login but a
      // development one, so this grants nothing the login did not already hold.
      const attestingPool = pool;
      registerAttestationIssuer(attestingPool, (principal) =>
        withTransaction(attestingPool, (tx) => issueAttestation(tx, principal)),
      );
    }
    // Header-supplied identity is a development affordance and nothing else, and it is
    // reachable only when no identity provider is configured — the identifier ignores headers
    // entirely once a verifier exists, rather than falling back to them, because a fallback
    // activates exactly when the provider is unreachable.
    //
    // Keyed on the DEPLOYMENT PROFILE, not on NODE_ENV. config.ts states the rule — "the
    // development profile is the only place header-supplied identity can exist" — and this
    // is the point of use that has to implement it. Keyed on `environment` alone, a dogfood
    // app built with NODE_ENV=test trusted headers, which is the one thing the profile
    // exists to forbid. `loadConfig` happens to prevent that combination reaching
    // production by requiring an identity provider under dogfood, but buildApp accepts any
    // ApiConfig, so relying on that made the guarantee depend on which constructor a caller
    // happened to use.
    //
    // The environment clause stays as well: both must agree before a header is a caller.
    //
    // ONE decision, handed to every route. It used to reach /actions only; the identifier
    // given to the document, ML, search and identifier routes trusted headers whenever the
    // verifier was absent, whatever the profile said.
    const trustHeaders =
      config.deploymentProfile === 'development' &&
      (config.environment === 'development' || config.environment === 'test');
    const identify = createCallerIdentifier(pool, tokens, { trustHeaders });
    await registerActionRoutes(app, {
      pool,
      execute,
      ...(verifier === undefined ? {} : { verifier }),
      ...(verifier === undefined || attestorClient === undefined
        ? {}
        : { attestor: attestorClient }),
      trustHeaders,
      ...(config.effectiveAtBackdate === undefined
        ? {}
        : {
            effectiveAtBounds: {
              ...DEFAULT_EFFECTIVE_AT_BOUNDS,
              maxBackdateMs: config.effectiveAtBackdate.maxDays * 24 * 60 * 60 * 1000,
              backdatableActions: new Set(config.effectiveAtBackdate.backdatableActions),
            },
          }),
    });
    // The bulk verification gesture: stamps promoted_in_bulk itself, one act per record.
    registerVerificationRoutes(app, { execute, identify });
    // What waits on the bound person, and the one gesture that answers each (ADR 0040).
    registerNeedsYouRoutes(app, { pool, execute, identify, bearer: tokens !== undefined });
    // What may leave the host, and the caller's own notification setting (ADR 0040, M4).
    registerAgentSettingsRoutes(app, { pool, identify });
    // One gesture, one observation (ADR 0034): the seam `kf note`, the web form and agents share.
    registerCaptureRoutes(app, { pool, execute, identify });
    // What a signed-in person may choose between when they pick their context.
    registerSessionRoutes(app, {
      pool,
      identify,
      holdings: createHoldingsLister(pool, tokens, { trustHeaders }),
    });
    await registerDocumentRoutes(app, {
      pool,
      // Absent only for hand-built test configs; the projection routes then answer 503.
      ...(config.projectionsArtifact === undefined
        ? {}
        : { projections: loadProjectionDefinitions(config.projectionsArtifact) }),
      executeInTransaction,
      preflightInTransaction,
      identify,
      store: objectStore,
      documentParser: parser,
      ...(stores === undefined ? {} : { stores }),
      ...(config.masterRecordLinkSecret === undefined
        ? {}
        : { masterRecordLinkSecret: config.masterRecordLinkSecret }),
      ...(config.publicOrigins === undefined
        ? {}
        : { links: projectionLinks(config.publicOrigins) }),
    });
    await registerMlRoutes(app, { pool, identify, executeInTransaction });
    // One client per engine for the life of the process, so the embedder pin (KF-SAS-RQ-218)
    // is the process's; absent, search is lexical only and says so (KF-SAS-RQ-216), and the
    // context source refuses to retrieve.
    const semantic =
      dependencies.semantic ??
      (config.retrievalSocket === undefined
        ? undefined
        : new SemanticRetrieval(new RetrievalClient({ socketPath: config.retrievalSocket })));
    await registerSearchRoutes(app, {
      pool,
      identify,
      ...(semantic === undefined ? {} : { semantic }),
    });
    // LAMU's context compiler reads through these (apps/api/src/routes/context-source.ts).
    await registerContextSourceRoutes(app, {
      pool,
      identify,
      store: objectStore,
      ...(stores === undefined ? {} : { stores }),
      ...(semantic === undefined ? {} : { semantic }),
    });
    await registerIdentifierRoutes(app, { pool, identify });
  }

  return app;
}

/**
 * Every member has an Object View; only members that carry bytes have a source. The paths are
 * the routes this process and the web app actually serve, not a guess about them.
 */
function projectionLinks(origins: {
  readonly web?: string;
  readonly api?: string;
}): ProjectionLinks {
  const encoded = (id: string): string => encodeURIComponent(id);
  return {
    objectView: (member) =>
      origins.web === undefined ? undefined : `${origins.web}/objects/${encoded(member.objectId)}`,
    source: (member) =>
      origins.api !== undefined && SOURCE_BEARING_TYPES.has(member.objectType)
        ? `${origins.api}/documents/${encoded(member.objectId)}/source`
        : undefined,
  };
}

/** Object types `GET /documents/:id/source` can answer for. */
const SOURCE_BEARING_TYPES: ReadonlySet<string> = new Set(['artifact', 'controlled_document']);
