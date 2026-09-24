import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTransaction, type Tx } from '@kf/database';
import { runDeclareServiceActor } from '../../apps/api/src/admin/declare-service-actor.js';
import {
  aYearFromNow,
  bindContext,
  bindReader,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

/**
 * Writes the application role can still make, closed in the database (threat model T2).
 *
 * Each test runs as `kf_app` — `h.pool`, the adversary — and each refusal was confirmed to be a
 * SUCCESS with its migration's up section removed before it was committed. The owner would pass
 * every one of them for the wrong reason.
 */
let h: Harness;
let f: Fixtures;
let steward: string;

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  steward = (
    await runDeclareServiceActor(h.adminPool, {
      validTo: aYearFromNow(),
      organizationId: f.organizationId,
      name: 'storage-steward',
      roleId: 'performer',
      classification: 'restricted',
      declaredBy: f.reviewerId,
      reason: 'replicates and re-verifies artifact copies on a timer',
    })
  ).personId;
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

const asApp = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withTransaction(h.pool, fn);
const asAdmin = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withTransaction(h.adminPool, fn);

describe('what a person is is the owner credential’s to write (20260925010000)', () => {
  const kindOf = async (person: string): Promise<string> =>
    (
      await asAdmin((tx) =>
        tx.one<{ person_kind: string }>('select person_kind from org.person where id = $1', [
          person,
        ]),
      )
    ).person_kind;

  it('refuses the application relabelling a service actor human', async () => {
    // The act bar (20260924000100) and the attestor read person_kind; a steward relabelled
    // `human` performs institutional acts.
    await expect(
      asApp(async (tx) => {
        await bindReader(tx, f, f.reviewerId);
        await tx.query(`update org.person set person_kind = 'human' where id = $1`, [steward]);
      }),
    ).rejects.toThrow(/permission denied|owner credential/);
    expect(await kindOf(steward)).toBe('service');
  });

  it('refuses the application relabelling a human as a service actor', async () => {
    // A `service` person is bound by the storage login with no attestation (20260924001000).
    await expect(
      asApp(async (tx) => {
        await bindReader(tx, f, f.reviewerId);
        await tx.query(`update org.person set person_kind = 'service' where id = $1`, [
          f.performerId,
        ]);
      }),
    ).rejects.toThrow(/permission denied|owner credential/);
    expect(await kindOf(f.performerId)).toBe('human');
  });

  it('refuses the application creating a person of either kind', async () => {
    for (const kind of ['human', 'service']) {
      await expect(
        asApp(async (tx) => {
          await bindReader(tx, f, f.reviewerId);
          await tx.query(
            `insert into org.person (id, display_name, organization, person_kind)
             values ($1, 'Minted', $2, $3)`,
            [randomUUID(), f.organizationId, kind],
          );
        }),
      ).rejects.toThrow(/permission denied|owner credential/);
    }
  });

  it('holds kind and organization even for a role later granted UPDATE on the table', async () => {
    // The trigger is the second line. Grant the whole table back, as a careless later migration
    // might, and the identity columns still refuse; a display name is then editable, so the
    // trigger is precise rather than a table that refuses everything.
    await withTransaction(h.adminPool, (tx) => tx.query('grant update on org.person to kf_app'));
    try {
      for (const [column, value] of [
        ['person_kind', 'human'],
        ['organization', randomUUID()],
      ] as const) {
        await expect(
          asApp(async (tx) => {
            await bindReader(tx, f, f.reviewerId);
            await tx.query(`update org.person set ${column} = $2 where id = $1`, [steward, value]);
          }),
        ).rejects.toThrow(/owner credential/);
      }
      const renamed = await asApp(async (tx) => {
        await bindReader(tx, f, f.reviewerId);
        return tx.query(
          `update org.person set display_name = 'Performer (renamed)' where id = $1 returning id`,
          [f.performerId],
        );
      });
      expect(renamed).toHaveLength(1);
    } finally {
      await withTransaction(h.adminPool, (tx) =>
        tx.query('revoke update on org.person from kf_app'),
      );
    }
    expect(await kindOf(steward)).toBe('service');
  });

  it('still lets the owner credential relabel, which is the path that exists', async () => {
    await withTransaction(h.adminPool, async (tx) => {
      await tx.query(`update org.person set person_kind = 'human' where id = $1`, [steward]);
      await tx.query(`update org.person set person_kind = 'service' where id = $1`, [steward]);
    });
    expect(await kindOf(steward)).toBe('service');
  });
});

describe('every write the application or the worker makes belongs to a recorded act (20260925011000)', () => {
  /**
   * The exemptions, pinned. Adding one is a decision a reviewer sees in this file, not a row that
   * appears in a migration and certifies itself.
   */
  const EXEMPT = [
    'content.master_record_link_access INSERT',
    'core.action INSERT',
    'core.audit_event INSERT',
    'core.outbox UPDATE',
    'quality.federated_reference UPDATE',
  ];

  const newCapa = async (): Promise<string> => {
    const id = await createObject(h.adminPool, f, {
      type: 'capa',
      domain: 'qms',
      state: 'open',
      title: 'Root cause under dispute',
      createdBy: f.performerId,
    });
    await asAdmin((tx) =>
      tx.query(
        `insert into quality.capa (id, capa_kind, problem_statement, effectiveness_criterion)
         values ($1, 'corrective', 'Nonconforming output', 'No recurrence in 90 days')`,
        [id],
      ),
    );
    return id;
  };
  const rootCauseOf = async (capa: string): Promise<string | null> =>
    (
      await asAdmin((tx) =>
        tx.one<{ root_cause: string | null }>('select root_cause from quality.capa where id = $1', [
          capa,
        ]),
      )
    ).root_cause;

  it('guards every table kf_app or kf_worker can write, except the pinned exemptions', async () => {
    const rows = await asAdmin((tx) =>
      tx.query<{ tbl: string; op: string; guarded: boolean; exempt: boolean }>(
        `with writable as (
           select distinct c.oid, c.oid::regclass::text as tbl, op.name as op
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            cross join (values ('INSERT', 4), ('DELETE', 8), ('UPDATE', 16)) as op(name, bit)
            cross join (values ('kf_app'), ('kf_worker')) as w(role)
            where c.relkind in ('r', 'p')
              and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_'
              and (has_table_privilege(w.role, c.oid, op.name)
                   or (op.name <> 'DELETE' and has_any_column_privilege(w.role, c.oid, op.name))))
         select w.tbl, w.op,
                (select count(*) from pg_trigger t
                  cross join (values ('INSERT', 4), ('DELETE', 8), ('UPDATE', 16)) as b(name, bit)
                  where t.tgrelid = w.oid and b.name = w.op and (t.tgtype & b.bit) <> 0
                    and ((t.tgname = 'zz_written_under_an_act'
                          and t.tgfoid = 'core.action_context_required()'::regprocedure
                          and (t.tgtype & 2) <> 0 and (t.tgtype & 1) <> 0)
                      or (t.tgname = 'written_act_is_recorded'
                          and t.tgfoid = 'core.action_context_recorded()'::regprocedure
                          and t.tgdeferrable and t.tginitdeferred and (t.tgtype & 1) <> 0))
                ) = 2 as guarded,
                exists (select 1 from core.write_guard_exemption e
                         where e.table_name = w.tbl and e.operation = w.op) as exempt
           from writable w order by 1, 2`,
      ),
    );
    // A sweep that finds nothing proves nothing: the application writes far more than five.
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.filter((r) => !r.guarded && !r.exempt).map((r) => `${r.tbl} ${r.op}`)).toEqual([]);
    expect(rows.filter((r) => r.exempt).map((r) => `${r.tbl} ${r.op}`)).toEqual(EXEMPT);
    // An exemption that is guarded anyway is a list that no longer describes the database.
    expect(rows.filter((r) => r.exempt && r.guarded).map((r) => `${r.tbl} ${r.op}`)).toEqual([]);
    const exemptions = await asAdmin((tx) =>
      tx.query<{ entry: string }>(
        `select table_name || ' ' || operation as entry from core.write_guard_exemption order by 1`,
      ),
    );
    expect(exemptions.map((e) => e.entry)).toEqual(EXEMPT);
  });

  it('refuses a CAPA root cause rewritten by a bound principal with no act', async () => {
    const capa = await newCapa();
    await expect(
      asApp(async (tx) => {
        await bindReader(tx, f, f.reviewerId);
        await tx.query(`update quality.capa set root_cause = 'Operator error' where id = $1`, [
          capa,
        ]);
      }),
    ).rejects.toThrow(/must be performed by an act/);
    expect(await rootCauseOf(capa)).toBeNull();
  });

  it('refuses a write under an action the ledger never records', async () => {
    const capa = await newCapa();
    await expect(
      asApp(async (tx) => {
        await bindReader(tx, f, f.reviewerId);
        await tx.query('select core.set_transaction_context($1, $2, $3, $4)', [
          f.reviewerId,
          f.reviewerRoleId,
          randomUUID(),
          'no-ledger-row',
        ]);
        await tx.query(`update quality.capa set root_cause = 'Operator error' where id = $1`, [
          capa,
        ]);
      }),
    ).rejects.toThrow(/not an act this transaction recorded/);
    expect(await rootCauseOf(capa)).toBeNull();
  });

  it('refuses reusing an act the same principal recorded in an earlier transaction', async () => {
    const capa = await newCapa();
    const earlier = await asApp(async (tx) => {
      await bindContext(tx, f, f.reviewerId);
      return (await tx.one<{ id: string }>('select core.current_action_id()::text as id')).id;
    });
    await expect(
      asApp(async (tx) => {
        await bindReader(tx, f, f.reviewerId);
        await tx.query('select core.set_transaction_context($1, $2, $3, $4)', [
          f.reviewerId,
          f.reviewerRoleId,
          earlier,
          'replayed-act',
        ]);
        await tx.query(`update quality.capa set root_cause = 'Operator error' where id = $1`, [
          capa,
        ]);
      }),
    ).rejects.toThrow(/not an act this transaction recorded/);
    expect(await rootCauseOf(capa)).toBeNull();
  });

  it('refuses a write under an unrecorded act even beside one that is recorded', async () => {
    // Two acts in a transaction: the forged one's writes are not laundered by the real one.
    const capa = await newCapa();
    await expect(
      asApp(async (tx) => {
        await bindReader(tx, f, f.reviewerId);
        await tx.query('select core.set_transaction_context($1, $2, $3, $4)', [
          f.reviewerId,
          f.reviewerRoleId,
          randomUUID(),
          'forged-first',
        ]);
        await tx.query(`update quality.capa set root_cause = 'Operator error' where id = $1`, [
          capa,
        ]);
        await bindContext(tx, f, f.reviewerId);
      }),
    ).rejects.toThrow(/not an act this transaction recorded/);
    expect(await rootCauseOf(capa)).toBeNull();
  });

  it('accepts the same write inside a recorded act', async () => {
    const capa = await newCapa();
    await asApp(async (tx) => {
      await bindContext(tx, f, f.reviewerId);
      await tx.query(`update quality.capa set root_cause = 'Worn fixture' where id = $1`, [capa]);
    });
    expect(await rootCauseOf(capa)).toBe('Worn fixture');
  });

  it('stamps a federated reference’s verification with the database clock', async () => {
    const id = await asAdmin(async (tx) => {
      await tx.query(
        `insert into quality.federated_source (id, description, repository)
         values ('wg-source', 'write-guard fixture', 'https://git.example/wg')
         on conflict do nothing`,
      );
      return (
        await tx.one<{ id: string }>(
          `insert into quality.federated_reference
             (source_id, external_id, commit_sha, path, content_sha256, title, recorded_by,
              verified_at)
           values ('wg-source', 'SOP-1', repeat('a', 40), 'sop.md', repeat('b', 64), 'SOP 1', $1,
                   now() - interval '30 days')
           returning id`,
          [f.reviewerId],
        )
      ).id;
    });
    const stamped = await asApp(async (tx) => {
      await bindReader(tx, f, f.reviewerId);
      return tx.one<{ fresh: boolean }>(
        `update quality.federated_reference set verified_at = '2000-01-01T00:00:00Z' where id = $1
         returning verified_at > now() - interval '1 minute' as fresh`,
        [id],
      );
    });
    expect(stamped.fresh).toBe(true);
  });
});
