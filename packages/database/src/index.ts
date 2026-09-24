/**
 * PostgreSQL access boundary.
 *
 * The only package permitted to open a connection. Everything else receives a transaction
 * handle, so no code path can quietly acquire its own and escape the action transaction —
 * which is the whole reason the action model can promise atomicity.
 *
 * Kysely is the project's SQL layer for typed domain queries. It arrives with the domain
 * tables in Gate 5; the kernel here is a handful of hand-written statements against tables
 * whose shape is fixed by migration, and typing them through a query builder would add a
 * layer without removing a risk.
 */

import {
  Pool,
  types as pgTypes,
  type CustomTypesConfig,
  type PoolClient,
  type PoolConfig,
} from 'pg';

export interface DatabaseConfig {
  readonly connectionString: string;
  readonly maxConnections?: number;
  /** Fail fast rather than queue forever behind an exhausted pool. */
  readonly connectionTimeoutMillis?: number;
  readonly statementTimeoutMillis?: number;
  /**
   * Budget for waiting on a lock, as opposed to running.
   *
   * Must stay below `statementTimeoutMillis` or it can never fire, and a bound that cannot
   * fire is worse than no bound: it reads as a control while enforcing nothing.
   */
  readonly lockTimeoutMillis?: number;
  /**
   * Where an IDLE client's death is reported.
   *
   * Not the same thing as a failed query, which rejects at its call site. This fires for
   * connections sitting in the pool between requests when the server goes away underneath them —
   * a restart, a failover, a dropped socket. There is no caller to reject, so without somewhere
   * to send it the error has nowhere to go but up.
   *
   * Defaults to a process warning. It must never rethrow.
   */
  readonly onIdleClientError?: (error: Error) => void;
}

export type PrincipalRefusal = 'role_not_held' | 'classification_not_granted' | 'not_attested';

/**
 * The database refused to bind a principal: the assignment is not held live in that
 * organization, the requested ceiling exceeds the person's clearance, or — for the application
 * login — nobody attested that the person is present (20260924001000). `reason` says which,
 * because a dead assignment, a clearance refusal and a missing attestation are different problems
 * for whoever reads the refusal. Callers serving reads answer it as not-found — out of scope and
 * nonexistent are the same answer (threat model T3).
 */
export class PrincipalRefused extends Error {
  readonly reason: PrincipalRefusal;
  constructor(reason: PrincipalRefusal, message: string) {
    super(message);
    this.name = 'PrincipalRefused';
    this.reason = reason;
  }
}

export class DatabaseError extends Error {
  // Uses the standard `cause` option rather than a field of its own, so the underlying
  // failure survives into stack traces and structured logs the way runtimes expect.
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DatabaseError';
  }
}

export function createPool(config: DatabaseConfig): Pool {
  const statementTimeout = config.statementTimeoutMillis ?? 30_000;
  // Ten seconds is far longer than any healthy statement here waits to be granted a lock, and
  // comfortably under the default statement budget, so the two bounds stay distinguishable.
  //
  // Clamped rather than applied blindly: a caller who sets a tight `statementTimeoutMillis` and
  // no lock budget has written nothing wrong, and refusing their config over a default they
  // never chose would be this function inventing an error. Only an explicit contradiction is
  // refused.
  //
  // PostgreSQL reads `statement_timeout = 0` as "no limit", so there is no ceiling to stay
  // under and the plain default applies. Clamping against it arithmetically would compute
  // `max(1, -1)` and hand back a ONE MILLISECOND lock budget — the precise inversion of what
  // the caller asked for, and silent.
  const statementsAreUnbounded = statementTimeout <= 0;
  const lockTimeout =
    config.lockTimeoutMillis ??
    (statementsAreUnbounded ? 10_000 : Math.min(10_000, Math.max(1, statementTimeout - 1)));
  if (
    !statementsAreUnbounded &&
    config.lockTimeoutMillis !== undefined &&
    lockTimeout >= statementTimeout
  ) {
    throw new DatabaseError(
      `lockTimeoutMillis (${lockTimeout}) must be below statementTimeoutMillis ` +
        `(${statementTimeout}); otherwise the statement budget always fires first and the ` +
        `lock budget is decoration.`,
    );
  }
  const options: PoolConfig = {
    connectionString: config.connectionString,
    max: config.maxConnections ?? 10,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5_000,
    // A statement that runs unboundedly holds locks unboundedly. Every action is meant to
    // be short; one that is not should fail and be looked at, not stall the system.
    statement_timeout: statementTimeout,
    // Separates "waiting for a lock" from "running too long", which `statement_timeout` alone
    // cannot: both surface as the same aborted statement. That ambiguity is not hypothetical —
    // it is why a CI flake in the document dogfood could not be diagnosed from its own logs
    // (task #156). Blocked and starved now fail with different SQLSTATEs, so the next
    // occurrence classifies itself instead of needing a reproduction.
    lock_timeout: lockTimeout,
    // An idle transaction holds its snapshot and its locks. This is the guard against a
    // forgotten `await` leaving a transaction open across a request boundary.
    idle_in_transaction_session_timeout: 60_000,
  };
  const pool = new Pool(options);
  // A `pg.Pool` with no 'error' listener is a process-killer, and this is the only place in the
  // system that constructs one. node-postgres says it plainly: "if a pool emits an error event
  // and no listeners are added node will emit an uncaught error and potentially crash your node
  // process". The pool emits that event when an IDLE client dies — the server restarted, failed
  // over, or dropped the socket — and an idle client has no pending query to reject, so the
  // error surfaces with no owner.
  //
  // Found from a CI failure where every one of 1251 tests passed and the run still went red: a
  // PostgreSQL container stopped while a pooled connection was still open, SQLSTATE 57P01. The
  // test suite is where it was cheap to notice. In the API or the worker the same event is a
  // process death on a network blip, which is the part that actually matters.
  pool.on('error', (cause) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (config.onIdleClientError) {
      try {
        config.onIdleClientError(error);
        return;
      } catch {
        // The doc comment asks callers not to rethrow, but a contract is not enforcement, and a
        // throw from here lands inside an EventEmitter 'error' handler — which is precisely the
        // uncaught-exception path this whole function exists to close. A logger whose transport
        // has dropped is the obvious way to hit it. Fall through to the default.
      }
    }
    // Warn rather than swallow. Silence here would turn "the database went away" into a
    // connection count that quietly drops, which is worse to diagnose than a noisy log.
    //
    // Message-plus-options, NOT the Error itself: `process.emitWarning(err, type)` IGNORES the
    // type when the first argument is an Error, so the label silently became "Error" and the
    // warning was indistinguishable from any other. Verified on node v24.18.1.
    process.emitWarning(error.message, {
      type: 'KfIdleClientError',
      detail: error.stack ?? '',
    });
  });
  return pool;
}

/**
 * The transaction handle every other package works against.
 *
 * Deliberately narrow: it exposes querying and nothing that could commit, roll back, or
 * open a second transaction. Committing is the dispatcher's decision alone.
 */
export interface Tx {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<R[]>;
  /**
   * Run one query with exact text decoders for named PostgreSQL type OIDs.
   *
   * Overrides are scoped to this statement. Preservation code uses this to keep values such
   * as timestamptz microseconds and JSON numeric lexemes out of process-global pg parsers and
   * out of JavaScript's lossy Date/number representations.
   */
  queryWithTextParsers<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] | undefined,
    parsers: readonly PgTextParserOverride[],
  ): Promise<R[]>;
  /** Exactly one row, or an error naming what was expected. */
  one<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<R>;
  /** At most one row. */
  maybeOne<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<R | undefined>;
}

export interface PgTextParserOverride {
  readonly oid: number;
  readonly parse: (text: string) => unknown;
}

function wrap(client: PoolClient): Tx {
  // Each method declares its own type parameter. Sharing one closure across all three makes
  // the row type of `one` and `maybeOne` unify with `query`'s, which the compiler correctly
  // rejects — they are independent choices at each call site.
  return {
    async query<R extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<R[]> {
      const result = await client.query(sql, [...params]);
      return result.rows as R[];
    },
    async queryWithTextParsers<R extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
      parsers: readonly PgTextParserOverride[],
    ): Promise<R[]> {
      const byOid = new Map(parsers.map((parser) => [parser.oid, parser.parse]));
      const customTypes: CustomTypesConfig = {
        getTypeParser(oid, format = 'text') {
          if (format === 'text') {
            const parser = byOid.get(oid);
            if (parser !== undefined) return parser;
          }
          return pgTypes.getTypeParser(oid, format);
        },
      };
      const result = await client.query({ text: sql, values: [...params], types: customTypes });
      return result.rows as R[];
    },
    async one<R extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<R> {
      const result = await client.query(sql, [...params]);
      if (result.rows.length !== 1) {
        throw new DatabaseError(`expected exactly 1 row, got ${result.rows.length}`);
      }
      return result.rows[0] as R;
    },
    async maybeOne<R extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<R | undefined> {
      const result = await client.query(sql, [...params]);
      if (result.rows.length > 1) {
        throw new DatabaseError(`expected at most 1 row, got ${result.rows.length}`);
      }
      return result.rows[0] as R | undefined;
    },
  };
}

/**
 * Run `fn` inside one transaction. Commit on return, roll back on throw.
 *
 * There is no partial-success path: an action either happened or it did not, and a caller
 * cannot be handed a half-applied change to reason about.
 */
export async function withTransaction<T>(pool: Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const tx = wrap(client);
    transactionPools.set(tx, pool);
    const result = await fn(tx);
    await client.query('commit');
    return result;
  } catch (err: unknown) {
    try {
      await client.query('rollback');
    } catch (rollbackErr: unknown) {
      // The original failure is what the caller needs; a rollback failure on top of it is
      // context, not a replacement. Losing the first error to the second is a classic way
      // to make an incident unreadable.
      throw new DatabaseError(
        `transaction failed, and rollback also failed: ${String(rollbackErr)}`,
        err,
      );
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Bind actor, role, action and request to the CURRENT transaction.
 *
 * Triggers and policies read these. A controlled write without them is refused by the
 * database, so this is not a convenience — it is the thing that makes "forgot to record
 * who did it" impossible rather than merely discouraged.
 */
export async function setTransactionContext(
  tx: Tx,
  ctx: {
    readonly actorId: string;
    readonly actingRoleId: string;
    readonly actionId: string;
    readonly requestId?: string;
  },
): Promise<void> {
  await tx.query('select core.set_transaction_context($1, $2, $3, $4)', [
    ctx.actorId,
    ctx.actingRoleId,
    ctx.actionId,
    ctx.requestId ?? null,
  ]);
}

/** Bind the reader's organization and classification ceiling for row-level security. */
export async function setAccessContext(
  tx: Tx,
  ctx: { readonly organizationId: string; readonly maxClassification: string },
): Promise<void> {
  await tx.query('select core.set_access_context($1, $2)', [
    ctx.organizationId,
    ctx.maxClassification,
  ]);
}

/**
 * Bind the transaction to a PRINCIPAL: a person acting under a live role assignment in an
 * organization. The database derives the organization's visibility and the ceiling from that
 * person's assignment and clearance; the request may only narrow the ceiling. Returns the
 * ceiling bound.
 *
 * Since 20260923000100 this is the only way the application binds a reader. It used to bind
 * `restricted` provisionally and then the resolved ceiling through `set_access_context` —
 * which meant the application role could bind any organization at any ceiling, and a
 * compromised API could read every tenant. The database now does the resolution itself,
 * inside `core.bind_principal`, and refuses the unbounded bind outright.
 *
 * Since 20260924001000 the application login must also hand over an ATTESTATION: proof, issued
 * by the separate kf-attestor process after it verified the person's bearer token, that the
 * person is present. `attestation` is required as a key so that every call site states where
 * its attestation comes from; `undefined` is for administrator and service logins, which the
 * database binds on the strength of their credential, and for development pools that registered
 * an issuer (`registerAttestationIssuer`).
 */
export async function setResolvedAccessContext(
  tx: Tx,
  ctx: {
    readonly subjectId: string;
    readonly assignmentId: string;
    readonly organizationId: string;
    readonly requestedClassification: string;
    readonly attestation: string | undefined;
  },
): Promise<string> {
  let bound: { ceiling: string | null } | undefined;
  try {
    // A registered issuer (development, tests) refuses exactly what the bind would — a dead
    // assignment, a ceiling above clearance — so its refusal is read the same way.
    const attestation =
      ctx.attestation ??
      (await attestationFor(tx, {
        actorId: ctx.subjectId,
        actingRoleId: ctx.assignmentId,
        organizationId: ctx.organizationId,
        maxClassification: ctx.requestedClassification,
      }));
    bound = await tx.maybeOne<{ ceiling: string | null }>(
      'select core.bind_principal($1, $2, $3, $4, $5) as ceiling',
      [
        ctx.subjectId,
        ctx.assignmentId,
        ctx.organizationId,
        ctx.requestedClassification,
        attestation ?? null,
      ],
    );
  } catch (error: unknown) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
    const message = error instanceof Error ? error.message : String(error);
    if (code === '42501') {
      throw new PrincipalRefused(
        /not held live/.test(message)
          ? 'role_not_held'
          : /attestation/.test(message)
            ? 'not_attested'
            : 'classification_not_granted',
        message,
      );
    }
    throw error;
  }
  if (bound?.ceiling === undefined || bound.ceiling === null || bound.ceiling.trim() === '') {
    throw new DatabaseError('principal binding returned no ceiling');
  }
  return bound.ceiling;
}

/** Who is reading or acting: a person, under a live assignment, in an organization. */
export interface Principal {
  readonly actorId: string;
  readonly actingRoleId: string;
  readonly organizationId: string;
  /** The ceiling requested; the database clamps it to the person's clearance. */
  readonly maxClassification: string;
  /**
   * kf-attestor's proof that this person presented a verified bearer token, for this
   * organization and assignment, at or above this ceiling (20260924001000). Carried on the
   * caller for the whole request so every transaction binds with it; absent for administrator
   * and service logins, which do not need one.
   */
  readonly attestation?: string | undefined;
}

/** `setResolvedAccessContext` for the shape every identified caller already has. */
export async function bindPrincipal(tx: Tx, principal: Principal): Promise<string> {
  return setResolvedAccessContext(tx, {
    subjectId: principal.actorId,
    assignmentId: principal.actingRoleId,
    organizationId: principal.organizationId,
    requestedClassification: principal.maxClassification,
    attestation: principal.attestation,
  });
}

/**
 * Ask the database to vouch that a person is present, and return the attestation.
 *
 * Executable only by `kf_attestor` (and administrators). The attestor calls it after verifying a
 * bearer token; development and test pools call it through a registered issuer. The database
 * re-checks the assignment and clamps the ceiling itself; the expiry is the earlier of
 * `tokenExpiry` and one minute from now.
 */
export async function issueAttestation(
  tx: Tx,
  principal: Principal,
  tokenExpiry?: Date,
  delegation: {
    /** The token's `act.client_id`: the agent acting for the person (ADR 0035). */
    readonly agentClientId?: string | undefined;
    /** The token's `azp`, so the database can refuse a declared agent's token without `act`. */
    readonly authorizedParty?: string | undefined;
  } = {},
): Promise<string> {
  const row = await tx.one<{ attestation: string }>(
    'select core.issue_attestation($1, $2, $3, $4, $5, $6, $7) as attestation',
    [
      principal.actorId,
      principal.actingRoleId,
      principal.organizationId,
      principal.maxClassification,
      tokenExpiry ?? null,
      delegation.agentClientId ?? null,
      delegation.authorizedParty ?? null,
    ],
  );
  return row.attestation;
}

/**
 * Where a pool's transactions get an attestation they were not handed.
 *
 * DEVELOPMENT AND TEST ONLY — and security does not depend on that. An issuer can issue only
 * what its own database login may, and `core.issue_attestation` is executable by `kf_attestor`
 * alone; the dogfood API refuses to start through a login holding it. So a registered issuer on
 * a production pool would fail at the database, not bind anybody. It exists so the development
 * profile (header identity, in-process attestor) and the test harness bind naturally.
 */
export type AttestationIssuer = (principal: Principal) => Promise<string>;

const attestationIssuers = new WeakMap<Pool, AttestationIssuer>();
const transactionPools = new WeakMap<Tx, Pool>();

export function registerAttestationIssuer(pool: Pool, issuer: AttestationIssuer | undefined): void {
  if (issuer === undefined) attestationIssuers.delete(pool);
  else attestationIssuers.set(pool, issuer);
}

/** The principal's own attestation, else one from its transaction's registered issuer. */
export async function attestationFor(tx: Tx, principal: Principal): Promise<string | undefined> {
  if (principal.attestation !== undefined) return principal.attestation;
  const pool = transactionPools.get(tx);
  const issuer = pool === undefined ? undefined : attestationIssuers.get(pool);
  return issuer === undefined ? undefined : issuer(principal);
}

/**
 * What the connected login can do that row-level security cannot stop.
 *
 * A superuser ignores every policy, FORCE included; so does a role with BYPASSRLS; and a table
 * owner is exempt from its own table's policies unless FORCE is set on each one, and can switch
 * FORCE off. Membership counts as well as the attribute, because a login that may SET ROLE to
 * any of these is one statement away from being it.
 */
export interface LoginPrivilege {
  readonly login: string;
  readonly superuser: boolean;
  readonly bypassesRls: boolean;
  /** A member of (or is) the role that owns a table in the fabric's schemas. */
  readonly ownsSchema: boolean;
  /**
   * A member of `kf_attestor`: may vouch that a person is present. The API's login must not
   * be, or it could attest to itself and the attestor would be decoration.
   */
  readonly attests: boolean;
  /** A member of `kf_service_actor`: binds service persons with no attestation at all. */
  readonly actsAsServiceActor: boolean;
}

export async function readLoginPrivilege(tx: Tx): Promise<LoginPrivilege> {
  const row = await tx.one<{
    login: string;
    superuser: boolean;
    bypasses: boolean;
    owns: boolean;
    attests: boolean;
    service_actor: boolean;
  }>(
    `select current_user::text as login,
            exists (select from pg_roles r
                     where r.rolsuper and pg_has_role(current_user, r.oid, 'MEMBER')) as superuser,
            exists (select from pg_roles r
                     where r.rolbypassrls and pg_has_role(current_user, r.oid, 'MEMBER')) as bypasses,
            exists (select from pg_class c
                      join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname not in ('pg_catalog', 'information_schema')
                       and n.nspname !~ '^pg_'
                       and c.relkind in ('r', 'p')
                       and pg_has_role(current_user, c.relowner, 'MEMBER')) as owns,
            exists (select from pg_roles r
                     where r.rolname = 'kf_attestor'
                       and pg_has_role(current_user, r.oid, 'MEMBER')) as attests,
            exists (select from pg_roles r
                     where r.rolname = 'kf_service_actor'
                       and pg_has_role(current_user, r.oid, 'MEMBER')) as service_actor`,
  );
  return {
    login: row.login,
    superuser: row.superuser,
    bypassesRls: row.bypasses,
    ownsSchema: row.owns,
    attests: row.attests,
    actsAsServiceActor: row.service_actor,
  };
}

/** Why a login must not serve application traffic; empty when it may. */
export interface LoginPrivilegeAllowance {
  /** Only a development API (its in-process attestor) and kf-attestor itself may attest. */
  readonly mayAttest?: boolean;
  /** Only the storage sweep's login binds as a service actor. */
  readonly mayActAsServiceActor?: boolean;
}

export function loginPrivilegeProblems(
  privilege: LoginPrivilege,
  allowance: LoginPrivilegeAllowance = {},
): string[] {
  const problems: string[] = [];
  if (privilege.superuser) problems.push('is (or can become) a superuser');
  if (privilege.bypassesRls) problems.push('is (or can become) a role with BYPASSRLS');
  if (privilege.ownsSchema) problems.push('is (or is a member of) a table owner');
  if (privilege.attests && allowance.mayAttest !== true) {
    problems.push('is a member of kf_attestor, so it could attest to a person itself');
  }
  if (privilege.actsAsServiceActor && allowance.mayActAsServiceActor !== true) {
    problems.push('is a member of kf_service_actor, so it binds service actors unattested');
  }
  return problems;
}

export const PACKAGE = {
  name: '@kf/database',
  role: 'PostgreSQL access boundary',
  owns: [],
} as const;

export type { Pool } from 'pg';
