/**
 * The install nobody tests until the day they need it.
 *
 * Every other database test starts from `startHarness()`, which creates extensions before
 * applying migrations — and the restore script creates them too. So every path anybody
 * exercised worked, while `dbmate up` against a genuinely fresh database failed at the org
 * migration on `data type uuid has no default operator class for access method "gist"`.
 *
 * A dependency satisfied by every harness except the real one is the kind that gets
 * discovered during an install, by whoever is least equipped to diagnose it. This test is a
 * bare container and the migration directory, and nothing else.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, describe, expect, it } from 'vitest';
import { createPool, withTransaction, type Pool } from '@kf/database';

const ROOT = join(import.meta.dirname, '..', '..');
const MIGRATIONS = join(ROOT, 'database', 'migrations');

function upSection(sql: string): string {
  const start = sql.indexOf('-- migrate:up');
  const end = sql.indexOf('-- migrate:down');
  if (start < 0) throw new Error('migration has no -- migrate:up section');
  return sql.slice(start + '-- migrate:up'.length, end < 0 ? undefined : end);
}

let container: StartedPostgreSqlContainer | undefined;
let pool: Pool | undefined;

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('a completely fresh database', () => {
  it('applies every migration with NOTHING pre-created', async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('fresh_install')
      .withUsername('kf_owner')
      .withPassword('test-only-not-a-secret')
      .start();
    pool = createPool({ connectionString: container.getConnectionUri(), maxConnections: 2 });

    // No `create extension`, no seed, no fixtures. Exactly what an operator gets.
    const applied: string[] = [];
    for (const file of readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      const sql = upSection(readFileSync(join(MIGRATIONS, file), 'utf8'));
      await withTransaction(pool, async (tx) => {
        await tx.query(sql);
      });
      applied.push(file);
    }
    expect(applied.length).toBeGreaterThan(15);
  }, 300_000);

  it('created the extensions the schema depends on', async () => {
    const rows = await withTransaction(pool!, async (tx) =>
      tx.query<{ extname: string }>(
        "select extname from pg_extension where extname in ('btree_gist', 'pg_trgm') order by extname",
      ),
    );
    // btree_gist: scalar types inside the GiST exclusion that refuses overlapping role
    // assignments. pg_trgm: the partial-identifier index.
    expect(rows.map((r) => r.extname)).toEqual(['btree_gist', 'pg_trgm']);
  });

  it('the constraint that needed btree_gist actually exists', async () => {
    // Not just "the extension is present" — the thing it was needed for.
    const row = await withTransaction(pool!, async (tx) =>
      tx.one<{ n: string }>(
        `select count(*)::text as n from pg_constraint
          where conname like '%role_assignment%' and contype = 'x'`,
      ),
    );
    expect(Number(row.n)).toBeGreaterThan(0);
  });
});
