import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { InMemoryObjectStore } from '@kf/artifacts';
import { withTransaction } from '@kf/database';
import { createDocumentActionAtoms, enumeratePermittedSet } from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
import { loadProjectionDefinitions } from '@kf/projections';
import { registerExperienceRoutes } from '../../apps/api/src/routes/experience.js';
import { DASHBOARD_LAYOUT } from '../../apps/api/src/routes/experience/dashboard.js';
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
 * The experience, against a real database (ADR 0040; KF-SAS-RQ-262, RQ-267, RQ-268).
 *
 *   1. Scope, not copies: a person granted nothing gets a master record and no overview; granting
 *      them the overview record puts it in their master document with no other change; revoking
 *      the grant takes it away. The overview's existence is not disclosed to someone outside it.
 *   2. The overview cannot leak: every statement is a record the reader may read, nothing above
 *      the reader's ceiling is shown OR counted, and what is withheld is exactly the sources the
 *      reader can see and no grant reaches (ADR 0037) — computed here independently.
 *   3. One layout: the CEO and the engineer get the same panels in the same order, and different
 *      contents.
 *   4. The master document shows the compiled claim, the overview at its head when in scope, and
 *      re-reads every item live: an item whose grant was revoked after compilation disappears and
 *      is only counted.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const ARTIFACT = join(ROOT, 'generated', 'projections', 'knowledge-fabric.projections.json');

let h: Harness;
let f: Fixtures;
const projections = () => loadProjectionDefinitions(ARTIFACT);

interface Person {
  readonly id: string;
  readonly assignment: string;
  readonly ceiling: string;
}
let ceo: Person;
let engineer: Person;
let nobody: Person;
let overviewId: string;
let project: string;
let risk: string;
let secretDecision: string;
let restrictedNcr: string;
let internalDecision: string;
let narrowProject: string;
let artifact: string;

async function classify(id: string, classification: string): Promise<void> {
  await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f, f.reviewerId);
    await tx.query(
      'update core.object set classification = $2, row_version = row_version + 1 where id = $1',
      [id, classification],
    );
  });
}

async function record(type: string, domain: string, state: string, title: string, cls: string) {
  const id = await createObject(h.adminPool, f, {
    type,
    domain,
    state,
    title,
    createdBy: f.reviewerId,
  });
  if (cls !== 'internal') await classify(id, cls);
  return id;
}

async function person(
  name: string,
  clearance: string,
  role: string,
  scope: string | undefined,
  ceiling: string | null,
): Promise<Person> {
  const id = await createObject(h.adminPool, f, {
    type: 'person',
    domain: 'organization',
    state: 'active',
    title: name,
    createdBy: f.reviewerId,
  });
  await classify(id, 'public');
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
       values ($1, $2, $3, $4, $5, 'experience fixture')`,
      [id, f.organizationId, clearance, f.reviewerId, f.clearanceActionId],
    );
    await tx.query(
      `insert into org.role_assignment
         (id, subject_id, role_id, scope_id, valid_to, classification_ceiling)
       values ($1, $2, $3, $4, now() + interval '300 days', $5)`,
      [assignment, id, role, scope ?? f.organizationId, ceiling],
    );
  });
  return { id, assignment, ceiling: clearance };
}

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

async function act(
  actionType: string,
  targetIds: readonly string[],
  payload: Record<string, string> = {},
  as: Person | undefined = undefined,
) {
  return dispatcher()({
    actionType,
    actorId: as?.id ?? f.reviewerId,
    actingRoleId: as?.assignment ?? f.reviewerRoleId,
    targetIds,
    organizationId: f.organizationId,
    maxClassification: as?.ceiling ?? 'restricted',
    idempotencyKey: `${actionType}-${randomUUID()}`,
    reason: `experience suite: ${actionType}`,
    payload,
  });
}

async function app(as: Person): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  registerExperienceRoutes(server, {
    pool: h.pool,
    projections: projections(),
    identify: async () => ({
      actorId: as.id,
      actingRoleId: as.assignment,
      organizationId: f.organizationId,
      maxClassification: as.ceiling,
      authentication: { authenticatedAt: undefined, assuranceLevel: undefined, methods: [] },
    }),
  });
  await server.ready();
  return server;
}

async function get(as: Person, url: string) {
  const server = await app(as);
  try {
    const response = await server.inject({ method: 'GET', url });
    return { status: response.statusCode, body: response.json() as Record<string, unknown> };
  } finally {
    await server.close();
  }
}

async function permitted(as: Person): Promise<Set<string>> {
  return withTransaction(h.pool, async (tx) => {
    await bindReader(tx, f, f.reviewerId);
    return new Set(
      (await enumeratePermittedSet(tx, as.id, f.organizationId)).map((m) => m.objectId),
    );
  });
}

interface OverviewBody {
  status: string;
  overview: { id: string };
  sections: { id: string; statements: { objectId: string; text: string }[] }[];
  withheld: number;
}

const statementIds = (body: OverviewBody) =>
  body.sections.flatMap((section) => section.statements.map((s) => s.objectId));

beforeAll(async () => {
  h = await startHarness({ realisticOwner: true });
  f = await seedFixtures(h.adminPool);
  await withTransaction(h.adminPool, async (tx) => {
    for (const role of ['x_staff', 'x_engineer', 'x_ceo']) {
      await tx.query('insert into org.role (id, description) values ($1, $2)', [
        role,
        `fixture role ${role} for the experience suite`,
      ]);
    }
  });
  project = await record('initiative_project', 'project', 'captured', 'Servo valve', 'internal');
  risk = await record('risk', 'qms', 'identified', 'Seal wear', 'internal');
  internalDecision = await record(
    'decision_record',
    'engineering',
    'proposed',
    'Second source for forgings',
    'internal',
  );
  secretDecision = await record(
    'decision_record',
    'engineering',
    'proposed',
    'Acquire Precis-Tec',
    'confidential',
  );
  restrictedNcr = await record('nonconformity', 'qms', 'open', 'Export breach', 'restricted');
  narrowProject = await record('initiative_project', 'project', 'captured', 'Lone', 'internal');
  artifact = await record('artifact', 'artifact', 'draft', 'A drawing', 'internal');

  ceo = await person('CEO', 'restricted', 'x_ceo', undefined, null);
  engineer = await person('Engineer', 'internal', 'x_engineer', undefined, 'public');
  nobody = await person('Nobody', 'internal', 'x_staff', narrowProject, null);

  const declared = await act('declare_organization_overview', [f.organizationId], {
    title: 'What we are doing',
    classification: 'internal',
  });
  overviewId = declared.objectIds.find((id) => id !== f.organizationId)!;
  // The staff preset reads the overview; the engineer includes staff and reads the project and
  // the risk. The CEO's assignment is organization-wide with no ceiling: everything up to their
  // clearance, the overview included.
  await act('grant_role_scope', [f.organizationId, overviewId], {
    role_id: 'x_staff',
    capability: 'read',
  });
  await act('grant_role_scope', [f.organizationId, project], {
    role_id: 'x_engineer',
    capability: 'read',
  });
  await act('grant_role_scope', [f.organizationId, risk], {
    role_id: 'x_engineer',
    capability: 'read',
  });
  await act('include_role', [f.organizationId], {
    role_id: 'x_engineer',
    included_role_id: 'x_staff',
  });
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe('the living organization overview', () => {
  it('is not in scope for a person granted nothing, and says nothing about whether one exists', async () => {
    const overview = await get(nobody, '/overview');
    expect(overview.status).toBe(404);
    expect(overview.body).toEqual({ error: 'not_found' });
    const dashboard = await get(nobody, '/dashboard');
    const panel = (dashboard.body['panels'] as { id: string; empty?: boolean }[])[0]!;
    expect(panel).toEqual({ id: 'overview', empty: true });
    expect(JSON.stringify(dashboard.body)).not.toContain(overviewId);
  });

  it('enters a master document by a grant, with no other change, and leaves by revocation', async () => {
    const granted = await act('grant_access', [overviewId], {
      principal_kind: 'person',
      principal_id: nobody.id,
      capability: 'read',
    });
    expect(granted.status).toBe('applied');
    const overview = await get(nobody, '/overview');
    expect(overview.status).toBe(200);
    const body = overview.body as unknown as OverviewBody;
    expect(body.overview.id).toBe(overviewId);
    // Nobody reads the overview record and their one project: that is all it can say to them.
    expect(new Set(statementIds(body))).toEqual(new Set([overviewId, narrowProject]));

    const grantId = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ id: string }>(
        'select id from org.access_grant where principal_id = $1 and scope_object_id = $2 and revoked_at is null',
        [nobody.id, overviewId],
      ),
    );
    await act('revoke_access', [overviewId], { grant_id: grantId.id });
    expect((await get(nobody, '/overview')).status).toBe(404);
  });

  it('says to each reader only what that reader may read, every statement linked to its source', async () => {
    for (const reader of [ceo, engineer]) {
      const body = (await get(reader, '/overview')).body as unknown as OverviewBody;
      expect(body.status).toBe('ready');
      const corpus = await permitted(reader);
      for (const id of statementIds(body)) expect(corpus.has(id), id).toBe(true);
    }
    const asEngineer = (await get(engineer, '/overview')).body as unknown as OverviewBody;
    const ids = statementIds(asEngineer);
    expect(ids).toEqual(expect.arrayContaining([overviewId, project, risk]));
    for (const above of [secretDecision, restrictedNcr]) expect(ids).not.toContain(above);
    expect(JSON.stringify(asEngineer)).not.toContain('Acquire Precis-Tec');
    expect(JSON.stringify(asEngineer)).not.toContain('Export breach');
    const asCeo = (await get(ceo, '/overview')).body as unknown as OverviewBody;
    expect(statementIds(asCeo)).toEqual(
      expect.arrayContaining([overviewId, project, risk, secretDecision, restrictedNcr]),
    );
    // Artifacts are not statements about the organization: never placed, whoever reads.
    expect(statementIds(asCeo)).not.toContain(artifact);
  });

  it('withholds and counts only what the reader can see and is not granted, never above the ceiling', async () => {
    const types = projections().byId('organization_overview')!.filter!.objectTypes!;
    // Independently: overview-type records at or below the engineer's ceiling, less the permitted.
    const expected = async () => {
      const visible = await withTransaction(h.adminPool, (tx) =>
        tx.query<{ id: string }>(
          `select o.id from core.object o join registry.classification c on c.id = o.classification
            where o.organization_id = $1 and o.object_type = any($2::text[]) and c.rank <= 1`,
          [f.organizationId, [...types]],
        ),
      );
      const corpus = await permitted(engineer);
      return visible.filter((row) => !corpus.has(row.id)).length;
    };
    const before = (await get(engineer, '/overview')).body as unknown as OverviewBody;
    expect(before.withheld).toBe(await expected());
    expect(before.withheld).toBeGreaterThan(0); // the internal decision is in reach and ungranted
    // Lowering the confidential decision into the engineer's ceiling adds exactly one: it was
    // never counted while it sat above it.
    await classify(secretDecision, 'internal');
    const after = (await get(engineer, '/overview')).body as unknown as OverviewBody;
    expect(after.withheld).toBe(before.withheld + 1);
    expect(after.withheld).toBe(await expected());
    expect(statementIds(after)).not.toContain(secretDecision);
    await classify(secretDecision, 'confidential');
    void internalDecision;
  });
});

describe('the dashboard', () => {
  it('gives the CEO and the engineer one layout with different contents (KF-SAS-RQ-262)', async () => {
    const forCeo = (await get(ceo, '/dashboard')).body;
    const forEngineer = (await get(engineer, '/dashboard')).body;
    const ids = (body: Record<string, unknown>) =>
      (body['panels'] as { id: string }[]).map((panel) => panel.id);
    expect(forCeo['layout']).toEqual([...DASHBOARD_LAYOUT]);
    expect(forEngineer['layout']).toEqual([...DASHBOARD_LAYOUT]);
    expect(ids(forCeo)).toEqual([...DASHBOARD_LAYOUT]);
    expect(ids(forEngineer)).toEqual([...DASHBOARD_LAYOUT]);
    const work = (body: Record<string, unknown>) =>
      (body['panels'] as { id: string; records?: { id: string }[] }[])
        .find((panel) => panel.id === 'work_in_flight')!
        .records!.map((r) => r.id);
    expect(work(forCeo)).toEqual(expect.arrayContaining([secretDecision, restrictedNcr]));
    expect(work(forEngineer)).not.toContain(secretDecision);
    expect(work(forEngineer)).not.toContain(restrictedNcr);
    expect(work(forEngineer)).toContain(project);
    // A risk has states and no declared lifecycle, so it is never "in flight"; it is recent.
    const recent = (body: Record<string, unknown>) =>
      (body['panels'] as { id: string; records?: { id: string }[] }[])
        .find((panel) => panel.id === 'recent_record')!
        .records!.map((r) => r.id);
    expect(recent(forEngineer)).toContain(risk);
    expect(recent(forEngineer)).not.toContain(secretDecision);
    expect(JSON.stringify(forEngineer)).not.toContain('Acquire Precis-Tec');
    // Every listed record is one the reader may read.
    const corpus = await permitted(engineer);
    for (const id of work(forEngineer)) expect(corpus.has(id), id).toBe(true);
  });

  it('collapses what is empty and names the Needs-you slot without filling it', async () => {
    const body = (await get(nobody, '/dashboard')).body;
    const panels = body['panels'] as { id: string; empty?: boolean; slot?: string }[];
    expect(panels.map((p) => p.id)).toEqual([...DASHBOARD_LAYOUT]);
    expect(panels.find((p) => p.id === 'needs_you')).toEqual({
      id: 'needs_you',
      slot: 'needs-you',
    });
    expect(panels.find((p) => p.id === 'overview')?.empty).toBe(true);
  });
});

describe('the master document', () => {
  it('is the compiled claim, overview first when in scope, every item re-read live', async () => {
    const missing = (await get(engineer, '/master-document')).body;
    expect(missing['claim']).toEqual({ status: 'missing' });
    expect((missing['overview'] as { overview: { id: string } }).overview.id).toBe(overviewId);

    const compiled = await act('compile_master_record', [engineer.id], {}, engineer);
    expect(compiled.status).toBe('applied');
    const body = (await get(engineer, '/master-document')).body as {
      claim: { status: string; memberCount: number; currency: string };
      sections: { objectType: string; items: { objectId: string }[]; noLongerInScope: number }[];
    };
    expect(body.claim.status).toBe('compiled');
    expect(body.claim.currency).toBe('current');
    const items = body.sections.flatMap((s) => s.items.map((i) => i.objectId));
    expect(items).toEqual(expect.arrayContaining([project, risk, overviewId]));

    // Revoke the engineer's reach to the risk after compiling: the page stops showing it at once,
    // counts it, and never names it.
    const { templates } = await withTransaction(h.adminPool, async (tx) => ({
      templates: await tx.query<{ id: string }>(
        `select id from org.role_preset_grant where scope_object_id = $1 and retired_at is null`,
        [risk],
      ),
    }));
    await act('revoke_role_scope', [f.organizationId], { preset_grant_id: templates[0]!.id });
    const after = (await get(engineer, '/master-document?type=risk')).body as typeof body;
    expect(after.claim.currency).toBe('unknown');
    const riskSection = after.sections.find((s) => s.objectType === 'risk')!;
    expect(riskSection.items).toEqual([]);
    expect(riskSection.noLongerInScope).toBe(1);
    expect(JSON.stringify(after)).not.toContain('Seal wear');
  });
});
