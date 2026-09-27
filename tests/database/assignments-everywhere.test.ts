/**
 * Every live assignment a signed-in person holds, in every organization (20260926120000).
 *
 * The context picker lists them so a person of any organization chooses without typing ids. The
 * lookup is the attestor's alone, it answers only for the person the token's issuer and subject
 * are linked to, and an organization where that person holds nothing live is never named — not by
 * id and not by legal name. Against a real database, three organizations: A, where the traveller
 * works; B, where they also hold a role; C, where they hold nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdentityRejected, holdingsIn, linkIdentity } from '@kf/authorization';
import { withTransaction, type Tx } from '@kf/database';
import { bindContext, seedFixtures, startHarness, type Fixtures, type Harness } from './harness.js';
import { assignElsewhere, enrolPerson, type EnrolledPerson } from './people.js';

const ISSUER = 'https://id.everywhere.invalid/realms/kf';

let h: Harness;
let a: Fixtures;
let b: Fixtures;
let c: Fixtures;
let traveller: EnrolledPerson;
let travellerInB: string;
let endedInC: string;
let idle: EnrolledPerson;
let revoked: EnrolledPerson;
const legalName: Record<string, string> = {};

async function link(f: Fixtures, subject: string, personId: string): Promise<string> {
  return withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f);
    return linkIdentity(tx, {
      issuer: ISSUER,
      subject,
      personId,
      providerLabel: subject,
      linkedBy: f.performerId,
    });
  });
}

type Row = {
  person_id: string;
  identity_revoked: boolean;
  organization_id: string | null;
  legal_name: string | null;
  assignment_id: string | null;
  role_id: string | null;
};

const resolve = (subject: string, issuer = ISSUER) =>
  withTransaction(h.attestorPool, (tx) =>
    tx.query<Row>(
      `select person_id, identity_revoked, organization_id, legal_name, assignment_id, role_id
         from org.resolve_identity_assignments_everywhere($1, $2)`,
      [issuer, subject],
    ),
  );

beforeAll(async () => {
  h = await startHarness();
  a = await seedFixtures(h.adminPool);
  b = await seedFixtures(h.adminPool);
  c = await seedFixtures(h.adminPool);
  for (const f of [a, b, c]) {
    legalName[f.organizationId] = (
      await withTransaction(h.adminPool, (tx) =>
        tx.one<{ legal_name: string }>('select legal_name from org.organization where id = $1', [
          f.organizationId,
        ]),
      )
    ).legal_name;
  }
  traveller = await enrolPerson(h.adminPool, a, {
    name: 'Traveller',
    assignments: [{ role: 'performer' }, { role: 'reviewer' }],
  });
  travellerInB = await assignElsewhere(h.adminPool, b, {
    personId: traveller.personId,
    role: 'performer',
    clearance: 'internal',
  });
  // C: an assignment that has already ended, so C is somewhere the traveller holds NOTHING live.
  endedInC = await assignElsewhere(h.adminPool, c, {
    personId: traveller.personId,
    role: 'reviewer',
  });
  await withTransaction(h.adminPool, async (tx) => {
    await tx.query('select core.set_access_context($1, $2)', [c.organizationId, 'restricted']);
    await tx.query('select core.set_transaction_context($1, $1, $2, $3)', [
      c.reviewerId,
      c.clearanceActionId,
      'end-assignment',
    ]);
    await tx.query(
      `update org.role_assignment set valid_to = now() + interval '1 millisecond' where id = $1`,
      [endedInC],
    );
  });
  await new Promise((done) => setTimeout(done, 20));
  idle = await enrolPerson(h.adminPool, a, { name: 'Idle', assignments: [] });
  revoked = await enrolPerson(h.adminPool, a, {
    name: 'Revoked',
    assignments: [{ role: 'performer' }],
  });

  await link(a, 'traveller', traveller.personId);
  await link(b, 'b-reviewer', b.reviewerId);
  await link(a, 'idle', idle.personId);
  const revokedLink = await link(a, 'revoked', revoked.personId);
  await withTransaction(h.adminPool, (tx) =>
    tx.query('update org.external_identity set revoked_at = now() where id = $1', [revokedLink]),
  );
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe('org.resolve_identity_assignments_everywhere', () => {
  it('lists every live assignment the person holds, by organization, with its legal name', async () => {
    const rows = await resolve('traveller');
    expect(rows.every((row) => row.person_id === traveller.personId)).toBe(true);
    expect(rows.every((row) => !row.identity_revoked)).toBe(true);
    const byOrganization = new Map<string, string[]>();
    for (const row of rows) {
      expect(row.legal_name).toBe(legalName[row.organization_id!]);
      byOrganization.set(row.organization_id!, [
        ...(byOrganization.get(row.organization_id!) ?? []),
        row.assignment_id!,
      ]);
    }
    expect([...byOrganization.keys()].sort()).toEqual([a.organizationId, b.organizationId].sort());
    expect(byOrganization.get(a.organizationId)!.sort()).toEqual(
      [...traveller.assignmentIds].sort(),
    );
    expect(byOrganization.get(b.organizationId)).toEqual([travellerInB]);
  });

  it('never names an organization the person holds nothing live in, by id or by name', async () => {
    const text = JSON.stringify(await resolve('traveller'));
    expect(text).not.toContain(c.organizationId);
    expect(text).not.toContain(legalName[c.organizationId]);
    expect(text).not.toContain(endedInC);
  });

  it("answers only for the token's own person: nobody else's assignments, in any organization", async () => {
    const rows = await resolve('b-reviewer');
    expect(rows.map((row) => [row.organization_id, row.assignment_id])).toEqual([
      [b.organizationId, b.reviewerRoleId],
    ]);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(travellerInB);
    expect(text).not.toContain(a.organizationId);
    for (const id of traveller.assignmentIds) expect(text).not.toContain(id);
  });

  it('refuses as the one-organization lookup does: unknown, revoked, holding nothing', async () => {
    expect(await resolve('stranger')).toEqual([]);
    expect(await resolve('traveller', 'https://another-issuer.invalid/')).toEqual([]);
    expect(await resolve('revoked')).toEqual([
      {
        person_id: revoked.personId,
        identity_revoked: true,
        organization_id: null,
        legal_name: null,
        assignment_id: null,
        role_id: null,
      },
    ]);
    expect(await resolve('idle')).toEqual([
      {
        person_id: idle.personId,
        identity_revoked: false,
        organization_id: null,
        legal_name: null,
        assignment_id: null,
        role_id: null,
      },
    ]);
  });

  it('leaves the caller’s own context as it found it', async () => {
    const setting = (tx: Tx) =>
      tx.one<{ organization: string | null; ceiling: string | null }>(
        `select current_setting('kf.organization', true) as organization,
                current_setting('kf.max_classification', true) as ceiling`,
      );
    const [before, after] = await withTransaction(h.attestorPool, async (tx) => {
      const seen = await setting(tx);
      await tx.query('select * from org.resolve_identity_assignments_everywhere($1, $2)', [
        ISSUER,
        'traveller',
      ]);
      return [seen, await setting(tx)];
    });
    expect(after).toEqual(before);
    expect(after.organization ?? '').not.toContain(b.organizationId);
  });
});

describe('holdingsIn, the attestor’s reading of it', () => {
  it('groups the rows by organization', async () => {
    const holdings = await withTransaction(h.attestorPool, (tx) =>
      holdingsIn(tx, { issuer: ISSUER, subject: 'traveller' }),
    );
    expect(holdings.personId).toBe(traveller.personId);
    expect(
      holdings.organizations.map((held) => ({
        organizationId: held.organizationId,
        legalName: held.legalName,
        assignments: held.assignments.map((x) => x.assignmentId).sort(),
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          organizationId: a.organizationId,
          legalName: legalName[a.organizationId],
          assignments: [...traveller.assignmentIds].sort(),
        },
        {
          organizationId: b.organizationId,
          legalName: legalName[b.organizationId],
          assignments: [travellerInB],
        },
      ]),
    );
    expect(holdings.organizations).toHaveLength(2);
  });

  it.each([
    ['stranger', 'unknown_subject'],
    ['revoked', 'revoked_identity'],
    ['idle', 'no_live_assignment'],
  ])('refuses %s as %s', async (subject, failure) => {
    const error = await withTransaction(h.attestorPool, (tx) =>
      holdingsIn(tx, { issuer: ISSUER, subject }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IdentityRejected);
    expect((error as IdentityRejected).failure).toBe(failure);
  });
});

describe('the cross-organization lookups are the attestor’s alone', () => {
  it('refuses the application login', async () => {
    await expect(
      withTransaction(h.pool, (tx) =>
        tx.query('select * from org.live_assignments_everywhere_of($1)', [traveller.personId]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTransaction(h.pool, (tx) =>
        tx.query('select * from org.resolve_identity_assignments_everywhere($1, $2)', [
          ISSUER,
          'traveller',
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('grants execute to kf_attestor and to no other role', async () => {
    const grantees = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ fn: string; grantee: string }>(
        `select p.proname as fn, coalesce(r.rolname, 'PUBLIC') as grantee
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
           left join pg_roles r on r.oid = acl.grantee
          where n.nspname = 'org'
            and p.proname in ('live_assignments_everywhere_of',
                              'resolve_identity_assignments_everywhere')
            and acl.privilege_type = 'EXECUTE'
            and acl.grantee <> p.proowner
          order by 1, 2`,
      ),
    );
    expect(grantees).toEqual([
      { fn: 'live_assignments_everywhere_of', grantee: 'kf_attestor' },
      { fn: 'resolve_identity_assignments_everywhere', grantee: 'kf_attestor' },
    ]);
  });
});
