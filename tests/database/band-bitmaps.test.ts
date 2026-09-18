import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enumerateAccessCoverage, type AccessCoverage } from '@kf/authorization';
import { withTransaction } from '@kf/database';
import {
  admitted,
  buildBandBitmaps,
  currentBandVersion,
  GenerationMismatch,
  maskFor,
  type BandBitmaps,
  type SlotMap,
} from '@kf/retrieval';
import {
  bindContext,
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
      await tx.query('select core.set_access_context($1, $2)', [f.organizationId, ceiling]);
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
    ).toBeGreaterThan(before);
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
});
