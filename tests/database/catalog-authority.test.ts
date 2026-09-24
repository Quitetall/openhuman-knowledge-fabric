import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction, type Pool, type Tx } from '@kf/database';
import { buildBandBitmaps, currentBandVersion } from '@kf/retrieval';
import {
  bindContext,
  bindReader,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

/**
 * What the catalog itself says about authority (SAS §35–§38, §41, §71).
 *
 * Each block reads the running database — pg_namespace, pg_class, pg_trigger, pg_constraint,
 * role membership — and holds it to a statement the SAS makes, then plants the case the
 * statement exists to refuse and requires the refusal. A catalog check alone would pass on a
 * constraint that exists and never fires; a planted write alone would pass on an empty table.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const MIGRATIONS = join(ROOT, 'database', 'migrations');
const SAS = join(ROOT, 'docs', 'sas', 'KF_Software_Architecture_Specification.md');

/** Schemas PostgreSQL or its extensions own. `public` holds the extensions' functions only. */
const SYSTEM_SCHEMA = `n.nspname not in ('pg_catalog', 'information_schema', 'public')
                       and n.nspname !~ '^pg_'`;

let h: Harness;
let f: Fixtures;

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

async function owner<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  return withTransaction(h.adminPool, work);
}

/** Thrown to roll back a statement that was accepted, so a failed check never commits it. */
class Accepted extends Error {}

/**
 * The error a statement raised, or undefined if it succeeded. Always rolled back: a statement
 * that should have been refused and was not must not leave its effect behind for the next test.
 */
async function refusal(
  pool: Pool,
  sql: string,
  prepare?: (tx: Tx) => Promise<unknown>,
): Promise<
  { code?: string | undefined; message: string; constraint?: string | undefined } | undefined
> {
  try {
    await withTransaction(pool, async (tx) => {
      await prepare?.(tx);
      await tx.query(sql);
      throw new Accepted(sql);
    });
  } catch (error: unknown) {
    if (error instanceof Accepted) return undefined;
    const e = error as {
      code?: string | undefined;
      message: string;
      constraint?: string | undefined;
    };
    return { code: e.code, message: e.message, constraint: e.constraint };
  }
  return undefined;
}

/**
 * PostgreSQL refuses TRUNCATE of a table another table references before any trigger runs, so
 * for those tables the owner meets that refusal first. The trigger's presence is asserted from
 * the catalog separately; either way the rows survive.
 */
const OWNER_REFUSAL = /append-only|not permitted|cannot truncate a table referenced/;

// ── RQ-071: each schema names one authority domain ─────────────────────────────────────────

/** The schema column of SAS §36's table, in the order the SAS lists it. */
function sasSchemaTable(): string[] {
  const sas = readFileSync(SAS, 'utf8');
  const start = sas.indexOf('## 36. Schemas as authority boundaries');
  const end = sas.indexOf('## 37.', start);
  expect(start, 'SAS §36 not found').toBeGreaterThanOrEqual(0);
  return [...sas.slice(start, end).matchAll(/^\| `([a-z_]+)` \|/gmu)].map((m) => m[1]!);
}

describe('every schema names its authority domain (KF-SAS-RQ-071)', () => {
  it('has exactly the schemas SAS §36 lists, each carrying a comment that names its domain', async () => {
    const table = sasSchemaTable();
    expect(table.length, 'the SAS table was not parsed').toBeGreaterThanOrEqual(14);
    const schemas = await owner((tx) =>
      tx.query<{ schema: string; comment: string | null }>(
        `select n.nspname as schema, obj_description(n.oid, 'pg_namespace') as comment
           from pg_namespace n where ${SYSTEM_SCHEMA} order by 1`,
      ),
    );
    expect(schemas.map((s) => s.schema)).toEqual([...table].sort());
    const uncommented = schemas.filter((s) => s.comment === null || s.comment.trim() === '');
    expect(
      uncommented.map((s) => s.schema),
      'schemas with no authority comment',
    ).toEqual([]);
    // One domain each: an authority names what it owns; a derived schema says it is not one.
    for (const { schema, comment } of schemas) {
      expect(comment, schema).toMatch(/^(?:Authority: |Derived, not an authority: )/u);
    }
    expect(schemas.filter((s) => s.comment!.startsWith('Derived')).map((s) => s.schema)).toEqual([
      'retrieval',
      'search',
    ]);
  });

  it('reconstructs the derived band version from authoritative rows alone', async () => {
    const make = (title: string) =>
      createObject(h.adminPool, f, {
        type: 'decision_record',
        domain: 'engineering',
        state: 'draft',
        title,
        createdBy: f.performerId,
      });
    const slots = { generation: 'catalog-authority-1', objectIds: [await make('Band A')] };
    const build = () =>
      withTransaction(h.pool, async (tx) => {
        await bindReader(tx, f);
        return buildBandBitmaps(tx, f.organizationId, slots);
      });
    const before = await build();
    expect(before.bandVersion).toMatch(/^[0-9a-f-]{36}\.[1-9][0-9]*$/);

    // Lose the derived table entirely, as a restore that excludes it does.
    await owner((tx) => tx.query('delete from retrieval.band_version'));

    // Membership is re-derived from core.object, so nothing a reader sees depends on the row.
    const rebuilt = await build();
    expect(rebuilt.bands).toEqual(before.bands);
    expect(rebuilt.unresolved).toEqual(before.unresolved);
    // With no row there is no version to cache on: the token is fresh on every build.
    expect(rebuilt.bandVersion).toMatch(/^unversioned\./);
    expect((await build()).bandVersion).not.toBe(rebuilt.bandVersion);

    // And the next band-moving write re-creates the row, under a new epoch.
    await make('Band B');
    const version = await withTransaction(h.pool, async (tx) => {
      await bindReader(tx, f);
      return currentBandVersion(tx, f.organizationId);
    });
    expect(version).toMatch(/\.1$/);
    expect(version.split('.')[0]).not.toBe(before.bandVersion.split('.')[0]);
  });
});

// ── RQ-070: an undeclared token fails a referential constraint ─────────────────────────────

describe('an undeclared ontology token fails a foreign key (KF-SAS-RQ-070)', () => {
  const declared = [
    ['core.object', 'object_type', 'registry.object_type'],
    ['core.relation', 'relation_type', 'registry.relation_type'],
    ['core.action', 'action_type', 'registry.action_type'],
  ] as const;

  it.each(declared)('%s.%s references %s', async (table, column, target) => {
    const keys = await owner((tx) =>
      tx.query<{ target: string }>(
        `select c.confrelid::regclass::text as target
           from pg_constraint c
          where c.conrelid = $1::regclass and c.contype = 'f'
            and (select array_agg(a.attname::text order by a.attnum) from pg_attribute a
                  where a.attrelid = c.conrelid and a.attnum = any(c.conkey)) = array[$2]`,
        [table, column],
      ),
    );
    expect(keys.map((k) => k.target)).toContain(target);
  });

  async function refuseUndeclared(sql: string, params: unknown[]) {
    try {
      await withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f);
        await tx.query(sql, params);
        throw new Accepted(sql);
      });
    } catch (error: unknown) {
      if (error instanceof Accepted) {
        throw new Error('the undeclared token was accepted', { cause: error });
      }
      return error as { code?: string; constraint?: string; message: string };
    }
    throw new Error('unreachable');
  }

  it('refuses an undeclared object type', async () => {
    const e = await refuseUndeclared(
      `insert into core.object
         (object_type, authority_domain, lifecycle_state, classification, retention_class,
          schema_version, organization_id, title, created_by, updated_by)
       values ('no_such_object_type', 'engineering', 'draft', 'internal', 'project_record',
               $1, $2, 'Planted', $3, $3)`,
      [f.schemaVersion, f.organizationId, f.performerId],
    );
    expect(e.code, e.message).toBe('23503');
    expect(e.message).toMatch(/no_such_object_type|object_type|object_state_declared/);
  });

  it('refuses an undeclared relation type', async () => {
    const make = (title: string) =>
      createObject(h.adminPool, f, {
        type: 'decision_record',
        domain: 'engineering',
        state: 'draft',
        title,
        createdBy: f.performerId,
      });
    const [a, b] = [await make('Relation source'), await make('Relation target')];
    const e = await refuseUndeclared(
      `insert into core.relation (relation_type, source_id, target_id, created_by)
       values ('no_such_relation_type', $1, $2, $3)`,
      [a, b, f.performerId],
    );
    expect(e.code, e.message).toBe('23503');
    expect(e.constraint).toMatch(/relation_type/);
  });

  it('refuses an undeclared action type', async () => {
    const e = await refuseUndeclared(
      `insert into core.action
         (organization_id, request_digest, action_type, actor_id, acting_role_id, target_ids,
          idempotency_key, effective_at, result_status, result)
       values ($1, repeat('a', 64), 'no_such_action_type', $2, $3, array[$1]::uuid[],
               'planted-undeclared-action', date_trunc('milliseconds', now()), 'applied',
               '{}'::jsonb)`,
      [f.organizationId, f.performerId, f.performerRoleId],
    );
    // The foreign key specifically, not some other refusal that happens to fire first: an act
    // naming a type the registry does not declare is refused by the registry.
    expect(e.code, e.message).toBe('23503');
    expect(e.constraint).toMatch(/action_type/);
  });
});

// ── RQ-072: one role may change structure, and the application is not it ───────────────────

describe('only the migrator and the owner may create in a schema (KF-SAS-RQ-072)', () => {
  it('grants CREATE on no application schema to any role outside the owner and the migrator', async () => {
    const holders = await owner((tx) =>
      tx.query<{ schema: string; role: string }>(
        `select n.nspname as schema, r.rolname as role
           from pg_namespace n cross join pg_roles r
          where ${SYSTEM_SCHEMA}
            and not r.rolsuper
            and r.rolname !~ '^pg_'
            and has_schema_privilege(r.oid, n.oid, 'CREATE')
            and not pg_has_role(r.oid, n.nspowner, 'MEMBER')
            and not pg_has_role(r.oid, 'kf_migrator', 'MEMBER')
          order by 1, 2`,
      ),
    );
    expect(holders).toEqual([]);
    // The rule is not vacuous: the migrator really does hold CREATE on the domain schemas.
    const migrator = await owner((tx) =>
      tx.one<{ ok: boolean }>(`select has_schema_privilege('kf_migrator', 'core', 'CREATE') as ok`),
    );
    expect(migrator.ok).toBe(true);
  });

  it.each(['kf_app', 'kf_app_login', 'kf_dev_api_login', 'kf_storage_login', 'kf_attestor'])(
    '%s holds CREATE nowhere and is a member of neither the migrator nor any schema owner',
    async (role) => {
      const found = await owner((tx) =>
        tx.one<{ creates: string[]; migrator: boolean; owners: string[] }>(
          `select
             coalesce((select array_agg(n.nspname::text order by 1) from pg_namespace n
                        where ${SYSTEM_SCHEMA} and has_schema_privilege($1, n.oid, 'CREATE')),
                      '{}') as creates,
             pg_has_role($1, 'kf_migrator', 'MEMBER') as migrator,
             coalesce((select array_agg(distinct pg_get_userbyid(n.nspowner)::text) from pg_namespace n
                        where ${SYSTEM_SCHEMA} and pg_has_role($1, n.nspowner, 'MEMBER')),
                      '{}') as owners`,
          [role],
        ),
      );
      expect(found).toEqual({ creates: [], migrator: false, owners: [] });
    },
  );

  it('refuses the application a table of its own', async () => {
    const e = await refusal(h.pool, 'create table core.planted_by_the_application (id int)');
    expect(e?.code, e?.message).toBe('42501');
  });
});

// ── RQ-074 / RQ-186: the row-security set is derivable from the migrations ─────────────────

/** Tables the migrations bring under row security by literal statement, in apply order. */
function staticallyEnabled(): string[] {
  const enabled = new Set<string>();
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const text = readFileSync(join(MIGRATIONS, file), 'utf8');
    const up = text.slice(
      0,
      text.includes('-- migrate:down') ? text.indexOf('-- migrate:down') : undefined,
    );
    const code = up.replace(/--[^\n]*/gu, '');
    for (const m of code.matchAll(
      /\b(?:alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([a-z0-9_]+\.[a-z0-9_]+)\s+(enable|disable)\s+row\s+level\s+security|drop\s+table\s+(?:if\s+exists\s+)?([a-z0-9_]+\.[a-z0-9_]+))/giu,
    )) {
      if (m[3] !== undefined) enabled.delete(m[3].toLowerCase());
      else if (m[2]!.toLowerCase() === 'enable') enabled.add(m[1]!.toLowerCase());
      else enabled.delete(m[1]!.toLowerCase());
    }
  }
  return [...enabled].sort();
}

describe('the row-security set is declared literally (KF-SAS-RQ-074, RQ-186)', () => {
  it('equals, statement for statement, the tables the running database holds under it', async () => {
    const running = (
      await owner((tx) =>
        tx.query<{ table: string }>(
          `select n.nspname || '.' || c.relname as table
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where c.relkind in ('r', 'p') and c.relrowsecurity and ${SYSTEM_SCHEMA}
            order by 1`,
        ),
      )
    ).map((row) => row.table);
    const declared = staticallyEnabled();
    expect(declared.length).toBeGreaterThan(100);
    expect(
      running.filter((t) => !declared.includes(t)),
      'under row security, but by no statement the boundary registry can read',
    ).toEqual([]);
    expect(
      declared.filter((t) => !running.includes(t)),
      'declared in a migration, absent from the database',
    ).toEqual([]);
    // Forced = enabled, since 20260924000200 forces every enabled table; so the forced set is
    // derivable from the same statements (RQ-186).
    const forced = await owner((tx) =>
      tx.query<{ table: string }>(
        `select n.nspname || '.' || c.relname as table
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'p') and c.relforcerowsecurity and ${SYSTEM_SCHEMA}
          order by 1`,
      ),
    );
    expect(forced.map((row) => row.table)).toEqual(running);
  });
});

// ── RQ-077 / RQ-090: event records are immutable ───────────────────────────────────────────

/**
 * Records asserting that something happened. Each is refused UPDATE, DELETE and TRUNCATE by a
 * statement-level trigger, so the refusal holds with zero rows and for the owner, whom a
 * privilege does not bind. Extend this list when a new event record is added.
 */
const EVENT_RECORDS = [
  'core.action',
  'core.audit_event',
  'core.approval',
  'core.snapshot',
  'core.audit_checkpoint',
  'core.object_verification',
  'content.artifact_version',
  'content.artifact_relationship',
] as const;

const REFUSED = ['update', 'delete', 'truncate'] as const;
function mutation(verb: (typeof REFUSED)[number], table: string): string {
  if (verb === 'truncate') return `truncate ${table}`;
  if (verb === 'delete') return `delete from ${table}`;
  return `update ${table} set ${table === 'core.object_verification' ? 'basis = basis' : 'id = id'}`;
}

/** Tables whose statement-level BEFORE triggers cover update, delete and truncate. */
async function appendOnlyTables(schemaOrTables: string[]): Promise<Set<string>> {
  const rows = await owner((tx) =>
    tx.query<{ table: string }>(
      `select c.oid::regclass::text as table
         from pg_class c
        where c.oid::regclass::text = any($1::text[])
          and exists (select 1 from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal
                        and t.tgenabled <> 'D' and (t.tgtype & 2) <> 0 and (t.tgtype & 1) = 0
                        and (t.tgtype & 16) <> 0)
          and exists (select 1 from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal
                        and t.tgenabled <> 'D' and (t.tgtype & 2) <> 0 and (t.tgtype & 1) = 0
                        and (t.tgtype & 8) <> 0)
          and exists (select 1 from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal
                        and t.tgenabled <> 'D' and (t.tgtype & 32) <> 0)`,
      [schemaOrTables],
    ),
  );
  return new Set(rows.map((row) => row.table));
}

describe('a record that an event occurred cannot be changed (KF-SAS-RQ-077, RQ-090)', () => {
  it('carries a statement-level refusal of update, delete and truncate on every event record', async () => {
    const covered = await appendOnlyTables([...EVENT_RECORDS]);
    expect(EVENT_RECORDS.filter((t) => !covered.has(t))).toEqual([]);
  });

  it.each(EVENT_RECORDS.flatMap((table) => REFUSED.map((verb) => [table, verb] as const)))(
    'refuses %s %s to the application and to the owner',
    async (table, verb) => {
      const sql = mutation(verb, table);
      const asApp = await refusal(h.pool, sql, (tx) => bindContext(tx, f));
      expect(asApp, `kf_app ${sql}`).toBeDefined();
      expect(asApp!.message).toMatch(/permission denied|append-only/);
      // The owner, whom no privilege binds: only the trigger stands in the way.
      const asOwner = await refusal(h.adminPool, sql, (tx) =>
        tx.query('set local role kf_harness_owner'),
      );
      expect(asOwner, `owner ${sql}`).toBeDefined();
      expect(asOwner!.message).toMatch(verb === 'truncate' ? OWNER_REFUSAL : /append-only/);
    },
  );
});

// ── RQ-140: ML lineage is append-only ──────────────────────────────────────────────────────

describe('ML lineage is append-only (KF-SAS-RQ-140)', () => {
  let mlTables: string[] = [];
  beforeAll(async () => {
    mlTables = (
      await owner((tx) =>
        tx.query<{ table: string }>(
          `select c.oid::regclass::text as table from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'ml' and c.relkind in ('r', 'p') order by 1`,
        ),
      )
    ).map((row) => row.table);
  });

  it('guards every ml table with a statement-level update, delete and truncate refusal', async () => {
    expect(mlTables.length).toBeGreaterThanOrEqual(15);
    const covered = await appendOnlyTables(mlTables);
    expect(mlTables.filter((t) => !covered.has(t))).toEqual([]);
  });

  it('refuses update, delete and truncate on every ml table, to the owner', async () => {
    const accepted: string[] = [];
    for (const table of mlTables) {
      for (const verb of REFUSED) {
        const sql =
          verb === 'update'
            ? `update ${table} set ${await firstColumn(table)} = ${await firstColumn(table)}`
            : mutation(verb, table);
        const e = await refusal(h.adminPool, sql, (tx) =>
          tx.query('set local role kf_harness_owner'),
        );
        if (e === undefined || !OWNER_REFUSAL.test(e.message)) {
          accepted.push(`${sql}: ${e?.message ?? 'accepted'}`);
        }
      }
    }
    expect(accepted).toEqual([]);
  });

  async function firstColumn(table: string): Promise<string> {
    const row = await owner((tx) =>
      tx.one<{ name: string }>(
        `select quote_ident(attname) as name from pg_attribute
          where attrelid = $1::regclass and attnum > 0 and not attisdropped
          order by attnum limit 1`,
        [table],
      ),
    );
    return row.name;
  }
});
