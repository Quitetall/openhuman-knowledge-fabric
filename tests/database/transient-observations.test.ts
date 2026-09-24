import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@kf/database';
import type { MasterRecordBoundaryRegistry } from '../../packages/documents/src/master-record-boundary.js';
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
 * Recorded queries, the demand aggregate, and what "transient" means in the database (§64B,
 * ADR 0029, KF-SAS-RQ-219 to RQ-221, RQ-223).
 */

const REGISTRY = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '..', '..', 'docs', 'architecture', 'master-record-boundary.json'),
    'utf8',
  ),
) as MasterRecordBoundaryRegistry;

/** A column name that would say who somebody is. */
const PERSON_COLUMN = /(?:person|actor|subject|user|principal|asker)(?:_id)?$|(?:^|_)by$|^who$/u;

let h: Harness;
let f: Fixtures;
let restrictedMatch: string;
let restrictedOther: string;
let internalMatch: string;

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  const make = (title: string) =>
    createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title,
      createdBy: f.performerId,
    });
  restrictedMatch = await make('Tantalum capacitor second source pricing');
  restrictedOther = await make('Board layout review minutes');
  internalMatch = await make('Tantalum capacitor derating guideline');
  await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f);
    for (const id of [restrictedMatch, restrictedOther]) {
      await tx.query(
        `update core.object set classification = 'restricted', row_version = row_version + 1 where id = $1`,
        [id],
      );
    }
    for (const id of [restrictedMatch, restrictedOther, internalMatch]) {
      await tx.query('select search.index_object($1)', [id]);
    }
  });
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

async function recordAs(actorId: string, ceiling: string, text: string): Promise<string> {
  return withTransaction(h.pool, async (tx) => {
    await bindReader(tx, f, actorId, ceiling);
    return (await tx.one<{ id: string }>('select search.record_query($1) as id', [text])).id;
  });
}

async function replayAs(actorId: string, recordedQuery: string, ids: string[]): Promise<number> {
  return withTransaction(h.pool, async (tx) => {
    await bindReader(tx, f, actorId, 'restricted');
    return (
      await tx.one<{ counted: number }>('select search.record_demand($1, $2::uuid[]) as counted', [
        recordedQuery,
        ids,
      ])
    ).counted;
  });
}

async function columns(table: string): Promise<{ name: string; type: string }[]> {
  const [schema, name] = table.split('.');
  return withTransaction(h.adminPool, (tx) =>
    tx.query<{ name: string; type: string }>(
      `select column_name as name, data_type as type from information_schema.columns
        where table_schema = $1 and table_name = $2 order by ordinal_position`,
      [schema, name],
    ),
  );
}

describe('recorded queries name no person (KF-SAS-RQ-221)', () => {
  it('records the query with a pseudonymous key the application cannot read', async () => {
    const id = await recordAs(f.performerId, 'internal', 'tantalum capacitor');
    const seen = await withTransaction(h.pool, async (tx) => {
      await bindReader(tx, f, f.reviewerId, 'restricted');
      return tx.one<{ query_text: string; asker_ceiling: string }>(
        'select query_text, asker_ceiling from search.recorded_query where id = $1',
        [id],
      );
    });
    expect(seen).toEqual({ query_text: 'tantalum capacitor', asker_ceiling: 'internal' });

    await expect(
      withTransaction(h.pool, async (tx) => {
        await bindReader(tx, f, f.reviewerId, 'restricted');
        return tx.query('select asker_key from search.recorded_query');
      }),
      'reading the log with attribution is its own act, and no application login performs it',
    ).rejects.toThrow(/permission denied/);

    for (const column of await columns('search.recorded_query')) {
      expect(column.name, 'a recorded query must not name who asked').not.toMatch(PERSON_COLUMN);
    }
  });

  it('refuses a direct write: every row comes through the seam', async () => {
    await expect(
      withTransaction(h.pool, async (tx) => {
        await bindReader(tx, f);
        await tx.query(
          `insert into search.recorded_query (organization_id, query_text, asker_ceiling, asker_rank, asker_key)
           values ($1, 'x', 'public', 0, '\\x00'::bytea)`,
          [f.organizationId],
        );
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it('hides a query asked at a higher ceiling from a reader cleared lower', async () => {
    const id = await recordAs(f.reviewerId, 'restricted', 'second source pricing');
    const rows = await withTransaction(h.pool, async (tx) => {
      await bindReader(tx, f, f.performerId, 'internal');
      return tx.query('select id from search.recorded_query where id = $1', [id]);
    });
    expect(rows).toEqual([]);
  });
});

describe('the demand aggregate counts distinct persons, never which (KF-SAS-RQ-221)', () => {
  it('has no column that identifies a person, and no reference to one', async () => {
    const shape = await columns('org.access_demand');
    expect(shape.map((column) => column.name)).toEqual([
      'object_id',
      'organization_id',
      'distinct_person_count',
      'first_counted_at',
      'last_counted_at',
    ]);
    for (const column of shape) expect(column.name).not.toMatch(PERSON_COLUMN);
    const references = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ target: string }>(
        `select confrelid::regclass::text as target from pg_constraint
          where conrelid = 'org.access_demand'::regclass and contype = 'f'`,
      ),
    );
    expect(references.map((row) => row.target)).toEqual(['core.object']);
  });

  it('counts two askers twice and one asker asking twice once', async () => {
    const first = await recordAs(f.performerId, 'internal', 'tantalum capacitor');
    const again = await recordAs(f.performerId, 'internal', 'tantalum capacitor');
    const second = await recordAs(f.reviewerId, 'internal', 'tantalum capacitor');

    // The replayer offers a matching restricted record, a restricted record that does not match,
    // and a matching record the asker's own ceiling already reached. Only the first counts.
    const offered = [restrictedMatch, restrictedOther, internalMatch];
    expect(await replayAs(f.reviewerId, first, offered)).toBe(1);
    expect(await replayAs(f.reviewerId, again, offered), 'the same person asking again').toBe(0);
    expect(await replayAs(f.reviewerId, second, offered)).toBe(1);

    const aggregate = await withTransaction(h.pool, async (tx) => {
      await bindReader(tx, f, f.reviewerId, 'restricted');
      return tx.query<{ object_id: string; distinct_person_count: number }>(
        'select object_id, distinct_person_count from org.access_demand order by object_id',
      );
    });
    expect(aggregate).toEqual([{ object_id: restrictedMatch, distinct_person_count: 2 }]);
  });

  it('shows a demand count only to a reader who can see the record', async () => {
    const rows = await withTransaction(h.pool, async (tx) => {
      await bindReader(tx, f, f.performerId, 'internal');
      return tx.query('select object_id from org.access_demand');
    });
    expect(rows, 'a count about a record says the record exists').toEqual([]);
  });
});

describe('transient observations expire (KF-SAS-RQ-220)', () => {
  it('states the declared window as each table’s expiry default', async () => {
    for (const { table, expiry } of REGISTRY.transientTables ?? []) {
      const [schema, name] = table.split('.');
      const row = await withTransaction(h.adminPool, (tx) =>
        tx.one<{ expr: string }>(
          `select pg_get_expr(d.adbin, d.adrelid) as expr
             from pg_attrdef d
             join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
            where d.adrelid = format('%I.%I', $1::text, $2::text)::regclass
              and a.attname = 'expires_at'`,
          [schema, name],
        ),
      );
      expect(row.expr, table).toContain(`'${expiry}'::interval`);
    }
  });

  it('sweeps every declared transient table, removing the expired rows and keeping the rest', async () => {
    const kept = await recordAs(f.performerId, 'internal', 'kept query');
    const expired = await recordAs(f.performerId, 'internal', 'expired query');
    await withTransaction(h.pool, async (tx) => {
      await bindReader(tx, f);
      await tx.query('select retrieval.record_disclosure($1, 3, 0)', ['sha256:0123456789abcdef']);
    });
    await withTransaction(h.adminPool, async (tx) => {
      await tx.query(
        `update search.recorded_query
            set recorded_at = now() - interval '91 days', expires_at = now() - interval '1 day'
          where id = $1`,
        [expired],
      );
      await tx.query(
        `update retrieval.disclosure
            set recorded_at = now() - interval '91 days', expires_at = now() - interval '1 day'`,
      );
    });

    const swept = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ table_name: string; removed: string }>(
        'select table_name, removed::text from core.sweep_transient_observations()',
      ),
    );
    expect(swept.map((row) => row.table_name).sort()).toEqual(
      (REGISTRY.transientTables ?? []).map((entry) => entry.table).sort(),
    );
    expect(Number(swept.find((row) => row.table_name === 'search.recorded_query')?.removed)).toBe(
      1,
    );
    expect(Number(swept.find((row) => row.table_name === 'retrieval.disclosure')?.removed)).toBe(1);

    const remaining = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ id: string }>('select id from search.recorded_query where id = any($1::uuid[])', [
        [kept, expired],
      ]),
    );
    expect(remaining.map((row) => row.id)).toEqual([kept]);
  });

  it('lets the worker, and not the application, run the sweep', async () => {
    const grants = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ worker: boolean; app: boolean }>(
        `select has_function_privilege('kf_worker', 'core.sweep_transient_observations()', 'execute') as worker,
                has_function_privilege('kf_app', 'core.sweep_transient_observations()', 'execute') as app`,
      ),
    );
    expect(grants).toEqual({ worker: true, app: false });
  });
});

describe('the retrieval schema holds no authorization input (KF-SAS-RQ-214, RQ-223)', () => {
  it('has no bitmap, mask or scope column anywhere', async () => {
    const rows = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ table_name: string; column_name: string; data_type: string }>(
        `select table_name, column_name, data_type from information_schema.columns
          where table_schema = 'retrieval' order by table_name, ordinal_position`,
      ),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const where = `retrieval.${row.table_name}.${row.column_name}`;
      expect(['bit', 'bit varying', 'bytea'], where).not.toContain(row.data_type);
      expect(row.column_name, where).not.toMatch(
        /bitmap|mask|bits|band(?!_version)|ceiling|coverage|scope|allow|deny|clearance/u,
      );
    }
  });

  it('records a disclosure digest with no person column (KF-SAS-RQ-219)', async () => {
    for (const column of await columns('retrieval.disclosure')) {
      expect(column.name).not.toMatch(PERSON_COLUMN);
    }
  });
});
