import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InMemoryObjectStore } from '@kf/artifacts';
import { withTransaction } from '@kf/database';
import { createDocumentActionAtoms } from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
import { runBootstrap } from '../../apps/api/src/admin/bootstrap-organization.js';
import { runGrantAuthority } from '../../apps/api/src/admin/grant-authority.js';
import { runRetireOrganization } from '../../apps/api/src/admin/retire-organization.js';
import { seedFixtures, startHarness, type Fixtures, type Harness } from './harness.js';

/**
 * An organization is retired with its people, and the first authority in it can be granted.
 * Against a real database, because every rule here is enforced by a trigger or a policy that a
 * unit test cannot reach:
 *
 *   1. The FOUNDING grant. An organization nobody holds a role in cannot have its founder
 *      granted by "somebody with a role", because there is no such somebody. The founder
 *      self-grants, once, and the act is recorded under the assignment it creates. A second
 *      self-grant in an organization that already has a role is refused.
 *   2. `retire_organization` with active people is REFUSED unless the act says
 *      `with_people: true`; with it, the organization retires, its people become `inactive`
 *      under the same act, their role assignments and clearances are end-dated, and the
 *      retirement is recorded where `explainAccess` reads it.
 *   3. A successor that is itself retired is refused; a live one is recorded on the retired
 *      organization's row as `succeeded_by` (a relation cannot cross organizations).
 *   4. `kf retire-organization` (bootstrap tier) refuses an organization anybody can act in,
 *      and retires one nobody can — through the same precondition and effect.
 *   5. `deactivate_person` ends authority; a person cannot deactivate themself.
 *
 * The first retirement in this repository was done with raw SQL in a migration and left nine
 * active people attributed to retired organizations; the transition guard would have refused
 * it had it been asked. Every path below asks.
 */

let harness: Harness;
let fixtures: Fixtures;

beforeAll(async () => {
  harness = await startHarness();
  fixtures = await seedFixtures(harness.adminPool);
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

const dispatcher = () =>
  createFabricDispatcher(
    harness.pool,
    createDocumentActionAtoms({
      store: new InMemoryObjectStore(),
      parser: {
        async parse() {
          return undefined;
        },
      },
    }),
  );

interface Founded {
  readonly organizationId: string;
  readonly personId: string;
  readonly roleAssignmentId: string;
}

/** A fresh organization with a founder who holds project_owner at restricted. */
async function foundOrganization(name: string): Promise<Founded> {
  const created = await runBootstrap(harness.adminPool, {
    legalName: `${name} (${randomUUID()})`,
    personName: 'Founder',
    organizationKind: 'company',
    organizationId: '',
  });
  const granted = await runGrantAuthority(harness.adminPool, {
    personId: created.personId,
    organizationId: created.organizationId,
    roleId: 'project_owner',
    classification: 'restricted',
    grantedBy: created.personId,
    reason: 'founding grant: the first authority in a new organization is the founder’s own',
  });
  return {
    organizationId: created.organizationId,
    personId: created.personId,
    roleAssignmentId: granted.roleAssignmentId,
  };
}

async function objectState(id: string, organizationId: string): Promise<string> {
  return withTransaction(harness.adminPool, async (tx) => {
    await tx.query('select core.set_access_context($1, $2)', [organizationId, 'restricted']);
    const row = await tx.one<{ lifecycle_state: string }>(
      'select lifecycle_state from core.object where id = $1',
      [id],
    );
    return row.lifecycle_state;
  });
}

async function liveAuthority(
  personId: string,
  organizationId: string,
): Promise<{ roles: number; clearances: number; retirements: number }> {
  return withTransaction(harness.adminPool, async (tx) => {
    await tx.query('select core.set_access_context($1, $2)', [organizationId, 'restricted']);
    const roles = await tx.one<{ n: string }>(
      `select count(*)::text as n from org.role_assignment
        where subject_id = $1 and scope_id = $2
          and valid_from <= now() and (valid_to is null or valid_to > now())`,
      [personId, organizationId],
    );
    const clearances = await tx.one<{ n: string }>(
      `select count(*)::text as n from org.person_clearance c
        where subject_id = $1 and organization_id = $2
          and valid_from <= now() and (valid_to is null or valid_to > now())
          and not exists (
            select 1 from org.person_clearance_retirement r where r.clearance_id = c.id)`,
      [personId, organizationId],
    );
    const retirements = await tx.one<{ n: string }>(
      `select count(*)::text as n from org.person_clearance_retirement r
         join org.person_clearance c on c.id = r.clearance_id
        where c.subject_id = $1 and c.organization_id = $2`,
      [personId, organizationId],
    );
    return {
      roles: Number(roles.n),
      clearances: Number(clearances.n),
      retirements: Number(retirements.n),
    };
  });
}

describe('the founding grant', () => {
  it('lets the founder grant themself, once, and records the act under the assignment it creates', async () => {
    const founded = await foundOrganization('Founding Co');
    const action = await withTransaction(harness.adminPool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [
        founded.organizationId,
        'restricted',
      ]);
      return tx.one<{ acting_role_id: string; actor_id: string }>(
        `select acting_role_id, actor_id from core.action
          where organization_id = $1 and action_type = 'grant_person_clearance'`,
        [founded.organizationId],
      );
    });
    expect(action.actor_id).toBe(founded.personId);
    expect(action.acting_role_id).toBe(founded.roleAssignmentId);
    expect(await liveAuthority(founded.personId, founded.organizationId)).toEqual({
      roles: 1,
      clearances: 1,
      retirements: 0,
    });
  });

  it('refuses a self-grant once the organization has any role assignment', async () => {
    const founded = await foundOrganization('Second Self Grant Co');
    const second = await runBootstrap(harness.adminPool, {
      legalName: '',
      personName: 'Second Person',
      organizationKind: 'company',
      organizationId: founded.organizationId,
    });
    await expect(
      runGrantAuthority(harness.adminPool, {
        personId: second.personId,
        organizationId: founded.organizationId,
        roleId: 'performer',
        classification: 'internal',
        grantedBy: second.personId,
        reason: 'trying to grant myself in an organization that already has a founder',
      }),
    ).rejects.toThrow(/holds no active role assignment/);
    // The founder, who holds one, can.
    const granted = await runGrantAuthority(harness.adminPool, {
      personId: second.personId,
      organizationId: founded.organizationId,
      roleId: 'performer',
      classification: 'internal',
      grantedBy: founded.personId,
      reason: 'the founder admits the second person',
    });
    expect(granted.changed).toBe(true);
  });
});

describe('retire_organization', () => {
  it('is refused while people are active, unless the act says with_people', async () => {
    const founded = await foundOrganization('Refused Retirement Co');
    const execute = dispatcher();
    const request = {
      actionType: 'retire_organization',
      actorId: founded.personId,
      actingRoleId: founded.roleAssignmentId,
      targetIds: [founded.organizationId],
      organizationId: founded.organizationId,
      maxClassification: 'restricted',
      reason: 'this company was created to be retired in a test',
    } as const;
    await expect(
      execute({ ...request, idempotencyKey: `retire-${randomUUID()}` }),
    ).rejects.toMatchObject({ name: 'ActionRejected', failure: 'precondition_failed' });
    expect(await objectState(founded.organizationId, founded.organizationId)).toBe('active');

    const applied = await execute({
      ...request,
      idempotencyKey: `retire-${randomUUID()}`,
      payload: { with_people: true },
    });
    expect(applied.status).toBe('applied');
    expect(await objectState(founded.organizationId, founded.organizationId)).toBe('retired');
    expect(await objectState(founded.personId, founded.organizationId)).toBe('inactive');
    expect(await liveAuthority(founded.personId, founded.organizationId)).toEqual({
      roles: 0,
      clearances: 0,
      retirements: 1,
    });
    const retiredAt = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{ retired_at: Date | null }>('select retired_at from org.organization where id = $1', [
        founded.organizationId,
      ]),
    );
    expect(retiredAt.retired_at).not.toBeNull();
  });

  it('refuses a retired successor and records a live one as succeeded_by', async () => {
    const dead = await foundOrganization('Dead Successor Co');
    const execute = dispatcher();
    await execute({
      actionType: 'retire_organization',
      actorId: dead.personId,
      actingRoleId: dead.roleAssignmentId,
      targetIds: [dead.organizationId],
      organizationId: dead.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `retire-${randomUUID()}`,
      reason: 'retired first so it can be named as a dead successor',
      payload: { with_people: true },
    });

    const merged = await foundOrganization('Merged Away Co');
    const base = {
      actionType: 'retire_organization',
      actorId: merged.personId,
      actingRoleId: merged.roleAssignmentId,
      targetIds: [merged.organizationId],
      organizationId: merged.organizationId,
      maxClassification: 'restricted',
      reason: 'merged into the fixture organization by acquisition',
    } as const;
    await expect(
      execute({
        ...base,
        idempotencyKey: `retire-${randomUUID()}`,
        payload: { with_people: true, successor_organization_id: dead.organizationId },
      }),
    ).rejects.toMatchObject({ name: 'ActionRejected', failure: 'precondition_failed' });

    const applied = await execute({
      ...base,
      idempotencyKey: `retire-${randomUUID()}`,
      payload: { with_people: true, successor_organization_id: fixtures.organizationId },
    });
    expect(applied.status).toBe('applied');
    const row = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{ succeeded_by: string | null; retired_at: Date | null }>(
        'select succeeded_by, retired_at from org.organization where id = $1',
        [merged.organizationId],
      ),
    );
    expect(row.succeeded_by).toBe(fixtures.organizationId);
    expect(row.retired_at).not.toBeNull();
  });
});

describe('kf retire-organization (bootstrap tier)', () => {
  it('refuses an organization somebody can act in', async () => {
    await expect(
      runRetireOrganization(harness.adminPool, {
        organizationId: fixtures.organizationId,
        reason: 'the fixture organization has a performer and a reviewer',
        decidedBy: fixtures.reviewerId,
        withPeople: true,
      }),
    ).rejects.toThrow(/live role assignment/);
    expect(await objectState(fixtures.organizationId, fixtures.organizationId)).toBe('active');
  });

  it('retires an organization nobody can act in, through the act’s own precondition and effect', async () => {
    // Bootstrapped, never granted: the exact shape of a duplicate created by a defect.
    const orphan = await runBootstrap(harness.adminPool, {
      legalName: `Orphan Duplicate Co (${randomUUID()})`,
      personName: 'Stranded Person',
      organizationKind: 'company',
      organizationId: '',
    });
    await expect(
      runRetireOrganization(harness.adminPool, {
        organizationId: orphan.organizationId,
        reason: 'duplicate created by the bootstrap name-lookup defect',
        decidedBy: fixtures.reviewerId,
        withPeople: false,
      }),
    ).rejects.toMatchObject({ name: 'ActionRejected', failure: 'precondition_failed' });

    const result = await runRetireOrganization(harness.adminPool, {
      organizationId: orphan.organizationId,
      reason: 'duplicate created by the bootstrap name-lookup defect',
      decidedBy: fixtures.reviewerId,
      withPeople: true,
    });
    expect(result.peopleDeactivated.map((person) => person.id)).toEqual([orphan.personId]);
    expect(await objectState(orphan.organizationId, orphan.organizationId)).toBe('retired');
    expect(await objectState(orphan.personId, orphan.organizationId)).toBe('inactive');

    const head = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{ digest: string }>('select digest from core.audit_chain_head'),
    );
    expect(head.digest).toBe(result.auditDigest);
  });
});

describe('deactivate_person', () => {
  it('ends the person’s authority and refuses self-deactivation', async () => {
    const founded = await foundOrganization('Deactivation Co');
    const second = await runBootstrap(harness.adminPool, {
      legalName: '',
      personName: 'Leaver',
      organizationKind: 'company',
      organizationId: founded.organizationId,
    });
    await runGrantAuthority(harness.adminPool, {
      personId: second.personId,
      organizationId: founded.organizationId,
      roleId: 'performer',
      classification: 'internal',
      grantedBy: founded.personId,
      reason: 'admitted so that leaving has something to end',
    });
    const execute = dispatcher();
    await expect(
      execute({
        actionType: 'deactivate_person',
        actorId: founded.personId,
        actingRoleId: founded.roleAssignmentId,
        targetIds: [founded.personId],
        organizationId: founded.organizationId,
        maxClassification: 'restricted',
        idempotencyKey: `deactivate-${randomUUID()}`,
        reason: 'trying to deactivate myself',
      }),
    ).rejects.toMatchObject({ name: 'ActionRejected', failure: 'precondition_failed' });

    const applied = await execute({
      actionType: 'deactivate_person',
      actorId: founded.personId,
      actingRoleId: founded.roleAssignmentId,
      targetIds: [second.personId],
      organizationId: founded.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `deactivate-${randomUUID()}`,
      reason: 'left the company on 2026-09-11',
    });
    expect(applied.status).toBe('applied');
    expect(await objectState(second.personId, founded.organizationId)).toBe('inactive');
    expect(await liveAuthority(second.personId, founded.organizationId)).toEqual({
      roles: 0,
      clearances: 0,
      retirements: 1,
    });
    // The founder is untouched.
    expect(await liveAuthority(founded.personId, founded.organizationId)).toEqual({
      roles: 1,
      clearances: 1,
      retirements: 0,
    });
  });
});
