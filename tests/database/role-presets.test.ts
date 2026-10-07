import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InMemoryObjectStore } from '@kf/artifacts';
import {
  enumerateAccessCoverage,
  explainAccess,
  listRolePresets,
  type AccessExplanation,
} from '@kf/authorization';
import { attestationFor, withTransaction, type Tx } from '@kf/database';
import { createDocumentActionAtoms, enumeratePermittedSet } from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
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
 * Roles as composable presets of scope (ADR 0040 decision 4; KF-SAS-RQ-269, RQ-270;
 * migration 20261007200000). Against a real database, through the dispatcher:
 *
 *   1. A preset reaches a holder only as rows of `org.effective_access_grant`, and a composed
 *      preset grants EXACTLY the union of the presets reachable through inclusion — compared with
 *      an independent walk of the graph in this file, not with the view's own answer.
 *   2. The database refuses an inclusion that closes a cycle, the shortest and a longer one, on the
 *      dispatcher path and on a direct write; and two concurrent halves of a cycle cannot both land.
 *   3. Retiring an inclusion takes the included role's scope away; retiring a template takes it.
 *   4. The access explanation names the role path by which a grant arrived.
 *   5. A template above a holder's clearance admits nothing above it: the session ceiling is the
 *      clearance, and row security still hides the record (KF-SAS-RQ-038).
 *   6. Defining or changing a preset is institutional: refused without act authority over the
 *      organization, and refused when the act does not target the organization.
 *   7. A preset travels only with an organization-scoped assignment, ends when the assignment ends
 *      (ADR 0036), and changes nothing about the seeded roles or their assignments.
 */

let h: Harness;
let f: Fixtures;
/** Cleared to `internal`; holds `m3_engineer` organization-wide, capped at `public`. */
let engineer: string;
let engineerRole: string;
/** Holds `m3_engineer` scoped to one project only. */
let narrow: string;
let narrowRole: string;
let project: string;
let docA: string;
let docB: string;
let docSecret: string;
let docStaff: string;

const ROLES = ['m3_staff', 'm3_engineer', 'm3_executive', 'm3_ceo', 'm3_auditor'] as const;

async function classify(id: string, classification: string): Promise<void> {
  await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f, f.reviewerId);
    await tx.query(
      'update core.object set classification = $2, row_version = row_version + 1 where id = $1',
      [id, classification],
    );
  });
}

async function person(
  name: string,
  clearance: string,
  role: string,
  scope: string | undefined,
  ceiling: string | null,
): Promise<{ id: string; assignment: string }> {
  const id = await createObject(h.adminPool, f, {
    type: 'person',
    domain: 'organization',
    state: 'active',
    title: name,
    createdBy: f.reviewerId,
  });
  const assignment = await createObject(h.adminPool, f, {
    type: 'role_assignment',
    domain: 'organization',
    state: 'active',
    title: `${role} assignment of ${name}`,
    createdBy: f.reviewerId,
  });
  await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f, f.reviewerId);
    await tx.query('insert into org.person (id, display_name, organization) values ($1, $2, $3)', [
      id,
      name,
      f.organizationId,
    ]);
    await tx.query(
      `insert into org.person_clearance
         (subject_id, organization_id, max_classification, granted_by, granted_by_action, reason)
       values ($1, $2, $3, $4, $5, 'role preset fixture')`,
      [id, f.organizationId, clearance, f.reviewerId, f.clearanceActionId],
    );
    await tx.query(
      `insert into org.role_assignment
         (id, subject_id, role_id, scope_id, valid_to, classification_ceiling)
       values ($1, $2, $3, $4, now() + interval '300 days', $5)`,
      [assignment, id, role, scope ?? f.organizationId, ceiling],
    );
  });
  return { id, assignment };
}

beforeAll(async () => {
  h = await startHarness({ realisticOwner: true });
  f = await seedFixtures(h.adminPool);
  await withTransaction(h.adminPool, async (tx) => {
    for (const role of ROLES) {
      await tx.query('insert into org.role (id, description) values ($1, $2)', [
        role,
        `fixture role ${role} for the role-preset suite`,
      ]);
    }
  });
  const make = (title: string) =>
    createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title,
      createdBy: f.reviewerId,
    });
  docA = await make('Engineering standard A');
  docB = await make('Staff handbook B');
  docSecret = await make('Board minutes');
  docStaff = await make('Canteen menu');
  await classify(docSecret, 'confidential');
  project = await createObject(h.adminPool, f, {
    type: 'initiative_project',
    domain: 'project',
    state: 'captured',
    title: 'The narrow project',
    createdBy: f.reviewerId,
  });
  ({ id: engineer, assignment: engineerRole } = await person(
    'Engineer',
    'internal',
    'm3_engineer',
    undefined,
    'public',
  ));
  ({ id: narrow, assignment: narrowRole } = await person(
    'Narrow',
    'internal',
    'm3_engineer',
    project,
    null,
  ));
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

const dispatcher = () =>
  createFabricDispatcher(
    h.pool,
    createDocumentActionAtoms({
      store: new InMemoryObjectStore(),
      parser: {
        async parse() {
          return undefined;
        },
      },
    }),
  );

/** An act by the reviewer, who holds technical_authority organization-wide (and so `act`). */
async function act(
  actionType: string,
  payload: Record<string, string>,
  targetIds: readonly string[] = [f.organizationId],
  as: { actorId: string; actingRoleId: string } = {
    actorId: f.reviewerId,
    actingRoleId: f.reviewerRoleId,
  },
) {
  return dispatcher()({
    actionType,
    ...as,
    targetIds,
    organizationId: f.organizationId,
    maxClassification: as.actorId === f.reviewerId ? 'restricted' : 'internal',
    idempotencyKey: `${actionType}-${randomUUID()}`,
    reason: `role preset suite: ${actionType}`,
    payload,
  });
}

async function coverageOf(personId: string) {
  return withTransaction(h.pool, async (tx) => {
    await bindReader(tx, f, f.reviewerId);
    return enumerateAccessCoverage(tx, personId, f.organizationId);
  });
}

/** Bind a non-fixture person as themselves, at a ceiling of their choosing. */
async function bindAs(tx: Tx, personId: string, actingRoleId: string, ceiling = 'internal') {
  const principal = {
    actorId: personId,
    actingRoleId,
    organizationId: f.organizationId,
    maxClassification: ceiling,
  };
  await tx.query('select core.bind_principal($1, $2, $3, $4, $5)', [
    personId,
    actingRoleId,
    f.organizationId,
    ceiling,
    (await attestationFor(tx, principal)) ?? null,
  ]);
}

async function permittedOf(personId: string, actingRoleId: string) {
  return withTransaction(h.pool, async (tx) => {
    await bindAs(tx, personId, actingRoleId);
    return (await enumeratePermittedSet(tx, personId, f.organizationId)).map((m) => m.objectId);
  });
}

async function explain(personId: string, objectId: string): Promise<AccessExplanation> {
  return withTransaction(h.pool, async (tx) => {
    await bindReader(tx, f, f.reviewerId);
    return explainAccess(tx, { personId, organizationId: f.organizationId, objectId });
  });
}

/** The preset rows as stored, read on the owner credential: the independent side of every check. */
async function presetRows() {
  return withTransaction(h.adminPool, async (tx) => ({
    templates: await tx.query<{ id: string; role_id: string; scope_object_id: string }>(
      `select id, role_id, scope_object_id from org.role_preset_grant
        where organization_id = $1 and retired_at is null and capability = 'read'`,
      [f.organizationId],
    ),
    inclusions: await tx.query<{ id: string; role_id: string; included_role_id: string }>(
      `select id, role_id, included_role_id from org.role_inclusion
        where organization_id = $1 and retired_at is null`,
      [f.organizationId],
    ),
  }));
}

/** Every role reachable from `role` through live inclusions, walked here, not by the view. */
function reachable(
  role: string,
  inclusions: readonly { role_id: string; included_role_id: string }[],
) {
  const seen = new Set([role]);
  const frontier = [role];
  while (frontier.length > 0) {
    const next = frontier.pop()!;
    for (const edge of inclusions) {
      if (edge.role_id === next && !seen.has(edge.included_role_id)) {
        seen.add(edge.included_role_id);
        frontier.push(edge.included_role_id);
      }
    }
  }
  return seen;
}

/** The scope objects a role's composed preset grants, computed from the rows alone. */
async function expectedScopes(role: string): Promise<string[]> {
  const { templates, inclusions } = await presetRows();
  const roles = reachable(role, inclusions);
  return [
    ...new Set(templates.filter((t) => roles.has(t.role_id)).map((t) => t.scope_object_id)),
  ].sort();
}

async function presetScopesOf(personId: string): Promise<string[]> {
  const coverage = await coverageOf(personId);
  const grants = [...coverage.organizationWide, ...[...coverage.byObject.values()].flat()];
  return [
    ...new Set(grants.filter((g) => g.source === 'role_preset').map((g) => g.scopeObjectId)),
  ].sort();
}

describe('a role is a preset of scope', () => {
  it('grants nothing before it has a preset, and the seeded roles read exactly as before', async () => {
    expect(await presetScopesOf(engineer)).toEqual([]);
    const reviewer = await coverageOf(f.reviewerId);
    expect(reviewer.organizationWide).toEqual([
      expect.objectContaining({
        source: 'role_assignment',
        reason: 'role technical_authority',
        rolePath: ['technical_authority'],
      }),
    ]);
    // The engineer's assignment is capped at public: internal records need a grant.
    expect(await permittedOf(engineer, engineerRole)).not.toContain(docA);
  });

  it('projects a template into the one grant view, and the composed preset is exactly the union', async () => {
    await act('grant_role_scope', { role_id: 'm3_engineer', capability: 'read' }, [
      f.organizationId,
      docA,
    ]);
    await act('grant_role_scope', { role_id: 'm3_staff', capability: 'read' }, [
      f.organizationId,
      docB,
    ]);
    await act('grant_role_scope', { role_id: 'm3_executive', capability: 'read' }, [
      f.organizationId,
      docStaff,
    ]);
    expect(await presetScopesOf(engineer)).toEqual([docA]);
    expect(await presetScopesOf(engineer)).toEqual(await expectedScopes('m3_engineer'));

    await act('include_role', { role_id: 'm3_engineer', included_role_id: 'm3_staff' });
    expect(await presetScopesOf(engineer)).toEqual([docA, docB].sort());
    expect(await presetScopesOf(engineer)).toEqual(await expectedScopes('m3_engineer'));
    // Union, not more: the executive preset is not reachable from the engineer role.
    expect(await presetScopesOf(engineer)).not.toContain(docStaff);
    const permitted = await permittedOf(engineer, engineerRole);
    expect(permitted).toEqual(expect.arrayContaining([docA, docB]));
    expect(permitted).not.toContain(docStaff);
  });

  it('names the role path in the explanation of access (KF-SAS-RQ-270)', async () => {
    const viaInclusion = await explain(engineer, docB);
    expect(viaInclusion.decision).toBe('visible');
    expect(viaInclusion.format).toBe('kf-access-explanation-v2');
    const step = viaInclusion.steps.find((s) => s.step === 'grant_coverage');
    expect(step?.detail['grants']).toEqual([
      expect.objectContaining({
        source: 'role_preset',
        scope: 'object',
        rolePath: ['m3_engineer', 'm3_staff'],
      }),
    ]);
    const direct = await explain(engineer, docA);
    expect(direct.steps.find((s) => s.step === 'grant_coverage')?.detail['grants']).toEqual([
      expect.objectContaining({ source: 'role_preset', rolePath: ['m3_engineer'] }),
    ]);
  });

  it('refuses a cycle: the shortest, a longer one, and on a direct write as well', async () => {
    await expect(
      act('include_role', { role_id: 'm3_staff', included_role_id: 'm3_engineer' }),
    ).rejects.toMatchObject({
      name: 'ActionRejected',
      failure: 'precondition_failed',
      message: expect.stringMatching(/cycle: m3_staff includes m3_engineer includes m3_staff/),
    });
    await act('include_role', { role_id: 'm3_ceo', included_role_id: 'm3_executive' });
    await act('include_role', { role_id: 'm3_executive', included_role_id: 'm3_engineer' });
    await expect(
      act('include_role', { role_id: 'm3_staff', included_role_id: 'm3_ceo' }),
    ).rejects.toMatchObject({
      failure: 'precondition_failed',
      message: expect.stringMatching(
        /cycle: m3_staff includes m3_ceo includes m3_executive includes m3_engineer includes m3_staff/,
      ),
    });
    // Itself, refused by the constraint before the trigger is asked.
    await expect(
      act('include_role', { role_id: 'm3_staff', included_role_id: 'm3_staff' }),
    ).rejects.toMatchObject({ failure: 'precondition_failed' });
    // Not only the dispatcher: a write that bypasses it meets the same trigger.
    await expect(
      withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f, f.reviewerId);
        await tx.query(
          `insert into org.role_inclusion
             (organization_id, role_id, included_role_id, reason, defined_by, defined_by_action)
           values ($1, 'm3_engineer', 'm3_ceo', 'a direct write', $2, $3)`,
          [f.organizationId, f.reviewerId, f.clearanceActionId],
        );
      }),
    ).rejects.toThrow(/would form a cycle/);
    // The composed preset is still the union: ceo reaches executive, engineer and staff.
    const ceo = await expectedScopes('m3_ceo');
    expect(ceo).toEqual([docA, docB, docStaff].sort());
  });

  it('serializes the cycle check: two concurrent halves of one cycle cannot both land', async () => {
    const insert = (tx: Tx, from: string, to: string) =>
      tx.query(
        `insert into org.role_inclusion
           (organization_id, role_id, included_role_id, reason, defined_by, defined_by_action)
         values ($1, $2, $3, 'concurrent half', $4, $5)`,
        [f.organizationId, from, to, f.reviewerId, f.clearanceActionId],
      );
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstInserted!: () => void;
    const inserted = new Promise<void>((resolve) => {
      firstInserted = resolve;
    });
    // The first half inserts and holds its transaction open; the second starts while it does.
    const first = withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f, f.reviewerId);
      await insert(tx, 'm3_auditor', 'm3_ceo');
      firstInserted();
      await released;
    });
    await inserted;
    const second = withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f, f.reviewerId);
      await insert(tx, 'm3_ceo', 'm3_auditor');
    }).then(
      () => 'inserted',
      (error: Error) => error.message,
    );
    // The second blocks on the organization's lock until the first commits, then sees its row.
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await first;
    expect(await second).toMatch(/would form a cycle: m3_ceo includes m3_auditor includes m3_ceo/);
    // Under REPEATABLE READ the check could read a snapshot older than the other half; refused.
    await expect(
      withTransaction(h.adminPool, async (tx) => {
        await tx.query('set transaction isolation level repeatable read');
        await bindContext(tx, f, f.reviewerId);
        await tx.query(
          `insert into org.role_inclusion
             (organization_id, role_id, included_role_id, reason, defined_by, defined_by_action)
           values ($1, 'm3_auditor', 'm3_staff', 'repeatable read', $2, $3)`,
          [f.organizationId, f.reviewerId, f.clearanceActionId],
        );
      }),
    ).rejects.toThrow(/READ COMMITTED/);
  });

  it('takes scope away when an inclusion or a template is retired, leaving the rows as evidence', async () => {
    const { inclusions, templates } = await presetRows();
    const engineerStaff = inclusions.find(
      (i) => i.role_id === 'm3_engineer' && i.included_role_id === 'm3_staff',
    )!;
    await act('exclude_role', { inclusion_id: engineerStaff.id });
    expect(await presetScopesOf(engineer)).toEqual([docA]);
    expect(await presetScopesOf(engineer)).toEqual(await expectedScopes('m3_engineer'));
    expect(await permittedOf(engineer, engineerRole)).not.toContain(docB);

    const engineerA = templates.find((t) => t.role_id === 'm3_engineer')!;
    await act('revoke_role_scope', { preset_grant_id: engineerA.id });
    expect(await presetScopesOf(engineer)).toEqual([]);
    expect(await permittedOf(engineer, engineerRole)).not.toContain(docA);

    const kept = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ retired_by: string | null }>(
        `select retired_by from org.role_inclusion where id = $1
         union all select retired_by from org.role_preset_grant where id = $2`,
        [engineerStaff.id, engineerA.id],
      ),
    );
    expect(kept.map((row) => row.retired_by)).toEqual([f.reviewerId, f.reviewerId]);
    // Retired once; a retired row says what it said, and nothing else may be changed in it.
    await expect(act('exclude_role', { inclusion_id: engineerStaff.id })).rejects.toMatchObject({
      failure: 'precondition_failed',
    });
    await expect(
      withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f, f.reviewerId);
        await tx.query("update org.role_preset_grant set role_id = 'm3_ceo' where id = $1", [
          engineerA.id,
        ]);
      }),
    ).rejects.toThrow(/already retired|may only be retired/);
  });

  it('never admits a record above the clearance, whatever a template says (KF-SAS-RQ-038)', async () => {
    await act(
      'grant_role_scope',
      { role_id: 'm3_engineer', capability: 'read', classification_ceiling: 'restricted' },
      [f.organizationId, docSecret],
    );
    expect(await presetScopesOf(engineer)).toContain(docSecret);
    expect(await permittedOf(engineer, engineerRole)).not.toContain(docSecret);
    const explanation = await explain(engineer, docSecret);
    expect(explanation.deniedBy).toBe('classification_within_clearance');
    // The session ceiling is the clearance; asking for the template's ceiling is refused.
    await expect(
      withTransaction(h.pool, (tx) => bindAs(tx, engineer, engineerRole, 'restricted')),
    ).rejects.toThrow(/exceeds clearance/);
  });

  it('travels only with an organization-scoped assignment, and ends when the assignment does', async () => {
    await act('grant_role_scope', { role_id: 'm3_engineer', capability: 'read' }, [
      f.organizationId,
      docA,
    ]);
    expect(await presetScopesOf(engineer)).toContain(docA);
    // The same role, assigned to one project, confers that project and no preset.
    expect(await presetScopesOf(narrow)).toEqual([]);
    const rows = await withTransaction(h.pool, async (tx) => {
      await bindReader(tx, f, f.reviewerId);
      return tx.query<{ valid_to: Date; assignment_end: Date }>(
        `select g.valid_to, ra.valid_to as assignment_end
           from org.effective_access_grant g, org.role_assignment ra
          where g.source = 'role_preset' and g.principal_id = $1 and ra.id = $2`,
        [engineer, engineerRole],
      );
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(new Date(row.valid_to).getTime()).toBe(new Date(row.assignment_end).getTime());
      expect(new Date(row.valid_to).getTime() - Date.now()).toBeLessThanOrEqual(366 * 86_400_000);
    }
  });

  it('is institutional: refused without act authority over the organization, or without targeting it', async () => {
    // Act authority over one project is not authority over what a role grants everywhere: aimed at
    // the organization the act is refused for want of an act grant, and aimed at the project the
    // preset refuses it for not naming the organization.
    await expect(
      act('grant_role_scope', { role_id: 'm3_staff', capability: 'read' }, [f.organizationId], {
        actorId: narrow,
        actingRoleId: narrowRole,
      }),
    ).rejects.toMatchObject({ failure: 'act_not_granted' });
    await expect(
      act('grant_role_scope', { role_id: 'm3_staff', capability: 'read' }, [project], {
        actorId: narrow,
        actingRoleId: narrowRole,
      }),
    ).rejects.toMatchObject({
      failure: 'precondition_failed',
      message: expect.stringMatching(/must target the organization/),
    });
    await expect(
      act('include_role', { role_id: 'm3_staff', included_role_id: 'm3_auditor' }, [project]),
    ).rejects.toMatchObject({
      failure: 'precondition_failed',
      message: expect.stringMatching(/must target the organization/),
    });
    // And an act no one recorded cannot write one: the act write guard refuses it.
    await expect(
      withTransaction(h.pool, async (tx) => {
        await bindReader(tx, f, f.reviewerId);
        await tx.query(
          `insert into org.role_inclusion
             (organization_id, role_id, included_role_id, reason, defined_by, defined_by_action)
           values ($1, 'm3_auditor', 'm3_staff', 'no act', $2, $3)`,
          [f.organizationId, f.reviewerId, f.clearanceActionId],
        );
      }),
    ).rejects.toThrow();
  });

  it('lists the presets as far as the reader can see their scopes', async () => {
    const roles = await withTransaction(h.pool, async (tx) => {
      await bindReader(tx, f, f.reviewerId);
      return listRolePresets(tx, f.organizationId);
    });
    const ceo = roles.find((role) => role.roleId === 'm3_ceo');
    expect(ceo?.includes.map((i) => i.roleId)).toEqual(['m3_executive']);
    const engineerRolePreset = roles.find((role) => role.roleId === 'm3_engineer');
    expect(engineerRolePreset?.templates.map((t) => t.scopeObjectId).sort()).toEqual(
      [docA, docSecret].sort(),
    );
    // A reader capped below the confidential record does not learn that a role grants it.
    const asEngineer = await withTransaction(h.pool, async (tx) => {
      await bindAs(tx, engineer, engineerRole);
      return listRolePresets(tx, f.organizationId);
    });
    expect(
      asEngineer
        .find((role) => role.roleId === 'm3_engineer')
        ?.templates.map((t) => t.scopeObjectId),
    ).toEqual([docA]);
  });
});
