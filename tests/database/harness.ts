/**
 * Database test harness.
 *
 * Starts a real PostgreSQL 18, applies every migration and the generated ontology seed, then
 * hands back a pool. Real, because the guarantees being tested — row-level security, append-
 * only triggers, exclusion constraints, `for update` locking — do not exist in a fake, and a
 * test against a fake would report that they hold when nobody had checked.
 *
 * Testcontainers rather than the compose stack: the suite has to be runnable from a clean
 * checkout without someone remembering to bring anything up first.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createPool, withTransaction, type Pool, type Tx } from '@kf/database';

const ROOT = join(import.meta.dirname, '..', '..');
const MIGRATIONS = join(ROOT, 'database', 'migrations');
const SEED = join(ROOT, 'generated', 'sql-registry', '001-ontology-seed.sql');

/**
 * The identity that creates the first records, before any person exists to attribute them
 * to. Fixed and recognisable rather than random, so a row attributed to it is obviously a
 * bootstrap artefact and not a real person's work.
 */
const BOOTSTRAP_IDENTITY = '01930000-0000-7000-8000-00000000b007';
const BOOTSTRAP_ACTION = '01930000-0000-7000-8000-00000000ac10';

export interface Harness {
  /**
   * Connected as an unprivileged application role, NOT the owner.
   *
   * This matters more than it looks. The container's bootstrap user is a superuser, and a
   * superuser bypasses row-level security even with FORCE ROW LEVEL SECURITY set. Testing
   * through the owner would have reported that every RLS policy worked while none of them
   * was ever consulted.
   */
  readonly pool: Pool;
  /** Owner connection, for migrations and fixture setup only. */
  readonly adminPool: Pool;
  readonly connectionString: string;
  stop(): Promise<void>;
}

/** Everything between `-- migrate:up` and `-- migrate:down`. */
function upSection(sql: string): string {
  const start = sql.indexOf('-- migrate:up');
  const end = sql.indexOf('-- migrate:down');
  if (start < 0) throw new Error('migration has no -- migrate:up section');
  return sql.slice(start + '-- migrate:up'.length, end < 0 ? undefined : end);
}

export async function startHarness(): Promise<Harness> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:18-alpine')
    .withDatabase('kf_test')
    .withUsername('kf_owner')
    .withPassword('test-only-not-a-secret')
    // Matches docker-compose: a libc collation change silently reorders text indexes, so the
    // test database must be built the same way production is.
    .withCommand(['postgres', '-c', 'wal_level=logical', '-c', 'track_commit_timestamp=on'])
    .start();

  const connectionString = container.getConnectionUri();
  const adminPool = createPool({ connectionString, maxConnections: 5 });

  await withTransaction(adminPool, async (tx) => {
    await tx.query('create extension if not exists btree_gist');
  });

  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = upSection(readFileSync(join(MIGRATIONS, file), 'utf8'));
    // Each migration in its own transaction, as dbmate applies them: a migration that fails
    // half-applied is far worse to diagnose than one that fails atomically.
    await withTransaction(adminPool, async (tx) => {
      await tx.query(sql);
    });
  }

  await withTransaction(adminPool, async (tx) => {
    await tx.query(readFileSync(SEED, 'utf8').replace(/^begin;$|^commit;$/gm, ''));
  });

  // A login role that INHERITS kf_app. Production does the same: privileges attach to the
  // nologin group, and people and services get login roles that inherit them.
  await withTransaction(adminPool, async (tx) => {
    await tx.query(
      `do $$ begin
         if not exists (select from pg_roles where rolname = 'kf_app_login') then
           create role kf_app_login login password 'test-only-not-a-secret' inherit;
         end if;
       end $$`,
    );
    await tx.query('grant kf_app to kf_app_login');
    await tx.query('grant connect on database kf_test to kf_app_login');
  });

  const appUri = new URL(connectionString);
  appUri.username = 'kf_app_login';
  appUri.password = 'test-only-not-a-secret';
  const pool = createPool({ connectionString: appUri.toString(), maxConnections: 5 });

  return {
    pool,
    adminPool,
    connectionString,
    async stop() {
      await pool.end();
      await adminPool.end();
      await container.stop();
    },
  };
}

// ── fixtures ────────────────────────────────────────────────────────────────────────────

export interface Fixtures {
  readonly organizationId: string;
  /** Holds technical_authority. Did not create the reviewed record. */
  readonly reviewerId: string;
  readonly reviewerRoleId: string;
  /** Holds performer, and IS the creator — used to prove separation of duty bites. */
  readonly performerId: string;
  readonly performerRoleId: string;
  readonly schemaVersion: string;
}

async function newObject(
  tx: Tx,
  o: {
    type: string;
    domain: string;
    state: string;
    title: string;
    org: string;
    createdBy: string;
    schemaVersion: string;
  },
): Promise<string> {
  const row = await tx.one<{ id: string }>(
    `insert into core.object
       (object_type, authority_domain, lifecycle_state, classification, retention_class,
        schema_version, organization_id, title, created_by, updated_by)
     values ($1,$2,$3,'internal','project_record',$4,$5,$6,$7,$7)
     returning id`,
    [o.type, o.domain, o.state, o.schemaVersion, o.org, o.title, o.createdBy],
  );
  return row.id;
}

/**
 * A minimal but real organization: one company, two people, two role assignments.
 *
 * Takes the ADMIN pool on purpose. Creating the first organization is a privileged
 * bootstrap, not an application action: the app role deliberately cannot conjure an
 * organization out of nothing, because every row-level policy is scoped to one that
 * already exists. Passing the app pool here fails, and that failure is the control working.
 *
 * Bootstrapping is also chicken-and-egg — the first object has no creator yet — so a
 * placeholder UUID seeds the first row and everything after references real people.
 * Recorded rather than hidden, because "who created the first record" is a question an
 * auditor asks.
 */
export async function seedFixtures(pool: Pool): Promise<Fixtures> {
  return withTransaction(pool, async (tx) => {
    const { version } = await tx.one<{ version: string }>(
      'select version from registry.schema_release where is_current',
    );
    const bootstrap = BOOTSTRAP_IDENTITY;

    await tx.query('select core.set_access_context($1, $2)', [bootstrap, 'restricted']);
    // Bootstrap writes are controlled writes. The trigger refuses one with no transaction
    // context, and rightly: "who created the first record" has an answer even here.
    await tx.query('select core.set_transaction_context($1, $1, $2, $3)', [
      bootstrap,
      BOOTSTRAP_ACTION,
      'harness-bootstrap',
    ]);

    const orgObj = await newObject(tx, {
      type: 'organization',
      domain: 'organization',
      state: 'active',
      title: 'OpenHuman Technologies LLC',
      org: bootstrap,
      createdBy: bootstrap,
      schemaVersion: version,
    });
    // Objects belong to the organization once it exists; the bootstrap row is re-homed so
    // no record is permanently owned by a placeholder.
    // Any change to a controlled record advances its version — including this one. The
    // trigger enforces it, which is what makes another reader's stale version stop
    // validating rather than silently keep working.
    await tx.query(
      'update core.object set organization_id = $1, row_version = row_version + 1 where id = $2',
      [orgObj, orgObj],
    );
    await tx.query('select core.set_access_context($1, $2)', [orgObj, 'restricted']);
    await tx.query(
      `insert into org.organization (id, legal_name, organization_kind)
       values ($1, 'OpenHuman Technologies LLC', 'company')`,
      [orgObj],
    );

    const mkPerson = async (name: string): Promise<string> => {
      const id = await newObject(tx, {
        type: 'person',
        domain: 'organization',
        state: 'active',
        title: name,
        org: orgObj,
        createdBy: bootstrap,
        schemaVersion: version,
      });
      await tx.query(
        'insert into org.person (id, display_name, organization) values ($1, $2, $3)',
        [id, name, orgObj],
      );
      return id;
    };
    const reviewerId = await mkPerson('Reviewer');
    const performerId = await mkPerson('Performer');

    const mkRole = async (subject: string, role: string): Promise<string> => {
      const id = await newObject(tx, {
        type: 'role_assignment',
        domain: 'organization',
        state: 'active',
        title: `${role} assignment`,
        org: orgObj,
        createdBy: bootstrap,
        schemaVersion: version,
      });
      await tx.query(
        'insert into org.role_assignment (id, subject_id, role_id, scope_id) values ($1,$2,$3,$4)',
        [id, subject, role, orgObj],
      );
      return id;
    };

    return {
      organizationId: orgObj,
      reviewerId,
      reviewerRoleId: await mkRole(reviewerId, 'technical_authority'),
      performerId,
      performerRoleId: await mkRole(performerId, 'performer'),
      schemaVersion: version,
    };
  });
}

/** Create a domain object in a given lifecycle state, attributed to `createdBy`. */
export async function createObject(
  pool: Pool,
  f: Fixtures,
  spec: { type: string; domain: string; state: string; title: string; createdBy: string },
): Promise<string> {
  return withTransaction(pool, async (tx) => {
    await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
    await tx.query('select core.set_transaction_context($1, $1, $2, $3)', [
      spec.createdBy,
      BOOTSTRAP_ACTION,
      'harness-fixture',
    ]);
    return newObject(tx, {
      ...spec,
      org: f.organizationId,
      schemaVersion: f.schemaVersion,
    });
  });
}

/**
 * Bind both contexts on a raw transaction.
 *
 * Tests that write directly — to prove a specific constraint fires — still have to satisfy
 * the write guard first, exactly as any other caller would. Without this they fail with
 * "no transaction context", which is the guard working but hides the constraint under test.
 */
export async function bindContext(
  tx: Tx,
  f: Fixtures,
  actorId: string = f.performerId,
): Promise<void> {
  await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
  await tx.query('select core.set_transaction_context($1, $1, $2, $3)', [
    actorId,
    BOOTSTRAP_ACTION,
    'harness-direct-write',
  ]);
}
