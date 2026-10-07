/**
 * Joining, end to end over the API (ADR 0040 decision 12; ADR 0038; KF-SAS-RQ-236, RQ-257,
 * RQ-275; KF-WAR-0007 OBL-005).
 *
 * The owner invites a person with `kf invite`'s own code (`runInvite`): the person, the identity
 * link, a role assignment ending within 366 days, a qualification record for the Véracier aero
 * pack and an invitation whose token the database never sees. Then, through the real routes and
 * the real dispatcher: the invited person follows the link, lands on Start Here, is given the
 * guide's context, acknowledges, submits their first Warrant; their reviewers find it in Needs
 * you, credit it, and the contact's one gesture closes the record. The dashboard shows Start Here
 * first while it is open and drops it once they are qualified.
 *
 * The in-app agent (`@kf/agent`) is driven over the same routes: while the record is open its turn
 * carries the guide, labelled confidential although the record's envelope is `internal`, so a
 * provider under an `internal` ceiling is sent nothing; it drafts and submits evidence through
 * M2's closed list, which credits nothing; it cannot credit or accept. Once the record is closed,
 * and for anyone without one, the turn carries no guide.
 */

import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JsonValue } from '@kf/canonicalization';
import { withTransaction } from '@kf/database';
import { invitationTokenDigest } from '@kf/qualification';
import {
  ProviderBackend,
  answerTurn,
  draftFromRequest,
  readGuide,
  submitDraft,
  type FabricClient,
  type ModelBackend,
  type ModelRequest,
  type ProviderTransport,
} from '@kf/agent';
import { createFabricDispatcher } from '@kf/orchestrator';
import type { Caller } from '../../apps/api/src/routes/actions/contracts.js';
import { planInvite, runInvite, type InviteResult } from '../../apps/api/src/admin/invite.js';
import { registerExperienceRoutes } from '../../apps/api/src/routes/experience.js';
import { registerNeedsYouRoutes } from '../../apps/api/src/routes/needs-you.js';
import { registerQualificationRoutes } from '../../apps/api/src/routes/qualification.js';
import { registerActionPostRoute } from '../../apps/api/src/routes/actions/write-route.js';
import { DEFAULT_EFFECTIVE_AT_BOUNDS } from '../../apps/api/src/routes/actions/effective-at.js';
import { AERO, KEYS, veracierPacks } from '../../fixtures/veracier/qualification.mjs';
import {
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';
import { enrolPerson, fixtureProject } from './people.js';

let h: Harness;
let f: Fixtures;
let execute: ReturnType<typeof createFabricDispatcher>;

interface Who {
  readonly id: string;
  readonly role: string;
  readonly ceiling: string;
  readonly agent?: string;
}
let reviewer: Who;
let quality: Who;
let outsider: Who;
let joiner: Who;
let invited: InviteResult;
let token: string;
let overview: string;
let av3000: string;
let aeroPack: string;

const caller = (who: Who): Caller => ({
  actorId: who.id,
  actingRoleId: who.role,
  organizationId: f.organizationId,
  maxClassification: who.ceiling,
  authentication: { authenticatedAt: undefined, assuranceLevel: undefined, methods: [] },
  ...(who.agent === undefined ? {} : { agent: who.agent }),
});

async function api(
  who: Who,
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = Fastify({ logger: false });
  const identify = async () => caller(who);
  registerQualificationRoutes(server, { pool: h.pool, execute, identify });
  registerNeedsYouRoutes(server, { pool: h.pool, execute, identify, bearer: false });
  registerExperienceRoutes(server, { pool: h.pool, identify });
  registerActionPostRoute(server, {
    execute,
    identify,
    stepUp: {},
    verifier: undefined,
    effectiveAtBounds: DEFAULT_EFFECTIVE_AT_BOUNDS,
  });
  await server.ready();
  try {
    const response = await server.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
    });
    return { status: response.statusCode, body: response.json() as Record<string, unknown> };
  } finally {
    await server.close();
  }
}

const act = (
  who: Who,
  actionType: string,
  targetIds: string[],
  payload: Record<string, JsonValue>,
) =>
  execute({
    actionType,
    actorId: who.id,
    actingRoleId: who.role,
    organizationId: f.organizationId,
    maxClassification: who.ceiling,
    targetIds,
    payload,
    idempotencyKey: `joining-${randomUUID()}`,
  });

const pastThePace = () => new Promise((resolve) => setTimeout(resolve, 1_100));

/**
 * The Fabric as the in-app agent reaches it, for `who`, over these routes. The organization's
 * ceiling is `internal`, ADR 0040's default; search and the context source are not mounted here,
 * so a turn's only record content is what the guide carries.
 */
const fabricFor = (who: Who): FabricClient => ({
  organizationId: f.organizationId,
  async call(method, path, options) {
    if (path === '/model-routing') return { status: 200, body: { providerCeiling: 'internal' } };
    const query = options?.query === undefined ? '' : `?${new URLSearchParams(options.query)}`;
    return api(who, method, `${path}${query}`, options?.body as Record<string, unknown>);
  },
});

/** A provider that records what it is handed; the host's model, recording too. */
class Recorder implements ProviderTransport {
  readonly name = 'recording provider';
  readonly sent: ModelRequest[] = [];
  async send(request: ModelRequest) {
    this.sent.push(request);
    return { text: 'From the record.' };
  }
}
class Host implements ModelBackend {
  readonly kind = 'on_host' as const;
  readonly name = 'LAMU on this host (test)';
  readonly sent: ModelRequest[] = [];
  reply = 'Start with your read-in.';
  async complete(request: ModelRequest) {
    this.sent.push(request);
    return { text: this.reply };
  }
}

/** One turn as `who`, both models offered; what each was sent. */
async function turnAs(who: Who) {
  const recorder = new Recorder();
  const host = new Host();
  const answer = await answerTurn(
    {
      fabric: fabricFor(who),
      backends: {
        onHost: host,
        provider: new ProviderBackend(recorder, { ceiling: () => 'internal' }),
      },
      sealKey: new Uint8Array(32).fill(5),
    },
    { question: 'what do I do first?' },
  );
  return { answer, host, recorder };
}

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  execute = createFabricDispatcher(h.pool);
  reviewer = { id: f.reviewerId, role: f.reviewerRoleId, ceiling: 'restricted' };
  outsider = { id: f.performerId, role: f.performerRoleId, ceiling: 'restricted' };
  const enrolled = await enrolPerson(h.adminPool, f, {
    name: 'Karim Quality',
    assignments: [{ role: 'quality_authority' }],
  });
  quality = { id: enrolled.personId, role: enrolled.assignmentIds[0]!, ceiling: 'restricted' };

  const make = (type: string, domain: string, state: string, title: string) =>
    createObject(h.adminPool, f, { type, domain, state, title, createdBy: f.reviewerId });
  overview = await make('initiative_project', 'project', 'captured', 'Véracier at a glance');
  const procedures = await make('controlled_document', 'qms', 'draft', 'Group procedures');
  const ncr = await make('initiative_project', 'project', 'captured', 'A raised NCR');
  const matrix = await make('controlled_document', 'qms', 'draft', 'Authority matrix');
  av3000 = await fixtureProject(h.adminPool, f, 'AV-3000 programme');
  const ref = (id: string) => ({ id, revision: '1' });
  const packs = veracierPacks({
    resources: {
      overview: ref(overview),
      procedures: ref(procedures),
      ncrExample: ref(ncr),
      authorityMatrix: ref(matrix),
      programme: ref(av3000),
    },
    scope: { av3000 },
    roles: {
      owner: 'technical_authority',
      quality: 'quality_authority',
      executive: 'project_owner',
    },
  });
  for (const document of [packs.common, packs.aero]) {
    const drafted = await act(reviewer, 'draft_qualification_pack', [], {
      document: document as unknown as JsonValue,
    });
    const packId = String(drafted.receipt?.['packId']);
    await act(reviewer, 'approve_qualification_pack', [packId], {});
    if (document.key === AERO) aeroPack = packId;
  }

  // The owner invites Lucie Garnier, through `kf invite`'s own code.
  const planned = planInvite({
    organizationId: f.organizationId,
    name: 'Lucie Garnier',
    email: 'lucie.garnier@veracier.example',
    roleId: 'performer',
    classification: 'internal',
    invitedBy: f.reviewerId,
    contactId: f.reviewerId,
    packId: aeroPack,
    scopeObjectId: av3000,
    reason: 'Joins the AV-3000 methods team on 2026-10-12',
    issuer: 'https://identity.kf.example/realms/knowledge-fabric',
    subject: 'lucie-garnier-subject',
    webOrigin: 'https://kf.example',
  });
  if (!planned.ok) throw new Error(planned.refusals.join('; '));
  invited = await runInvite(h.adminPool, planned.plan);
  token = invited.link.slice('https://kf.example/join/'.length);
  joiner = { id: invited.personId, role: invited.roleAssignmentId, ceiling: 'internal' };
}, 900_000);

afterAll(async () => {
  await h?.stop();
});

describe('the owner invites', () => {
  it('creates the person, the link to their account, a role assignment within 366 days and their record', async () => {
    const rows = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ subject: string; days: number; pack_id: string; contact: string; state: string }>(
        `select ei.subject, extract(day from ra.valid_to - ra.valid_from)::int as days,
                r.pack_id, r.contact_person_id as contact, o.lifecycle_state as state
           from org.external_identity ei
           join org.role_assignment ra on ra.subject_id = ei.person_id
           join org.qualification_record r on r.person_id = ei.person_id
           join core.object o on o.id = r.id
          where ei.person_id = $1`,
        [invited.personId],
      ),
    );
    expect(rows).toMatchObject({
      subject: 'lucie-garnier-subject',
      pack_id: aeroPack,
      contact: f.reviewerId,
      state: 'assigned',
    });
    expect(rows.days).toBeLessThanOrEqual(366);
    // Each owner act is recorded, attributed to the inviter, and on the audit chain.
    const acts = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ action_type: string; actor_id: string; audited: boolean }>(
        `select a.action_type, a.actor_id,
                exists (select 1 from core.audit_event e where e.action_id = a.id) as audited
           from core.action a
          where a.request_id = 'kf-invite' order by a.recorded_at, a.id`,
      ),
    );
    expect(acts).toEqual([
      { action_type: 'assign_qualification', actor_id: f.reviewerId, audited: true },
      { action_type: 'invite_person', actor_id: f.reviewerId, audited: true },
    ]);
  });

  it('stores the token’s digest and never the token', async () => {
    const stored = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ token_digest: string; as_text: string }>(
        `select token_digest, row_to_json(i)::text as as_text from org.invitation i where id = $1`,
        [invited.invitationId],
      ),
    );
    expect(stored.token_digest).toBe(invitationTokenDigest(token));
    expect(stored.as_text).not.toContain(token);
  });

  it('refuses an invitation that would last longer than an assignment review allows', () => {
    const planned = planInvite({
      organizationId: f.organizationId,
      name: 'Someone',
      email: 'someone@veracier.example',
      roleId: 'performer',
      classification: 'internal',
      invitedBy: f.reviewerId,
      contactId: f.reviewerId,
      reason: 'testing the bounds',
      issuer: 'https://identity.kf.example',
      subject: 's',
      webOrigin: 'https://kf.example',
      validTo: '2030-01-01',
      expiresInDays: '45',
    });
    expect(planned.ok).toBe(false);
    if (!planned.ok) {
      expect(planned.refusals.join(' ')).toMatch(/366 days/);
      expect(planned.refusals.join(' ')).toMatch(/expires-in-days is 1 to 30/);
    }
  });
});

describe('the invited person joins', () => {
  it('follows the link: it answers only for them', async () => {
    const mine = await api(joiner, 'GET', `/invitations/${token}`);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ recordId: invited.recordId, next: '/start-here' });
    expect((await api(reviewer, 'GET', `/invitations/${token}`)).status).toBe(404);
    expect((await api(joiner, 'GET', `/invitations/${'x'.repeat(43)}`)).status).toBe(404);
  });

  it('lands on Start Here, first on their dashboard, with the guide given its context', async () => {
    const start = await api(joiner, 'GET', '/start-here');
    const pages = start.body['pages'] as { recordId: string; stages: unknown[]; digest: string }[];
    expect(pages).toHaveLength(1);
    expect(pages[0]?.recordId).toBe(invited.recordId);
    expect(pages[0]?.stages).toHaveLength(5);
    const dashboard = await api(joiner, 'GET', '/dashboard');
    const panels = dashboard.body['panels'] as { id: string; empty: boolean }[];
    expect(panels[0]).toMatchObject({ id: 'start_here', empty: false });
    const guide = await api(joiner, 'GET', '/start-here/guide');
    expect(guide.body).toMatchObject({
      format: 'kf-agent-guide-context-v1',
      recordId: invited.recordId,
      acts: ['submit_qualification_evidence'],
    });
    expect((guide.body['next'] as { key: string }[])[0]?.key).toBe(KEYS.readIn);
    expect(String(guide.body['instructions'])).toMatch(/never credit evidence/);
    // Labelled at the record's level: the envelope is internal, the guide is not.
    expect(guide.body['classification']).toBe('confidential');
    const envelope = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ classification: string }>('select classification from core.object where id = $1', [
        invited.recordId,
      ]),
    );
    expect(envelope.classification).toBe('internal');
  });

  it('gives the in-app agent the guide, on the host only; an outsider’s turn carries none', async () => {
    const asAgent = { ...joiner, agent: 'knowledge-fabric-web-agent' };
    const { answer, host, recorder } = await turnAs(asAgent);
    expect(answer.guide?.recordId).toBe(invited.recordId);
    expect(answer.backend?.kind).toBe('on_host');
    expect(recorder.sent).toHaveLength(0);
    const item = host.sent[0]!.context.find((c) => c.recordId === invited.recordId)!;
    expect(item.classification).toBe('confidential');
    expect(item.text).toContain(KEYS.readIn);
    expect(item.text).toMatch(/may not: .*credit_evidence/);

    const other = await turnAs(outsider);
    expect(other.answer.guide).toBeNull();
    expect(other.answer.status).toBe('nothing_found');
    expect(other.recorder.sent).toHaveLength(0);
    expect(other.host.sent).toHaveLength(0);
  });

  it('acknowledges, submits a first Warrant, and is qualified by the reviewers’ gestures alone', async () => {
    const record = invited.recordId!;
    const acknowledged = await api(joiner, 'POST', `/qualification/records/${record}/credit`, {
      idempotencyKey: `ack-${randomUUID()}`,
      credits: [
        { requirementKey: KEYS.readIn, evidenceObjectId: overview },
        { requirementKey: KEYS.programme, evidenceObjectId: av3000 },
      ],
    });
    expect(acknowledged.status).toBe(201);
    expect(acknowledged.body['actionType']).toBe('credit_qualification_evidence');

    const { id: work } = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ id: string }>('select uuidv7()::text as id'),
    );
    await act(joiner, 'create_warrant_draft', [], {
      warrant_uuid: work,
      repository: 'veracier',
      title: 'Bench 2 fixture rework, citing VER procedures',
      profile: 'delivery',
      assurance_level: 'controlled',
    });
    // The in-app agent, as the guide, drafts and commits the First Contribution's evidence through
    // M2's closed list: one submission on her own record, crediting nothing.
    const asAgent = { ...joiner, agent: 'knowledge-fabric-web-agent' };
    const guideRead = await readGuide(fabricFor(asAgent));
    if (guideRead.kind !== 'guide') throw new Error(`no guide: ${guideRead.kind}`);
    const host = new Host();
    host.reply = JSON.stringify({
      act: 'submit_qualification_evidence',
      targetIds: [],
      fields: { requirement_key: KEYS.firstContribution, evidence_object_id: work },
    });
    const drafted = await draftFromRequest(
      { onHost: host },
      'internal',
      'record that my Warrant is the evidence for my first contribution',
      guideRead.guide,
    );
    expect(drafted.act.act).toBe('submit_qualification_evidence');
    expect(drafted.draft.targetIds).toEqual([record]);
    const byGuide = await submitDraft(fabricFor(asAgent), {
      act: drafted.act.act,
      targetIds: drafted.draft.targetIds,
      fields: drafted.draft.payload,
      idempotencyKey: `guide-${randomUUID()}`,
    });
    expect(byGuide.disposition).toBe('submitted');
    const firstContribution = (
      (await api(joiner, 'GET', '/start-here')).body['pages'] as {
        stages: { items: { key: string; status: string }[] }[];
      }[]
    )[0]!.stages
      .flatMap((s) => s.items)
      .find((i) => i.key === KEYS.firstContribution);
    expect(firstContribution?.status).toBe('submitted');
    // Crediting or accepting through the same path is refused before anything is sent.
    for (const act of ['credit_qualification_evidence', 'accept_qualification']) {
      const refused = await submitDraft(fabricFor(asAgent), {
        act,
        targetIds: [record],
        idempotencyKey: `guide-${randomUUID()}`,
      });
      expect(refused).toMatchObject({ disposition: 'refused', code: 'not_an_agent_act' });
    }

    for (const key of [KEYS.references, KEYS.ncr, KEYS.containment]) {
      const submitted = await api(joiner, 'POST', `/qualification/records/${record}/submit`, {
        idempotencyKey: `submit-${randomUUID()}`,
        requirementKey: key,
        evidenceObjectId: work,
      });
      expect(submitted.status).toBe(201);
    }

    // Each reviewer finds only what they may credit.
    const toCredit = async (who: Who) =>
      (
        (await api(who, 'GET', '/needs-you')).body['toCredit'] as {
          items: { requirementKey: string; submissionId: string }[];
        }
      ).items;
    const forQuality = await toCredit(quality);
    expect(forQuality.map((i) => i.requirementKey)).toEqual([KEYS.containment]);
    const forContact = await toCredit(reviewer);
    expect(forContact.map((i) => i.requirementKey).sort()).toEqual(
      [KEYS.references, KEYS.ncr, KEYS.firstContribution].sort(),
    );
    expect(await toCredit(outsider)).toEqual([]);

    // An agent acting for the contact is refused at the route (and by the database).
    const byAgent = await api(
      { ...reviewer, agent: 'joining-guide' },
      'POST',
      `/qualification/records/${record}/credit`,
      {
        idempotencyKey: `agent-${randomUUID()}`,
        credits: [{ submissionId: forContact[0]!.submissionId }],
      },
    );
    expect(byAgent.status).toBe(403);

    // The quality authority credits containment, accepting the Warrant in the same act.
    const containment = await api(quality, 'POST', `/qualification/records/${record}/credit`, {
      idempotencyKey: `credit-${randomUUID()}`,
      credits: [{ submissionId: forQuality[0]!.submissionId }],
    });
    expect(containment.body['actionType']).toBe('credit_qualification_evidence');

    // The contact's one gesture credits the rest and, being the last, closes the record.
    await pastThePace();
    const closing = await api(reviewer, 'POST', `/qualification/records/${record}/credit`, {
      idempotencyKey: `credit-${randomUUID()}`,
      credits: forContact.map((i) => ({ submissionId: i.submissionId })),
    });
    expect(closing.status).toBe(201);
    expect(closing.body['actionType']).toBe('accept_qualification');

    const after = await api(joiner, 'GET', '/start-here');
    const [page] = after.body['pages'] as { state: string; currency: string; missing: string[] }[];
    expect(page).toMatchObject({ state: 'qualified', currency: 'qualified', missing: [] });
    const dashboard = await api(joiner, 'GET', '/dashboard');
    const panels = dashboard.body['panels'] as {
      id: string;
      empty: boolean;
      qualification?: { own: { currency: string }[] };
    }[];
    expect(panels[0]).toMatchObject({ id: 'start_here', empty: true });
    expect(panels.find((p) => p.id === 'people')?.qualification?.own).toEqual([
      expect.objectContaining({ currency: 'qualified' }),
    ]);
    expect((await api(joiner, 'GET', '/start-here/guide')).status).toBe(404);
    // Qualified: the agent's turn carries no guide any more.
    const after_ = await turnAs({ ...joiner, agent: 'knowledge-fabric-web-agent' });
    expect(after_.answer.guide).toBeNull();
    expect(after_.host.sent).toHaveLength(0);
  });

  it('keeps the record from anyone but the person, the contact and the reviewers', async () => {
    const url = `/qualification/records/${invited.recordId!}`;
    expect((await api(outsider, 'GET', url)).status).toBe(404);
    expect((await api(reviewer, 'GET', url)).status).toBe(200);
    expect((await api(quality, 'GET', url)).status).toBe(200);
    expect((await api(joiner, 'GET', url)).status).toBe(200);
  });
});
