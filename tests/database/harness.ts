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

import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { auditChainDigest, GENESIS_DIGEST } from '@kf/canonicalization';
import { createPool, withTransaction, type Pool, type Tx } from '@kf/database';

const ROOT = join(import.meta.dirname, '..', '..');
const MIGRATIONS = join(ROOT, 'database', 'migrations');
const SEED = join(ROOT, 'generated', 'sql-registry', '001-ontology-seed.sql');
export const POSTGRES_INITDB_ARGS =
  '--locale-provider=builtin --builtin-locale=C.UTF-8 --encoding=UTF8';

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

export interface HarnessOptions {
  /**
   * Migration filenames to leave unapplied.
   *
   * Exists for one purpose: comparing the schema a migration produces against the schema
   * without it. A test that wants to prove a migration changed only what it claims has to be
   * able to observe both sides, and applying-then-reversing observes the reversal instead —
   * which is the thing under suspicion.
   */
  readonly skipMigrations?: ReadonlySet<string>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:18-alpine')
    .withDatabase('kf_test')
    .withUsername('kf_owner')
    .withPassword('test-only-not-a-secret')
    // Matches Compose: a libc collation change silently reorders text indexes, so every
    // database path has to initialize with the same provider and locale.
    .withEnvironment({ POSTGRES_INITDB_ARGS })
    // Planner-affecting settings must match docker-compose.yml, or every timing measured here
    // describes a server nobody runs. `jit=off` in particular: RLS inflates cost estimates far
    // past jit_above_cost, and leaving JIT on made a 16ms count take 154ms. Enforced by
    // tests/deployment/postgres-settings-parity.test.ts.
    .withCommand([
      'postgres',
      '-c',
      'wal_level=logical',
      '-c',
      'track_commit_timestamp=on',
      '-c',
      'jit=off',
    ])
    .start();

  const connectionString = container.getConnectionUri();
  const adminPool = createPool({ connectionString, maxConnections: 5 });

  const databaseLocale = await withTransaction(adminPool, (tx) =>
    tx.one<{ provider: string; locale: string; encoding: string }>(
      `select datlocprovider as provider,
              datlocale as locale,
              pg_encoding_to_char(encoding) as encoding
         from pg_database
        where datname = current_database()`,
    ),
  );
  if (
    databaseLocale.provider !== 'b' ||
    databaseLocale.locale !== 'C.UTF-8' ||
    databaseLocale.encoding !== 'UTF8'
  ) {
    const mismatch = new Error(
      `PostgreSQL test harness locale mismatch: ${JSON.stringify(databaseLocale)}`,
    );
    await adminPool.end().catch(() => undefined);
    await container.stop().catch(() => undefined);
    throw mismatch;
  }

  await withTransaction(adminPool, async (tx) => {
    await tx.query('create extension if not exists btree_gist');
  });

  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => !options.skipMigrations?.has(f))
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
  /** Recorded bootstrap action that anchors fixture clearance grants. */
  readonly clearanceActionId: string;
  readonly schemaVersion: string;
}

export interface TestLiminalCompilerIdentity {
  readonly name: string;
  readonly version: string;
  readonly protocol: 'kf-document-v1';
  readonly commitSha: string;
  readonly cargoLockDigest: string;
  readonly executableDigest: string;
  readonly runtimeClosureDigest: string;
  readonly qualification: {
    readonly state: 'not_run' | 'incomplete' | 'unratified' | 'qualified';
    readonly receiptDigest: string | null;
    readonly ratified: boolean;
  };
}

/** Owner-only fixture seam. Production deliberately has no default compiler registration. */
export async function registerTestDocumentCompiler(
  pool: Pool,
  identity: TestLiminalCompilerIdentity,
  registeredBy: string = BOOTSTRAP_IDENTITY,
): Promise<string> {
  return withTransaction(pool, async (tx) => {
    const row = await tx.one<{ id: string }>(
      `insert into content.document_compiler_registration
         (compiler_name, compiler_version, protocol, liminal_commit_sha, cargo_lock_digest,
          executable_digest, runtime_closure_digest, qualification_state,
          qualification_receipt_digest, qualification_ratified, registered_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       returning id`,
      [
        identity.name,
        identity.version,
        identity.protocol,
        identity.commitSha,
        identity.cargoLockDigest,
        identity.executableDigest,
        identity.runtimeClosureDigest,
        identity.qualification.state,
        identity.qualification.receiptDigest,
        identity.qualification.ratified,
        registeredBy,
      ],
    );
    return row.id;
  });
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
export interface SeedFixtureOptions {
  /**
   * Record the fixture clearance grant in the global audit chain. Most integration tests want
   * this production-shaped authority evidence; ledger/export tests that build their own chain
   * can opt out so their first event still starts at genesis.
   */
  readonly auditClearance?: boolean;
}

export async function seedFixtures(
  pool: Pool,
  options: SeedFixtureOptions = {},
): Promise<Fixtures> {
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

    // THIS DEPLOYMENT'S ALLOCATED NAMESPACES. Since 2026-08-22 `core.object.enterprise_id` is
    // checked in two independent layers: an immutable CHECK for shape and Damm digit, and a
    // foreign key to `registry.identifier_namespace` for whether the namespace was allocated at
    // all (ADR 0006 — the prefix is instance policy, not product data). The migration creates
    // that table EMPTY on purpose, so a fixture that allocates an identifier must say which
    // namespaces this instance has, exactly as a real deployment seeds them from its registry.
    //
    // Without this every test that writes an enterprise_id fails on the foreign key, which is
    // the correct behaviour and a confusing way to discover it.
    await tx.query(
      `insert into registry.identifier_namespace (qualified_code, grammar) values
         ('OH-ITM','enterprise'),  ('OH-DOC','enterprise'),  ('OH-INTF','enterprise'),
         ('OH-BIND','enterprise'), ('OH-SWC','enterprise'),  ('OH-DAT','enterprise'),
         ('OH-MDL','enterprise'),  ('OH-REQ','enterprise'),  ('OH-RSK','enterprise'),
         ('OH-TST','enterprise'),  ('OH-CHG','enterprise'),  ('OH-ADR','enterprise'),
         ('OH-BSL','enterprise'),  ('OH-RLS','enterprise'),  ('OH-QEV','enterprise'),
         ('OH-EQP','enterprise'),  ('OH-SUP','enterprise'),  ('OH-LOT','enterprise'),
         ('OH-WRK','enterprise'),  ('OH-RCD','record'),      ('OH-SN','serial')
       on conflict (qualified_code) do nothing`,
    );

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

    const reviewerRoleId = await mkRole(reviewerId, 'technical_authority');
    const performerRoleId = await mkRole(performerId, 'performer');
    // One recorded bootstrap action anchors clearance facts in the same immutable action
    // chain production uses. The fixture grants both people restricted clearance so identity
    // tests exercise the resolver rather than failing for an unseeded policy.
    const clearanceAction = randomUUID();
    const clearanceEffectiveAt = new Date().toISOString();
    const clearanceIdempotencyKey = `fixture-clearance-${orgObj}`;
    await tx.query(
      `insert into core.action
         (id, organization_id, request_digest, action_type, actor_id, acting_role_id,
          target_ids, parameters, preconditions, idempotency_key, effective_at,
          reason, result_status, result)
       values ($1, $2, encode(public.digest(convert_to('kf-fixture-clearance', 'UTF8'), 'sha256'), 'hex'),
               'create_initiative', $3, $4, array[$2]::uuid[], '{}'::jsonb, '{}'::jsonb,
               $5, $6,
               'fixture clearance authority', 'applied', '{}'::jsonb)`,
      [
        clearanceAction,
        orgObj,
        reviewerId,
        reviewerRoleId,
        clearanceIdempotencyKey,
        clearanceEffectiveAt,
      ],
    );
    if (options.auditClearance ?? true) {
      const previousAudit = await tx.maybeOne<{ digest: string }>(
        'select digest from core.audit_event order by seq desc limit 1',
      );
      const previousDigest = previousAudit?.digest ?? GENESIS_DIGEST;
      const clearanceAuditDigest = auditChainDigest(previousDigest, {
        action_id: clearanceAction,
        action_type: 'create_initiative',
        actor_id: reviewerId,
        acting_role_id: reviewerRoleId,
        object_ids: [orgObj],
        effective_at: clearanceEffectiveAt,
        before_digest: null,
        after_digest: null,
      });
      await tx.query(
        `insert into core.audit_event
           (action_id, actor_id, acting_role_id, action_type, object_id, effective_at, reason,
            prev_digest, digest)
         values ($1,$2,$3,'create_initiative',$4,$5,'fixture clearance authority',$6,$7)`,
        [
          clearanceAction,
          reviewerId,
          reviewerRoleId,
          orgObj,
          clearanceEffectiveAt,
          previousDigest,
          clearanceAuditDigest,
        ],
      );
    }
    await tx.query(
      `insert into org.person_clearance
         (subject_id, organization_id, max_classification, granted_by, granted_by_action, reason)
       values ($1, $3, 'restricted', $2, $4, 'fixture clearance') ,
              ($5, $3, 'restricted', $2, $4, 'fixture clearance')`,
      [reviewerId, reviewerId, orgObj, clearanceAction, performerId],
    );

    return {
      organizationId: orgObj,
      reviewerId,
      reviewerRoleId,
      performerId,
      performerRoleId,
      clearanceActionId: clearanceAction,
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
