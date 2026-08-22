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
  return new Pool(options);
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
    const result = await fn(wrap(client));
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

export const PACKAGE = {
  name: '@kf/database',
  role: 'PostgreSQL access boundary',
  owns: [],
} as const;

export type { Pool } from 'pg';
