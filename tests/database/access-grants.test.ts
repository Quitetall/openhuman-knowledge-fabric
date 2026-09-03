import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Fastify from 'fastify';
import { InMemoryObjectStore } from '@kf/artifacts';
import { enumerateAccessCoverage, explainAccess, type AccessExplanation } from '@kf/authorization';
import { withTransaction } from '@kf/database';
import { createDocumentActionAtoms, enumeratePermittedSet } from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
import { loadProjectionDefinitions } from '@kf/projections';
import { registerAccessExplanationRoute } from '../../apps/api/src/routes/documents/access-explanation-route.js';
import type { DocumentRoutesOptions } from '../../apps/api/src/routes/documents/contracts.js';
import {
  bindContext,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

/**
 * Access is a grant (ADR 0016). Against a real database:
 *
 *   1. Existing authority is unchanged: an organization-scoped role assignment reads as an
 *      organization-wide grant through the same view, so every fixture keeps its corpus.
 *   2. Need-to-know is positive: a cleared person with no grant has an EMPTY permitted set;
 *      one dispatched `grant_access` admits exactly the granted object; an overlapping live
 *      grant is refused as a precondition failure; `revoke_access` takes it away again and
 *      leaves the row as evidence.
 *   3. The guard bites: a principal of the wrong kind is refused, not recorded.
 *   4. An explanation is the path, ending in the fact that decided — here an entitlement
 *      exclusion on a person whose grant coverage passes.
 *   5. `GET /objects/:id/access` serves it, and answers _not found_ for an object the asker
 *      cannot see, whoever they ask about.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const ARTIFACT = join(ROOT, 'generated', 'projections', 'knowledge-fabric.projections.json');

let harness: Harness;
let fixtures: Fixtures;
let outsider: string;
let probe: string;

beforeAll(async () => {
  harness = await startHarness();
  fixtures = await seedFixtures(harness.adminPool);
  probe = await createObject(harness.adminPool, fixtures, {
    type: 'decision_record',
    domain: 'engineering',
    state: 'draft',
    title: 'Access probe',
    createdBy: fixtures.performerId,
  });
  // A cleared person who holds NO role: nothing grants them anything yet.
  outsider = await createObject(harness.adminPool, fixtures, {
    type: 'person',
    domain: 'organization',
    state: 'active',
    title: 'Outsider',
    createdBy: fixtures.reviewerId,
  });
  await withTransaction(harness.adminPool, async (tx) => {
    await bindContext(tx, fixtures, fixtures.reviewerId);
    await tx.query('insert into org.person (id, display_name, organization) values ($1, $2, $3)', [
      outsider,
      'Outsider',
      fixtures.organizationId,
    ]);
    await tx.query(
      `insert into org.person_clearance
         (subject_id, organization_id, max_classification, granted_by, granted_by_action, reason)
       values ($1, $2, 'restricted', $3, $4, 'fixture clearance for the ungranted person')`,
      [outsider, fixtures.organizationId, fixtures.reviewerId, fixtures.clearanceActionId],
    );
  });
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

async function permittedFor(personId: string): Promise<readonly string[]> {
  return withTransaction(harness.pool, async (tx) => {
    await tx.query('select core.set_access_context($1, $2)', [
      fixtures.organizationId,
      'restricted',
    ]);
    const members = await enumeratePermittedSet(tx, personId, fixtures.organizationId);
    return members.map((member) => member.objectId);
  });
}

async function explainFor(personId: string, objectId: string): Promise<AccessExplanation> {
  return withTransaction(harness.pool, async (tx) => {
    await tx.query('select core.set_access_context($1, $2)', [
      fixtures.organizationId,
      'restricted',
    ]);
    return explainAccess(tx, { personId, organizationId: fixtures.organizationId, objectId });
  });
}

function routeOptions(actorId: string, actingRoleId: string): DocumentRoutesOptions {
  return {
    pool: harness.pool,
    projections: loadProjectionDefinitions(ARTIFACT),
    identify: async () => ({
      actorId,
      actingRoleId,
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      authentication: { authenticatedAt: undefined, assuranceLevel: undefined, methods: [] },
    }),
    store: undefined,
    preflightInTransaction: async () => undefined,
    executeInTransaction: async () => {
      throw new Error('an access explanation does not execute an action');
    },
  };
}

describe('access is a grant', () => {
  it('reads an organization-scoped role assignment as organization-wide read and act', async () => {
    const rows = await withTransaction(harness.pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [
        fixtures.organizationId,
        'restricted',
      ]);
      return tx.query<{ capability: string; scope_object_id: string; source: string }>(
        `select source, capability, scope_object_id from org.effective_access_grant
          where principal_id = $1 order by capability`,
        [fixtures.performerId],
      );
    });
    expect(rows).toEqual([
      expect.objectContaining({
        source: 'role_assignment',
        capability: 'act',
        scope_object_id: fixtures.organizationId,
      }),
      expect.objectContaining({
        source: 'role_assignment',
        capability: 'read',
        scope_object_id: fixtures.organizationId,
      }),
    ]);
    const coverage = await withTransaction(harness.pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [
        fixtures.organizationId,
        'restricted',
      ]);
      return enumerateAccessCoverage(tx, fixtures.performerId, fixtures.organizationId);
    });
    expect(coverage.organizationWide.map((grant) => grant.source)).toEqual(['role_assignment']);
    expect(await permittedFor(fixtures.performerId)).toContain(probe);
  });

  it('admits exactly the granted object, refuses an overlap, and revokes as evidence', async () => {
    expect(await permittedFor(outsider)).toEqual([]);
    expect((await explainFor(outsider, probe)).deniedBy).toBe('grant_coverage');

    const execute = dispatcher();
    const granted = await execute({
      actionType: 'grant_access',
      actorId: fixtures.performerId,
      actingRoleId: fixtures.performerRoleId,
      targetIds: [probe],
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `grant-${randomUUID()}`,
      reason: 'the outsider reviews this one decision',
      payload: { principal_kind: 'person', principal_id: outsider, capability: 'read' },
    });
    expect(granted.status, JSON.stringify(granted)).toBe('applied');
    expect(await permittedFor(outsider)).toEqual([probe]);

    const visible = await explainFor(outsider, probe);
    expect(visible.decision).toBe('visible');
    expect(visible.deniedBy).toBeUndefined();
    const coverageStep = visible.steps.find((step) => step.step === 'grant_coverage');
    expect(coverageStep?.outcome).toBe('pass');
    expect(coverageStep?.detail['grants']).toEqual([
      expect.objectContaining({ source: 'access_grant', scope: 'object' }),
    ]);

    const overlapping = execute({
      actionType: 'grant_access',
      actorId: fixtures.performerId,
      actingRoleId: fixtures.performerRoleId,
      targetIds: [probe],
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `grant-${randomUUID()}`,
      reason: 'a second, overlapping grant of the same thing',
      payload: { principal_kind: 'person', principal_id: outsider, capability: 'read' },
    });
    await expect(overlapping).rejects.toMatchObject({
      name: 'ActionRejected',
      failure: 'precondition_failed',
    });

    const grantId = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{ id: string }>(
        `select id from org.access_grant where principal_id = $1 and scope_object_id = $2
            and revoked_at is null`,
        [outsider, probe],
      ),
    );
    const revoked = await execute({
      actionType: 'revoke_access',
      actorId: fixtures.performerId,
      actingRoleId: fixtures.performerRoleId,
      targetIds: [probe],
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `revoke-${randomUUID()}`,
      reason: 'review finished',
      payload: { grant_id: grantId.id },
    });
    expect(revoked.status, JSON.stringify(revoked)).toBe('applied');
    expect(await permittedFor(outsider)).toEqual([]);
    expect((await explainFor(outsider, probe)).deniedBy).toBe('grant_coverage');

    const row = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{ revoked_by: string; revocation_reason: string; revoked_by_action: string }>(
        'select revoked_by, revocation_reason, revoked_by_action from org.access_grant where id = $1',
        [grantId.id],
      ),
    );
    expect(row.revoked_by).toBe(fixtures.performerId);
    expect(row.revocation_reason).toBe('review finished');
    expect(row.revoked_by_action).not.toBeNull();
  });

  it('refuses a principal of the wrong kind before anything is recorded', async () => {
    const wrongKind = dispatcher()({
      actionType: 'grant_access',
      actorId: fixtures.performerId,
      actingRoleId: fixtures.performerRoleId,
      targetIds: [probe],
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `grant-${randomUUID()}`,
      reason: 'a person offered as a role assignment',
      payload: { principal_kind: 'role_assignment', principal_id: outsider, capability: 'read' },
    });
    await expect(wrongKind).rejects.toMatchObject({
      name: 'ActionRejected',
      failure: 'precondition_failed',
    });
    const count = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{ count: string }>(
        `select count(*)::text as count from org.access_grant
          where principal_id = $1 and principal_kind = 'role_assignment'`,
        [outsider],
      ),
    );
    expect(count.count).toBe('0');
  });

  it('explains a denial as the path ending in the exclusion that decided', async () => {
    // Its own object: an exclusion is append-only and its release is a recorded act of its
    // own, so the plant stays and the other tests keep the unexcluded probe.
    const excluded = await createObject(harness.adminPool, fixtures, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Excluded probe',
      createdBy: fixtures.performerId,
    });
    expect(await permittedFor(fixtures.performerId)).toContain(excluded);
    const exclusion = await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, fixtures, fixtures.reviewerId);
      return tx.one<{ id: string }>(
        `insert into content.person_entitlement_exclusion
           (subject_id, organization_id, object_id, reason_class, reason, authorizer,
            created_by_action)
         values ($1, $2, $3, 'exclusion', 'conflict of interest', $4, $5)
         returning id`,
        [
          fixtures.performerId,
          fixtures.organizationId,
          excluded,
          fixtures.reviewerId,
          fixtures.clearanceActionId,
        ],
      );
    });
    const explanation = await explainFor(fixtures.performerId, excluded);
    expect(explanation.decision).toBe('denied');
    expect(explanation.deniedBy).toBe('entitlement_exclusion');
    expect(explanation.steps.map((step) => [step.step, step.outcome])).toEqual([
      ['organization_membership', 'pass'],
      ['object_in_organization', 'pass'],
      ['clearance', 'pass'],
      ['classification_within_clearance', 'pass'],
      ['grant_coverage', 'pass'],
      ['entitlement_exclusion', 'fail'],
      ['retention_hold', 'pass'],
    ]);
    const step = explanation.steps.find((s) => s.step === 'entitlement_exclusion');
    expect(step?.detail['exclusions']).toEqual([
      expect.objectContaining({ id: exclusion.id, reason: 'conflict of interest' }),
    ]);
    expect(await permittedFor(fixtures.performerId)).not.toContain(excluded);
    expect(await permittedFor(fixtures.performerId)).toContain(probe);

    // And the route: the excluded object is not found for the excluded person.
    const app = Fastify({ logger: false });
    registerAccessExplanationRoute(
      app,
      routeOptions(fixtures.performerId, fixtures.performerRoleId),
    );
    await app.ready();
    try {
      const hidden = await app.inject({ method: 'GET', url: `/objects/${excluded}/access` });
      expect(hidden.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('honours act: an institutional act needs an act grant reaching the target (ADR 0016)', async () => {
    // A project-scoped role for the outsider: read and act on the PROJECT object only.
    const project = await createObject(harness.adminPool, fixtures, {
      type: 'initiative_project',
      domain: 'project',
      state: 'captured',
      title: 'Scoped project',
      createdBy: fixtures.reviewerId,
    });
    const roleObject = await createObject(harness.adminPool, fixtures, {
      type: 'role_assignment',
      domain: 'organization',
      state: 'active',
      title: 'performer on one project',
      createdBy: fixtures.reviewerId,
    });
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, fixtures, fixtures.reviewerId);
      await tx.query(
        'insert into org.role_assignment (id, subject_id, role_id, scope_id) values ($1,$2,$3,$4)',
        [roleObject, outsider, 'performer', project],
      );
    });
    // The outsider can SEE the probe through a read grant, but holds no act authority there.
    const target = await createObject(harness.adminPool, fixtures, {
      type: 'controlled_document',
      domain: 'quality',
      state: 'draft',
      title: 'Numbered by whom',
      createdBy: fixtures.performerId,
    });
    const execute = dispatcher();
    await execute({
      actionType: 'grant_access',
      actorId: fixtures.performerId,
      actingRoleId: fixtures.performerRoleId,
      targetIds: [target],
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `grant-${randomUUID()}`,
      reason: 'the outsider may read the document',
      payload: { principal_kind: 'person', principal_id: outsider, capability: 'read' },
    });
    const asOutsider = () =>
      execute({
        actionType: 'allocate_enterprise_identifier',
        actorId: outsider,
        actingRoleId: roleObject,
        targetIds: [target],
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
        idempotencyKey: `allocate-${randomUUID()}`,
        reason: 'numbering from a project-scoped role',
      });
    await expect(asOutsider()).rejects.toMatchObject({
      name: 'ActionRejected',
      failure: 'act_not_granted',
    });
    const before = await explainFor(outsider, target);
    expect(before.decision).toBe('visible');
    const actBefore = await withTransaction(harness.pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [
        fixtures.organizationId,
        'restricted',
      ]);
      return explainAccess(tx, {
        personId: outsider,
        organizationId: fixtures.organizationId,
        objectId: target,
        capability: 'act',
      });
    });
    expect(actBefore.capability).toBe('act');
    expect(actBefore.deniedBy).toBe('grant_coverage');

    await execute({
      actionType: 'grant_access',
      actorId: fixtures.performerId,
      actingRoleId: fixtures.performerRoleId,
      targetIds: [target],
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `grant-${randomUUID()}`,
      reason: 'the outsider may number the document',
      payload: { principal_kind: 'person', principal_id: outsider, capability: 'act' },
    });
    const numbered = await asOutsider();
    expect(numbered.status).toBe('applied');
    expect((numbered.receipt as Record<string, unknown>)['enterprise_id']).toMatch(
      /^OH-DOC-[0-9]{6}-[0-9]$/,
    );
  });

  it('serves the explanation and hides objects the asker cannot see', async () => {
    const app = Fastify({ logger: false });
    registerAccessExplanationRoute(
      app,
      routeOptions(fixtures.performerId, fixtures.performerRoleId),
    );
    await app.ready();
    try {
      const own = await app.inject({ method: 'GET', url: `/objects/${probe}/access` });
      expect(own.statusCode, own.body).toBe(200);
      const explanation = own.json() as AccessExplanation;
      expect(explanation.format).toBe('kf-access-explanation-v1');
      expect(explanation.personId).toBe(fixtures.performerId);
      expect(explanation.decision).toBe('visible');
      expect(own.headers['x-kf-explanation-digest']).toBe(explanation.explanationDigest);

      const about = await app.inject({
        method: 'GET',
        url: `/objects/${probe}/access?person=${outsider}`,
      });
      expect(about.statusCode, about.body).toBe(200);
      expect((about.json() as AccessExplanation).deniedBy).toBe('grant_coverage');

      const missing = await app.inject({
        method: 'GET',
        url: `/objects/${randomUUID()}/access?person=${outsider}`,
      });
      expect(missing.statusCode).toBe(404);

      const malformed = await app.inject({
        method: 'GET',
        url: `/objects/${probe}/access?person=nobody`,
      });
      expect(malformed.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
