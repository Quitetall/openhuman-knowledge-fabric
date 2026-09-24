import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTransaction, type Tx } from '@kf/database';
import { runDeclareServiceActor } from '../../apps/api/src/admin/declare-service-actor.js';
import { bindReader, seedFixtures, startHarness, type Fixtures, type Harness } from './harness.js';

/**
 * Writes the application role can still make, closed in the database (threat model T2).
 *
 * Each test runs as `kf_app` — `h.pool`, the adversary — and each refusal was confirmed to be a
 * SUCCESS with its migration's up section removed before it was committed. The owner would pass
 * every one of them for the wrong reason.
 */
describe('what a person is is the owner credential’s to write (20260925010000)', () => {
  let h: Harness;
  let f: Fixtures;
  let steward: string;

  beforeAll(async () => {
    h = await startHarness();
    f = await seedFixtures(h.adminPool);
    steward = (
      await runDeclareServiceActor(h.adminPool, {
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
  const kindOf = async (person: string): Promise<string> =>
    (
      await withTransaction(h.adminPool, (tx) =>
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
