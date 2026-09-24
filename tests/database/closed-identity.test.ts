import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction, type Pool } from '@kf/database';
import {
  bindContext,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

/**
 * A closed record keeps the fields that say what it is (20260925064200).
 *
 * 20260925030000 freezes a decided decision's title (KF-DEC-001). This extends the freeze to the
 * title of every record in a terminal state and to the identity fields of every closed record,
 * decisions included. `kf_app` holds UPDATE on every column of `core.object`, and the act write
 * guard checks that SOME act was recorded, not what it may write. These tests write directly — through the application login with a principal
 * bound and a real act recorded (`bindContext`), and through the owner — and require the database
 * itself to refuse a rename of a closed record while leaving an open one, and a closed record's
 * governance fields, writable.
 */
describe('a closed record keeps its identity', () => {
  let h: Harness;
  let f: Fixtures;

  beforeAll(async () => {
    h = await startHarness();
    f = await seedFixtures(h.adminPool);
  }, 240_000);

  afterAll(async () => {
    await h?.stop();
  });

  // The authority domain is the type's (20260925013000).
  const DOMAIN: Readonly<Record<string, string>> = {
    decision_record: 'engineering',
    change_record: 'configuration',
    work_order: 'commercial',
  };
  const make = (type: string, state: string, title: string): Promise<string> =>
    createObject(h.adminPool, f, {
      type,
      domain: DOMAIN[type]!,
      state,
      title,
      createdBy: f.performerId,
    });

  const write = (pool: Pool, sql: string, params: unknown[]): Promise<unknown> =>
    withTransaction(pool, async (tx) => {
      await bindContext(tx, f);
      return tx.query(sql, params);
    });

  const rename = (pool: Pool, id: string, title: string): Promise<unknown> =>
    write(pool, 'update core.object set title = $2, row_version = row_version + 1 where id = $1', [
      id,
      title,
    ]);

  const titleOf = async (id: string): Promise<string> =>
    withTransaction(
      h.adminPool,
      async (tx) =>
        (await tx.one<{ title: string }>('select title from core.object where id = $1', [id]))
          .title,
    );

  it('renames an open record: the write path under test works', async () => {
    const id = await make('change_record', 'implementing', 'Swap the regulator');
    await rename(h.pool, id, 'Swap the regulator, second source');
    expect(await titleOf(id)).toBe('Swap the regulator, second source');
  });

  it('refuses renaming a closed change through the application login, with an act bound', async () => {
    const id = await make('change_record', 'closed', 'Freeze the board revision');
    await expect(rename(h.pool, id, 'Unfreeze the board revision')).rejects.toThrow(
      /^change_record \S+ is closed \(closed\): title may not change$/,
    );
    expect(await titleOf(id)).toBe('Freeze the board revision');
  });

  it('refuses it for the owner too: a trigger, not a privilege', async () => {
    const id = await make('change_record', 'closed', 'Owner cannot rename this');
    await expect(rename(h.adminPool, id, 'Renamed by the owner')).rejects.toThrow(
      /is closed \(\w+\): title may not change/,
    );
  });

  it.each([
    ['change_record', 'rejected'],
    ['work_order', 'terminated'],
    ['work_order', 'cancelled'],
  ])('refuses renaming a %s in terminal state %s', async (type, state) => {
    const id = await make(type, state, `A ${state} ${type}`);
    await expect(rename(h.pool, id, 'rewritten')).rejects.toThrow(
      /is closed \(\w+\): title may not change/,
    );
  });

  it('leaves a decided decision’s title to KF-DEC-001’s own guard: one refusal, one message', async () => {
    const id = await make('decision_record', 'accepted', 'Adopt the second source');
    const refusal = await rename(h.pool, id, 'Adopt the first source').then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(refusal).toMatch(/^KF-DEC-001: a accepted decision is immutable/);
    expect(refusal).not.toMatch(/may not change/);
  });

  it('refuses re-homing or retyping a closed record, naming every field', async () => {
    const id = await make('decision_record', 'accepted', 'Keep its creation facts');
    await expect(
      write(
        h.adminPool,
        `update core.object
            set created_by = $2, authority_domain = 'quality', row_version = row_version + 1
          where id = $1`,
        [id, f.reviewerId],
      ),
    ).rejects.toThrow(/authority_domain, created_by/);
  });

  it('leaves a closed record’s governance writable: reclassification is not a rename', async () => {
    const id = await make('decision_record', 'accepted', 'Reclassify me');
    await write(
      h.pool,
      `update core.object set classification = 'confidential', row_version = row_version + 1
        where id = $1`,
      [id],
    );
    const row = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ classification: string }>('select classification from core.object where id = $1', [
        id,
      ]),
    );
    expect(row.classification).toBe('confidential');
  });
});
