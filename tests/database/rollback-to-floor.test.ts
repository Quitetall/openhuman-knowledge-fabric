/**
 * Every reversible migration's down section runs, newest first, down to the forward-only floor —
 * what `migrate-release.sh rehearse-rollback` does on a host before it will sign a receipt.
 *
 * Found by the first rehearsal of the VPS install (KF-WAR-0001, 2026-10-07): the rehearsal on a
 * fresh disposable cluster rolled back two migrations and died on the third,
 * `20261007400000_qualification_is_evidence_against_a_versioned_pack`, with `cannot drop table
 * org.qualification_credit because other objects depend on it` — `qualification_record_read`, a
 * policy on ANOTHER table, reads the credit table, and the down section dropped tables without
 * dropping it. No release cut since that migration landed could produce a rollback receipt, so
 * no host could apply it: `kf-migrate.service` refuses without one. Nothing here ran down
 * sections in sequence; `migration-reversibility.test.ts` checks their declarations statically,
 * and the few probes in `fresh-install.test.ts` reverse single migrations by hand.
 *
 * This is the rehearsal's own loop on a bare database: every up section in its own transaction
 * (as dbmate applies them), the generated ontology seed (the rehearsal seeds before reverting),
 * then every down section above the floor, each in its own transaction, each named when it
 * fails. What it does not cover: dbmate itself (fresh-install.test.ts runs it), and whether a
 * down section restores the exact prior schema — only that it runs and the next one can.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, describe, expect, it } from 'vitest';
import { createPool, withTransaction, type Pool } from '@kf/database';
import { POSTGRES_INITDB_ARGS } from './harness.js';

const ROOT = join(import.meta.dirname, '..', '..');
const MIGRATIONS = join(ROOT, 'database', 'migrations');
const SEED = join(ROOT, 'generated', 'sql-registry', '001-ontology-seed.sql');

function section(sql: string, which: 'up' | 'down'): string {
  const up = sql.indexOf('-- migrate:up');
  const down = sql.indexOf('-- migrate:down');
  if (up < 0 || down < 0) throw new Error('migration lacks an up or a down section');
  return which === 'up' ? sql.slice(up + '-- migrate:up'.length, down) : sql.slice(down);
}

/** The same declaration `migrate-release.sh` reads: a reason must follow the marker. */
const FORWARD_ONLY = /^-- kf:forward-only \S/m;

const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const floorIndex = files.reduce(
  (floor, file, index) =>
    FORWARD_ONLY.test(section(readFileSync(join(MIGRATIONS, file), 'utf8'), 'down'))
      ? index
      : floor,
  -1,
);

let container: StartedPostgreSqlContainer | undefined;
let pool: Pool | undefined;

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('the rollback rehearsal, on a bare database', () => {
  it('has a floor and something above it to revert', () => {
    expect(floorIndex).toBeGreaterThanOrEqual(0);
    expect(files.length - 1 - floorIndex).toBeGreaterThan(0);
  });

  it('reverts every migration above the forward-only floor, newest first', async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('rollback_rehearsal')
      .withUsername('kf_owner')
      .withPassword('test-only-not-a-secret')
      .withEnvironment({ POSTGRES_INITDB_ARGS })
      .withCommand(['postgres', '-c', 'jit=off'])
      .start();
    pool = createPool({ connectionString: container.getConnectionUri(), maxConnections: 2 });
    const db = pool;
    await withTransaction(db, (tx) =>
      tx.query('create table public.schema_migrations (version varchar primary key)'),
    );
    for (const file of files) {
      await withTransaction(db, async (tx) => {
        await tx.query(section(readFileSync(join(MIGRATIONS, file), 'utf8'), 'up'));
        await tx.query('insert into public.schema_migrations (version) values ($1)', [
          file.split('_')[0]!,
        ]);
      });
    }
    await withTransaction(db, (tx) =>
      tx.query(readFileSync(SEED, 'utf8').replace(/^begin;$|^commit;$/gm, '')),
    );

    const failures: string[] = [];
    for (const file of files.slice(floorIndex + 1).reverse()) {
      try {
        await withTransaction(db, async (tx) => {
          await tx.query(section(readFileSync(join(MIGRATIONS, file), 'utf8'), 'down'));
          await tx.query('delete from public.schema_migrations where version = $1', [
            file.split('_')[0]!,
          ]);
        });
      } catch (error) {
        // The first failure stops the loop, as it stops the rehearsal: every later down would
        // run against a schema the failed one was supposed to have removed.
        failures.push(`${file}: ${(error as Error).message}`);
        break;
      }
    }
    expect(failures).toEqual([]);

    const top = await withTransaction(db, (tx) =>
      tx.one<{ version: string }>('select max(version) as version from public.schema_migrations'),
    );
    expect(top.version).toBe(files[floorIndex]!.split('_')[0]);
  }, 600_000);
});
