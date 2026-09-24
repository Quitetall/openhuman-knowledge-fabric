/**
 * Whose assignments the server may form an act under (20260925090000, ADR 0034 §2).
 *
 * The capture route acts under the caller's only live assignment, so it has to list them. The
 * application may list its BOUND principal's and nobody else's; the pre-binding lookups are the
 * attestor's alone. Against a real database, as the application login.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bindPrincipal, withTransaction } from '@kf/database';
import { seedFixtures, startHarness, type Fixtures, type Harness } from './harness.js';
import { enrolPerson, fixtureProject, type EnrolledPerson } from './people.js';

let h: Harness;
let f: Fixtures;
let two: EnrolledPerson;
let one: EnrolledPerson;

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  const project = await fixtureProject(h.adminPool, f, 'Live assignment probe');
  two = await enrolPerson(h.adminPool, f, {
    name: 'Two hats',
    assignments: [{ role: 'performer', scopeId: project }, { role: 'reviewer' }],
  });
  one = await enrolPerson(h.adminPool, f, {
    name: 'One hat',
    assignments: [{ role: 'performer', scopeId: project }],
  });
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

const listAs = (person: EnrolledPerson) =>
  withTransaction(h.pool, async (tx) => {
    await bindPrincipal(tx, {
      actorId: person.personId,
      actingRoleId: person.assignmentIds[0]!,
      organizationId: f.organizationId,
      maxClassification: 'restricted',
    });
    return tx.query<{ assignment_id: string; role_id: string }>(
      'select assignment_id, role_id from core.principal_live_assignments() order by role_id',
    );
  });

describe('core.principal_live_assignments', () => {
  it("lists the bound principal's own live assignments, all of them", async () => {
    const rows = await listAs(two);
    expect(rows.map((r) => r.assignment_id).sort()).toEqual([...two.assignmentIds].sort());
    expect(rows.map((r) => r.role_id)).toEqual(['performer', 'reviewer']);
  });

  it('names nobody else: another bound principal sees only theirs', async () => {
    const rows = await listAs(one);
    expect(rows.map((r) => r.assignment_id)).toEqual(one.assignmentIds);
  });

  it('refuses in a transaction with no principal bound', async () => {
    await expect(
      withTransaction(h.pool, (tx) => tx.query('select * from core.principal_live_assignments()')),
    ).rejects.toThrow(/no principal is bound/);
  });

  it('drops an assignment that has ended', async () => {
    const leaver = await enrolPerson(h.adminPool, f, {
      name: 'Leaver',
      assignments: [{ role: 'performer' }, { role: 'reviewer' }],
    });
    await withTransaction(h.adminPool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
      await tx.query('select core.set_transaction_context($1, $1, $2, $3)', [
        f.reviewerId,
        f.clearanceActionId,
        'end-assignment',
      ]);
      await tx.query(
        `update org.role_assignment set valid_to = now() + interval '1 millisecond' where id = $1`,
        [leaver.assignmentIds[1]],
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const rows = await listAs(leaver);
    expect(rows.map((r) => r.assignment_id)).toEqual([leaver.assignmentIds[0]]);
  });
});

describe('the pre-binding lookups are the attestor’s alone', () => {
  it('refuses the application login', async () => {
    await expect(
      withTransaction(h.pool, (tx) =>
        tx.query('select * from org.live_assignments_of($1, $2)', [two.personId, f.organizationId]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTransaction(h.pool, (tx) =>
        tx.query('select * from org.resolve_identity_assignments($1, $2, $3)', [
          'https://id.invalid',
          'someone',
          f.organizationId,
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('answers the attestor', async () => {
    const listed = await withTransaction(h.attestorPool, (tx) =>
      tx.query<{ assignment_id: string }>(
        'select assignment_id from org.live_assignments_of($1, $2)',
        [two.personId, f.organizationId],
      ),
    );
    expect(listed.map((r) => r.assignment_id).sort()).toEqual([...two.assignmentIds].sort());
  });
});
