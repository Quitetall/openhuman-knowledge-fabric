import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enumerateAccessCoverage, type AccessCoverage } from '@kf/authorization';
import { withTransaction } from '@kf/database';
import {
  admitted,
  BandBitmapCache,
  buildBandBitmaps,
  currentBandVersion,
  GenerationMismatch,
  maskFor,
  type BandBitmaps,
  type SlotMap,
} from '@kf/retrieval';
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
 * The mask the retrieval engine scores under (§64A, KF-SAS-RQ-213 to RQ-215).
 *
 * The engine holds a vector and an identifier. It cannot decide who may read what, so the
 * decision is taken here against live records and handed across as a mask over its slot ordering.
 * These tests hold that mask to three properties: it admits nothing above the caller's ceiling,
 * it admits nothing a grant does not reach even below it, and it admits nothing whose identifier
 * the database cannot resolve.
 */
describe('the band mask is derived from live records', () => {
  let harness: Harness;
  let f: Fixtures;
  let publicId: string;
  let internalId: string;
  let restrictedId: string;
  let slots: SlotMap;

  const GENERATION = 'tv-generation-0001';

  beforeAll(async () => {
    harness = await startHarness();
    f = await seedFixtures(harness.adminPool);

    const make = async (title: string): Promise<string> =>
      createObject(harness.adminPool, f, {
        type: 'decision_record',
        domain: 'engineering',
        state: 'draft',
        title,
        createdBy: f.performerId,
      });

    publicId = await make('Board A revision 3.0 is generation 1.0');
    internalId = await make('ATLAS 3.2 r5 power tree review');
    restrictedId = await make('Second source qualification, commercial terms');

    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, f);
      for (const [id, classification] of [
        [publicId, 'public'],
        [restrictedId, 'restricted'],
      ] as const) {
        await tx.query(
          'update core.object set classification = $2, row_version = row_version + 1 where id = $1',
          [id, classification],
        );
      }
    });

    // The last slot names a record that does not exist: an index that has outrun the database.
    slots = {
      generation: GENERATION,
      objectIds: [publicId, internalId, restrictedId, '01a00000-0000-7000-8000-000000000000'],
    };
  }, 240_000);

  afterAll(async () => {
    await harness?.stop();
  });

  async function bitmaps(): Promise<BandBitmaps> {
    return withTransaction(harness.pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'public']);
      return buildBandBitmaps(tx, f.organizationId, slots);
    });
  }

  /**
   * Coverage as resolved at a session bound to `ceiling`.
   *
   * Two different things are being varied in these tests and they must not be conflated. A
   * person's coverage is resolved ONCE, at their clearance, because the session ceiling IS the
   * clearance (ADR 0027). The `ceiling` argument to `maskFor` is then what that person may reach.
   * Passing a lower ceiling here as well simulates a DIFFERENT person with a lower clearance,
   * which is a real case and has a real consequence — see the `public` test below.
   */
  async function coverageFor(ceiling: string): Promise<AccessCoverage> {
    return withTransaction(harness.pool, async (tx) => {
      // The reader is the person whose coverage is asked for, bound as a principal: the
      // application no longer binds an organization and a ceiling with nobody behind them.
      await bindReader(tx, f, f.performerId, ceiling);
      return enumerateAccessCoverage(tx, f.performerId, f.organizationId);
    });
  }

  it('reads band membership above the caller’s own ceiling, because the bands are not the caller’s', async () => {
    // Built under a `public` context on purpose. Band membership is a property of the
    // organization — the same four bitmaps serve everyone, which is what makes them cacheable —
    // so the definer function must see classifications the caller may not.
    const b = await bitmaps();
    expect(b.slotCount).toBe(4);
    expect([...b.bands.public]).toEqual([1, 0, 0, 0]);
    expect([...b.bands.internal]).toEqual([0, 1, 0, 0]);
    expect([...b.bands.restricted]).toEqual([0, 0, 1, 0]);
    expect([...b.unresolved], 'the slot naming no record must resolve to nothing').toEqual([
      0, 0, 0, 1,
    ]);
  });

  it('admits nothing above the ceiling, and widens as the ceiling rises', async () => {
    const b = await bitmaps();
    // Coverage resolved once, at the person's clearance; the ceiling is what varies.
    const cleared = await coverageFor('restricted');
    const atCeiling = (ceiling: 'public' | 'internal' | 'restricted') => [
      ...maskFor(b, cleared, ceiling, slots),
    ];

    expect(atCeiling('public')).toEqual([1, 0, 0, 0]);
    expect(atCeiling('internal')).toEqual([1, 1, 0, 0]);
    expect(atCeiling('restricted')).toEqual([1, 1, 1, 0]);
  });

  /**
   * A person whose CLEARANCE is `public` reaches nothing, including public records.
   *
   * Not a defect in the mask — the mask is doing what it is told. `enumerateAccessCoverage` reads
   * `org.effective_access_grant` under the caller's own row security, and at a public ceiling the
   * grant records that would cover this person are themselves above it. So coverage comes back
   * empty and every slot is refused.
   *
   * Recorded as an observation rather than asserted as correct. Need-to-know says an empty answer
   * is the safe one. Usability says a member cleared to public who has been granted a public
   * record should be able to read it, and today cannot. Which of those wins is a decision, and it
   * belongs in a decision record rather than in a test's expectations.
   */
  it('gives a person cleared only to public an empty mask, because their own grants are above them', async () => {
    const b = await bitmaps();
    const atPublicClearance = await coverageFor('public');
    expect(atPublicClearance.organizationWide).toEqual([]);
    expect(admitted(maskFor(b, atPublicClearance, 'public', slots))).toBe(0);
  });

  it('never admits the unresolvable slot at any ceiling', async () => {
    const b = await bitmaps();
    const cleared = await coverageFor('restricted');
    for (const ceiling of ['public', 'internal', 'restricted'] as const) {
      const mask = maskFor(b, cleared, ceiling, slots);
      expect(
        mask[3],
        'a slot whose identifier names no record has either outrun the database or been pointed ' +
          'at a different one, and neither is a reason to show anybody anything',
      ).toBe(0);
    }
  });

  it('admits nothing at all to a person no grant reaches', async () => {
    const b = await bitmaps();
    const ungranted: AccessCoverage = { organizationWide: [], byObject: new Map() };
    expect(
      admitted(maskFor(b, ungranted, 'restricted', slots)),
      'clearance is not access: a person cleared to restricted with no grant reads nothing',
    ).toBe(0);
  });

  it('returns a mask exactly as long as the index, never longer', async () => {
    const b = await bitmaps();
    const mask = maskFor(b, await coverageFor('restricted'), 'restricted', slots);
    expect(mask.length).toBe(slots.objectIds.length);
  });

  it('refuses a slot map from a different generation rather than masking by a foreign ordering', async () => {
    const b = await bitmaps();
    const moved: SlotMap = { ...slots, generation: 'tv-generation-0002' };
    expect(() =>
      maskFor(b, { organizationWide: [], byObject: new Map() }, 'public', moved),
    ).toThrow(GenerationMismatch);
  });

  it('moves the band version when a classification changes, and not when a title does', async () => {
    const version = async () =>
      withTransaction(harness.pool, async (tx) => {
        await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'public']);
        return currentBandVersion(tx, f.organizationId);
      });

    const before = await version();

    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, f);
      await tx.query(
        'update core.object set title = $2, row_version = row_version + 1 where id = $1',
        [internalId, 'ATLAS 3.2 r5 power tree review, second pass'],
      );
    });
    expect(
      await version(),
      'an ordinary edit must not invalidate every cached bitmap in the estate',
    ).toBe(before);

    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, f);
      await tx.query(
        `update core.object set classification = 'restricted', row_version = row_version + 1 where id = $1`,
        [internalId],
      );
    });
    expect(
      await version(),
      'a reclassification must move the version, or a cache keyed on it serves the old decision',
    ).not.toBe(before);
  });

  it('reflects the reclassification on the next build, with no refresh step in between', async () => {
    const b = await bitmaps();
    expect([...b.bands.internal], 'the record moved out of internal').toEqual([0, 0, 0, 0]);
    expect([...b.bands.restricted]).toEqual([0, 1, 1, 0]);
    expect(
      [...maskFor(b, await coverageFor('restricted'), 'internal', slots)],
      'a caller cleared to internal must no longer reach a record that is now restricted',
    ).toEqual([1, 0, 0, 0]);
  });

  it('never reissues a version after the row is lost, so a cached bitmap cannot come back to life', async () => {
    // The derived row is excluded from preservation; a restore that leaves it out recreates it on
    // the next band-moving write. The counter restarts, so the token must not (ADR 0028 amended).
    const cache = new BandBitmapCache();
    const read = <T>(
      fn: (tx: Parameters<Parameters<typeof withTransaction>[1]>[0]) => Promise<T>,
    ) =>
      withTransaction(harness.pool, async (tx) => {
        await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'public']);
        return fn(tx);
      });
    const reclassify = (classification: string) =>
      withTransaction(harness.adminPool, async (tx) => {
        await bindContext(tx, f);
        await tx.query(
          'update core.object set classification = $2, row_version = row_version + 1 where id = $1',
          [internalId, classification],
        );
      });
    const toggle = ['internal', 'restricted', 'internal', 'restricted'] as const;

    const observed = new Set<string>();
    const stale = await read((tx) => cache.get(tx, f.organizationId, slots));
    observed.add(stale.bandVersion);
    expect(
      await read((tx) => cache.get(tx, f.organizationId, slots)),
      'reused while unchanged',
    ).toBe(stale);
    for (const classification of toggle) {
      await reclassify(classification);
      observed.add(await read((tx) => currentBandVersion(tx, f.organizationId)));
    }
    expect(observed.size).toBe(toggle.length + 1);

    // The counter is read raw, as the owner, only to know how far to climb after the loss; the
    // application never sees or orders it.
    const counter = async (): Promise<number> =>
      withTransaction(harness.adminPool, async (tx) => {
        const rows = await tx.query<{ version: string }>(
          'select version::text as version from retrieval.band_version where organization_id = $1',
          [f.organizationId],
        );
        return Number(rows[0]?.version ?? '0');
      });
    const highest = await counter();
    expect(highest).toBeGreaterThan(toggle.length);

    await withTransaction(harness.adminPool, (tx) =>
      tx.query('delete from retrieval.band_version where organization_id = $1', [f.organizationId]),
    );
    const lost = await read((tx) => cache.get(tx, f.organizationId, slots));
    expect(lost, 'no row, no version: never served from cache').not.toBe(stale);
    expect(await read((tx) => cache.get(tx, f.organizationId, slots))).not.toBe(lost);

    // Climb back past every counter value issued before the loss.
    let climbed = 0;
    while (climbed <= highest) {
      await reclassify(climbed % 2 === 0 ? 'internal' : 'restricted');
      climbed = await counter();
      const token = await read((tx) => currentBandVersion(tx, f.organizationId));
      expect(observed.has(token), `token ${token} was issued before the row was lost`).toBe(false);
    }
    await reclassify('restricted');
    const fresh = await read((tx) => cache.get(tx, f.organizationId, slots));
    expect(observed.has(fresh.bandVersion)).toBe(false);
    expect(fresh).not.toBe(stale);
    expect([...fresh.bands.restricted], 'the rebuilt entry reflects the live records').toEqual([
      0, 1, 1, 0,
    ]);
  });

  it('refuses to move an epoch or run a counter backwards, even for the owner', async () => {
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, f);
      await tx.query(
        'update core.object set title = title, classification = classification, row_version = row_version + 1 where id = $1',
        [publicId],
      );
    });
    await expect(
      withTransaction(harness.adminPool, (tx) =>
        tx.query('update retrieval.band_version set epoch = uuidv7() where organization_id = $1', [
          f.organizationId,
        ]),
      ),
    ).rejects.toThrow(/epoch is fixed/);
    await expect(
      withTransaction(harness.adminPool, (tx) =>
        tx.query(
          'update retrieval.band_version set version = version - 1 where organization_id = $1',
          [f.organizationId],
        ),
      ),
    ).rejects.toThrow(/never moves backwards/);
  });

  it('lets two transactions create records in one organization at once, each moving the version once, at commit', async () => {
    // 20260926100200. The bump used to run as each record was created, and its row lock was held
    // until commit: a second transaction creating a record in the same organization waited for
    // the first to finish, whatever else the first was doing. Under the old trigger the second
    // transaction below waits on the first and fails on its lock timeout.
    const counter = async (): Promise<number> =>
      withTransaction(harness.adminPool, async (tx) => {
        const rows = await tx.query<{ version: string }>(
          'select version::text as version from retrieval.band_version where organization_id = $1',
          [f.organizationId],
        );
        return Number(rows[0]?.version ?? '0');
      });
    const insert = async (
      tx: Parameters<Parameters<typeof withTransaction>[1]>[0],
      title: string,
    ) => {
      const { version } = await tx.one<{ version: string }>(
        'select version from registry.schema_release where is_current',
      );
      await tx.query(
        `insert into core.object
           (object_type, authority_domain, lifecycle_state, classification, retention_class,
            schema_version, organization_id, title, created_by, updated_by)
         values ('decision_record','engineering','draft','internal','project_record',
                 $1,$2,$3,$4,$4)`,
        [version, f.organizationId, title, f.performerId],
      );
    };
    const before = await counter();

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let created!: () => void;
    const firstCreated = new Promise<void>((resolve) => {
      created = resolve;
    });
    const first = withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, f);
      await insert(tx, 'Concurrent ingest one, record one');
      await insert(tx, 'Concurrent ingest one, record two');
      await insert(tx, 'Concurrent ingest one, record three');
      created();
      await held;
    });
    await firstCreated;

    const second = withTransaction(harness.adminPool, async (tx) => {
      await tx.query("set local lock_timeout = '2s'");
      await bindContext(tx, f);
      await insert(tx, 'Concurrent ingest two');
    });
    await expect(
      second,
      'a record created while another transaction holds uncommitted records must not wait for it',
    ).resolves.toBeUndefined();
    expect(await counter(), 'the second committed first and moved the version').toBe(before + 1);

    release();
    await first;
    expect(
      await counter(),
      'the first moved it once for its three records, after the second: never the same value twice',
    ).toBe(before + 2);
  });

  it('moves the version in the same commit as the change, so no reader sees one without the other', async () => {
    const read = () =>
      withTransaction(harness.pool, async (tx) => {
        await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'public']);
        return currentBandVersion(tx, f.organizationId);
      });
    const before = await read();
    await expect(
      withTransaction(harness.adminPool, async (tx) => {
        await bindContext(tx, f);
        await tx.query(
          `update core.object set classification = 'internal', row_version = row_version + 1 where id = $1`,
          [restrictedId],
        );
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await read(), 'a rolled-back reclassification moved nothing').toBe(before);
  });
});
