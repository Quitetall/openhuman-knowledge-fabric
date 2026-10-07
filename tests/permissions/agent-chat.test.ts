/**
 * The in-app agent, end to end through every real seam (ADR 0035, ADR 0040 decisions 7 and 8;
 * KF-SAS-RQ-250, RQ-263, RQ-265, RQ-266, RQ-271, RQ-272; KF-WAR-0006 OBL-001 to OBL-003).
 *
 * `answerTurn`, `draftFromRequest` and `submitDraft` from @kf/agent call the real API (`buildApp`,
 * dogfood profile) over loopback HTTP with the person's token exchanged for the in-app agent's;
 * the API identifies every caller through the real kf-attestor over its Unix socket; the context
 * source reads under row security and grants and records each disclosure. Only two things are
 * stand-ins: the retrieval engine's ranking (as tests/database/context-source.test.ts stands it in,
 * masking by the caller's grants as the real one does) and the models. The provider is a RECORDER
 * that keeps every request it is handed, so "nothing reached it" is observed, not claimed.
 *
 * Covered, each with the probe that shows it can fail:
 *   - a turn whose context holds a confidential or restricted record is answered on the host and
 *     sends the provider nothing; one holding only public and internal records may reach it;
 *   - with no on-host model, such a turn is refused and nothing is sent;
 *   - every answer names its backend, cites records the reader read, and carries the withheld count
 *     GET /search reports for the same query and reader; each read is a recorded disclosure with the
 *     agent's participation;
 *   - a draft is the act's real form; committing it is ONE act, the person's with the agent's
 *     participation, unverified; an institutional act becomes a proposal in Needs you only;
 *   - a turn keeps nothing: no table but the transient disclosure records changes.
 */

import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SignJWT, createLocalJWKSet, exportJWK, type JWK } from 'jose';
import {
  ProviderBackend,
  answerTurn,
  draftFromRequest,
  submitDraft,
  type ModelBackend,
  type ModelRequest,
  type ProviderTransport,
} from '@kf/agent';
import { InMemoryObjectStore } from '@kf/artifacts';
import { LocalAttestor, TokenVerifier, linkIdentity, reaches } from '@kf/authorization';
import { createPool, withTransaction, type Pool } from '@kf/database';
import type { SemanticRetrieval } from '@kf/retrieval';
import { createAttestorServer } from '../../apps/attestor/src/server.js';
import { buildApp } from '../../apps/api/src/app.js';
import { runDeclareAgent } from '../../apps/api/src/admin/declare-agent.js';
import { FabricApi } from '../../apps/mcp/src/api.js';
import {
  bindContext,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from '../database/harness.js';

const ROOT = join(import.meta.dirname, '..', '..');
const ISSUER = 'https://id.openhuman.invalid/realms/openhuman';
const AUDIENCE = 'knowledge-fabric-api';
const WEB = 'knowledge-fabric-web';
const AGENT = 'knowledge-fabric-web-agent';
const PERFORMER = 'auth0|performer';
const REVIEWER = 'auth0|reviewer';
const OUTSIDER = 'auth0|outsider';
const SEAL_KEY = new Uint8Array(32).fill(3);

let h: Harness;
let f: Fixtures;
let g: Fixtures;
let privateKey: KeyObject;
let bareApp: Pool;
let attestorServer: Server;
let socketDir: string;
let api: FastifyInstance;
let apiUrl: URL;

/** What the stand-in engine ranks, before it masks by the caller's grants. */
let engineIds: string[] = [];

const ids: Record<'public' | 'internal' | 'confidential' | 'restricted', string> = {
  public: '',
  internal: '',
  confidential: '',
  restricted: '',
};
let foreignId: string;

async function token(claims: Record<string, unknown>, subject: string) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .setSubject(subject)
    .sign(privateKey);
}

/** The person's token exchanged for the in-app agent: what the web application holds for a turn. */
const delegated = (subject = PERFORMER) =>
  token({ azp: AGENT, act: { client_id: AGENT } }, subject);
const own = (subject = PERFORMER) => token({ azp: WEB }, subject);

function fabricFor(
  bearer: () => Promise<string>,
  who: { organizationId?: string; roleId?: string } = {},
): FabricApi {
  return new FabricApi({
    apiUrl,
    tokens: { describe: 'test', token: bearer },
    organizationId: who.organizationId ?? f.organizationId,
    actingRoleId: who.roleId ?? f.performerRoleId,
    classification: 'restricted',
  });
}

class Recorder implements ProviderTransport {
  readonly name = 'recording provider';
  readonly sent: ModelRequest[] = [];
  async send(request: ModelRequest) {
    this.sent.push(request);
    return { text: 'From the record [1].' };
  }
  bytes(): string {
    return JSON.stringify(this.sent);
  }
}

class Host implements ModelBackend {
  readonly kind = 'on_host' as const;
  readonly name = 'LAMU on this host (test)';
  readonly sent: ModelRequest[] = [];
  reply = 'On the host [1].';
  async complete(request: ModelRequest) {
    this.sent.push(request);
    return { text: this.reply };
  }
}

/** The provider's ceiling, as the web asks the API for it on every call. */
const ceilingOf = (fabric: FabricApi) => async () => {
  const answer = await fabric.call('GET', '/model-routing');
  return (answer.body as { providerCeiling: 'none' | 'public' | 'internal' }).providerCeiling;
};

async function person(method: 'GET' | 'POST', path: string, body?: unknown, subject = PERFORMER) {
  const res = await api.inject({
    method,
    url: path,
    headers: {
      authorization: `Bearer ${await own(subject)}`,
      'x-kf-acting-role': subject === REVIEWER ? f.reviewerRoleId : f.performerRoleId,
      'x-kf-organization': f.organizationId,
      'x-kf-classification': 'restricted',
    },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

async function decision(title: string, classification: string, fixtures: Fixtures = f) {
  const id = await createObject(h.adminPool, fixtures, {
    type: 'decision_record',
    domain: 'engineering',
    state: 'draft',
    title,
    createdBy: fixtures.performerId,
  });
  await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, fixtures);
    await tx.query(
      'update core.object set classification = $2, row_version = row_version + 1 where id = $1',
      [id, classification],
    );
    await tx.query('select search.index_object($1)', [id]);
  });
  return id;
}

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  g = await seedFixtures(h.adminPool);

  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'test-key' };
  const verifier = new TokenVerifier(
    { issuer: ISSUER, audience: AUDIENCE, jwksUri: 'https://unused.invalid/jwks' },
    createLocalJWKSet({ keys: [publicJwk] }),
  );
  for (const [fixtures, subject, personId] of [
    [f, PERFORMER, f.performerId],
    [f, REVIEWER, f.reviewerId],
    [g, OUTSIDER, g.performerId],
  ] as const) {
    await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, fixtures);
      await linkIdentity(tx, {
        issuer: ISSUER,
        subject,
        personId,
        providerLabel: subject,
        linkedBy: fixtures.reviewerId,
      });
    });
  }
  await runDeclareAgent(h.adminPool, {
    clientId: AGENT,
    declaredBy: f.reviewerId,
    reason: 'the in-app agent acts for the signed-in person',
    withdraw: false,
  });

  ids.public = await decision('Canteen opening hours move to 07:30', 'public');
  ids.internal = await decision('Bench rail measured at 3.31 V under load', 'internal');
  ids.confidential = await decision('Supplier price list for tantalum capacitors', 'confidential');
  ids.restricted = await decision('Acquisition target is Halberd Aero', 'restricted');
  foreignId = await decision('Another organization’s Halberd plan', 'internal', g);

  await withTransaction(h.adminPool, async (tx) => {
    await tx.query(`create role kf_agent_test_api login password 'test-only-not-a-secret'`);
    await tx.query('grant kf_app to kf_agent_test_api');
    await tx.query('grant connect on database kf_test to kf_agent_test_api');
  });
  const uri = new URL(h.connectionString);
  uri.username = 'kf_agent_test_api';
  uri.password = 'test-only-not-a-secret';
  bareApp = createPool({ connectionString: uri.toString(), maxConnections: 2 });

  socketDir = mkdtempSync(join(tmpdir(), 'kf-agent-'));
  const socketPath = join(socketDir, 'attestor.sock');
  attestorServer = createAttestorServer(new LocalAttestor(h.attestorPool, verifier));
  await new Promise<void>((resolve) => attestorServer.listen(socketPath, resolve));

  // The engine's mask, as the real one applies it: within the caller's clearance (row security)
  // and reached by a grant.
  const semantic: Pick<SemanticRetrieval, 'rank'> = {
    async rank(run, query) {
      const rows = await run((tx) =>
        tx.query<{ id: string; classification: string }>(
          'select id, classification from core.object where id = any($1::uuid[])',
          [engineIds],
        ),
      );
      const visible = new Map(rows.map((row) => [row.id, row.classification]));
      const masked = engineIds.filter((id) => {
        const classification = visible.get(id);
        return classification !== undefined && reaches(query.coverage, { id, classification });
      });
      return {
        status: 'ranked',
        hits: masked.slice(0, query.k).map((objectId, index) => ({
          objectId,
          score: 1 - index / 100,
          rank: index + 1,
        })),
        traceDigest: 'sha256:agent-chat-test-trace',
        ranking: 'test.semantic.v1',
      };
    },
  };

  api = await buildApp(
    {
      host: '127.0.0.1',
      port: 0,
      logLevel: 'silent',
      databaseUrl: uri.toString(),
      environment: 'test',
      deploymentProfile: 'dogfood',
      tlsTerminatedUpstream: false,
      identity: { issuer: ISSUER, audience: AUDIENCE, jwksUri: 'https://unused.invalid/jwks' },
      attestorSocket: socketPath,
      projectionsArtifact: join(
        ROOT,
        'generated',
        'projections',
        'knowledge-fabric.projections.json',
      ),
    },
    { objectStore: new InMemoryObjectStore(), semantic },
  );
  const address = await api.listen({ host: '127.0.0.1', port: 0 });
  apiUrl = new URL(address);
}, 240_000);

afterAll(async () => {
  await api?.close();
  await new Promise<void>((resolve) =>
    attestorServer ? attestorServer.close(() => resolve()) : resolve(),
  );
  if (socketDir !== undefined) rmSync(socketDir, { recursive: true, force: true });
  await bareApp?.end();
  await h?.stop();
});

/** One turn for `subject`, with a recording provider and, unless `hostless`, a host model. */
async function turn(
  question: string,
  options: { subject?: string; hostless?: boolean; roleId?: string } = {},
) {
  const fabric = fabricFor(() => delegated(options.subject ?? PERFORMER), {
    ...(options.roleId === undefined ? {} : { roleId: options.roleId }),
  });
  const recorder = new Recorder();
  const host = new Host();
  const answer = await answerTurn(
    {
      fabric,
      backends: {
        ...(options.hostless === true ? {} : { onHost: host }),
        provider: new ProviderBackend(recorder, { ceiling: ceilingOf(fabric) }),
      },
      sealKey: SEAL_KEY,
    },
    { question },
  );
  return { answer, recorder, host };
}

describe('restricted content never reaches a provider (OBL-001, KF-SAS-RQ-271)', () => {
  for (const classification of ['public', 'internal', 'confidential', 'restricted'] as const) {
    for (const who of [
      { subject: PERFORMER, roleId: () => f.performerRoleId },
      { subject: REVIEWER, roleId: () => f.reviewerRoleId },
    ]) {
      it(`${who.subject}: a turn holding a ${classification} record`, async () => {
        engineIds = [ids[classification]];
        const { answer, recorder } = await turn('halberd tantalum canteen bench', {
          subject: who.subject,
          roleId: who.roleId(),
        });
        expect(answer.consulted.map((c) => c.recordId)).toEqual([ids[classification]]);
        const leaves = classification === 'public' || classification === 'internal';
        expect(answer.backend?.kind).toBe(leaves ? 'provider' : 'on_host');
        if (!leaves) {
          expect(recorder.sent, `${ids[classification]} reached the provider`).toHaveLength(0);
          expect(answer.backend?.name).toMatch(/LAMU/);
        } else {
          expect(recorder.bytes()).toContain(ids[classification]);
        }
      });
    }
  }

  it('a turn mixing one restricted record into public ones is answered on the host', async () => {
    engineIds = [ids.public, ids.internal, ids.restricted];
    const { answer, recorder } = await turn('halberd canteen bench');
    expect(answer.backend?.kind).toBe('on_host');
    expect(recorder.sent).toHaveLength(0);
    expect(recorder.bytes()).not.toContain('Halberd');
  });

  it('with no on-host model it is refused, and nothing is sent anywhere', async () => {
    engineIds = [ids.public, ids.confidential];
    const { answer, recorder } = await turn('tantalum canteen', { hostless: true });
    expect(answer.status).toBe('refused');
    expect(answer.refusal?.rule).toBe('KF-ROUTE-004');
    expect(recorder.sent).toHaveLength(0);
    expect(answer.consulted).toHaveLength(2);
  });

  it('follows the organization’s ceiling: under `public`, an internal record stays on the host', async () => {
    const set = await person(
      'POST',
      '/actions/set_model_routing_policy',
      {
        targetIds: [f.organizationId],
        payload: { provider_ceiling: 'public' },
        reason: 'only public content may reach a provider here',
        idempotencyKey: `routing-${randomUUID()}`,
      },
      REVIEWER,
    );
    expect(set.status, JSON.stringify(set.body)).toBeLessThan(300);
    try {
      engineIds = [ids.internal];
      const { answer, recorder } = await turn('bench rail');
      expect(answer.backend?.kind).toBe('on_host');
      expect(recorder.sent).toHaveLength(0);
    } finally {
      await person(
        'POST',
        '/actions/set_model_routing_policy',
        {
          targetIds: [f.organizationId],
          payload: { provider_ceiling: 'internal' },
          reason: 'back to the default ceiling',
          idempotencyKey: `routing-${randomUUID()}`,
        },
        REVIEWER,
      );
    }
  });

  it('FALSIFIED: with the comparison lowered by one rank, the recorder receives the confidential record', async () => {
    // The probe is not blind: when the guard is wrong, the record that reached the provider is
    // named in what the provider received.
    engineIds = [ids.confidential];
    const lowered = (classification: string, ceiling: string) =>
      ceiling !== 'none' &&
      ['public', 'internal', 'confidential', 'restricted'].indexOf(classification) <=
        ['public', 'internal', 'confidential', 'restricted'].indexOf(ceiling) + 1;
    const fabric = fabricFor(() => delegated());
    const recorder = new Recorder();
    await answerTurn(
      {
        fabric,
        backends: {
          onHost: new Host(),
          provider: new ProviderBackend(recorder, {
            ceiling: ceilingOf(fabric),
            mayLeave: lowered,
          }),
        },
        sealKey: SEAL_KEY,
        mayLeave: lowered,
      },
      { question: 'tantalum' },
    );
    expect(recorder.bytes()).toContain(ids.confidential);
    expect(recorder.bytes()).toContain('tantalum');
  });

  it('an agent cannot widen what leaves: setting the ceiling is institutional', async () => {
    const fabric = fabricFor(() => delegated());
    const answer = await fabric.call('POST', '/actions/set_model_routing_policy', {
      body: {
        targetIds: [f.organizationId],
        payload: { provider_ceiling: 'internal' },
        reason: 'an agent widening its own reach',
        idempotencyKey: `routing-${randomUUID()}`,
      },
    });
    expect(answer.status).toBeGreaterThanOrEqual(400);
  });
});

describe('every answer cites, and says what it withheld (OBL-002, KF-SAS-RQ-272)', () => {
  it('cites a record the reader read, names its backend, and counts as GET /search counts', async () => {
    engineIds = [ids.internal, ids.public];
    const before = (
      await withTransaction(h.adminPool, (tx) => tx.one<{ now: Date }>('select now() as now'))
    ).now;
    const { answer } = await turn('bench rail canteen');
    expect(answer.status).toBe('answered');
    expect(answer.backend).not.toBeNull();
    expect(answer.citations).toHaveLength(1);
    expect(answer.citations[0]).toMatchObject({
      recordId: ids.internal,
      title: 'Bench rail measured at 3.31 V under load',
    });
    const search = await person(
      'GET',
      `/search?q=${encodeURIComponent('bench rail canteen')}&limit=8`,
    );
    expect(answer.withheldCount).toBe(search.body['withheldCount']);

    // Each read is a recorded disclosure, with the in-app agent's participation (RQ-250).
    const disclosures = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ operation: string; object_id: string | null; agent_participation: string | null }>(
        `select operation, object_id, agent_participation from search.context_disclosure
          where recorded_at >= $1 and refusal is null order by recorded_at, id`,
        [before],
      ),
    );
    expect(
      disclosures
        .filter((d) => d.operation === 'read')
        .map((d) => d.object_id)
        .sort(),
    ).toEqual([ids.internal, ids.public].sort());
    expect(disclosures.every((d) => d.agent_participation === AGENT)).toBe(true);
  });

  it('a reader in another organization is never given this one’s records', async () => {
    engineIds = [ids.internal, ids.restricted, foreignId];
    const fabric = fabricFor(() => delegated(OUTSIDER), {
      organizationId: g.organizationId,
      roleId: g.performerRoleId,
    });
    const answer = await answerTurn(
      { fabric, backends: { onHost: new Host() }, sealKey: SEAL_KEY },
      { question: 'halberd' },
    );
    expect(answer.consulted.map((c) => c.recordId)).toEqual([foreignId]);
  });

  it('refuses an answer citing a record outside the reader’s context, rather than trimming it', async () => {
    engineIds = [ids.internal];
    const fabric = fabricFor(() => delegated());
    const host = new Host();
    host.reply = `It is in ${foreignId} [1].`;
    const answer = await answerTurn(
      { fabric, backends: { onHost: host }, sealKey: SEAL_KEY },
      { question: 'bench rail' },
    );
    expect(answer.refusal?.rule).toBe('KF-CHAT-002');
    expect(answer.text).toBeNull();
  });
});

describe('the agent drafts; the person commits (OBL-003, KF-SAS-RQ-266)', () => {
  async function ledger(objectId: string) {
    return withTransaction(h.adminPool, (tx) =>
      tx.query<{ action_type: string; actor_id: string; agent_participation: string | null }>(
        `select action_type, actor_id, agent_participation from core.action
          where $1 = any(target_ids) order by recorded_at, id`,
        [objectId],
      ),
    );
  }

  it('a committed draft is ONE act: the person’s, with the agent’s participation, unverified', async () => {
    const outcome = await draftFromRequest({}, 'internal', 'Record that bench 4 tripped at 3.29 V');
    expect(outcome.act.act).toBe('record_observation');
    const key = `chat-${randomUUID()}`;
    const fabric = fabricFor(() => delegated());
    const submitted = await submitDraft(fabric, {
      act: outcome.act.act,
      fields: outcome.draft.payload,
      idempotencyKey: key,
    });
    expect(submitted.disposition, JSON.stringify(submitted)).toBe('submitted');
    if (submitted.disposition !== 'submitted') return;
    const id = submitted.recordIds[0]!;
    expect(await ledger(id)).toEqual([
      { action_type: 'record_observation', actor_id: f.performerId, agent_participation: AGENT },
    ]);
    expect(submitted.verification[id]).toMatchObject({ verified: false });

    // The same gesture again replays: still one act.
    const again = await submitDraft(fabric, {
      act: outcome.act.act,
      fields: outcome.draft.payload,
      idempotencyKey: key,
    });
    expect(again.disposition).toBe('submitted');
    expect(await ledger(id)).toHaveLength(1);
  });

  it('an incomplete form is refused whole, with its problems', async () => {
    const refused = await submitDraft(
      fabricFor(() => delegated()),
      {
        act: 'create_initiative',
        fields: { title: 'Half a form' },
        idempotencyKey: `chat-${randomUUID()}`,
      },
    );
    expect(refused).toMatchObject({ disposition: 'refused', code: 'draft_incomplete' });
  });

  it('an institutional act becomes a proposal in Needs you, and nothing is performed', async () => {
    const target = await decision('Adopt the second-source capacitor', 'internal');
    const proposed = await submitDraft(
      fabricFor(() => delegated()),
      {
        act: 'accept_decision',
        targetIds: [target],
        reason: 'the bench data supports the second source',
        idempotencyKey: `chat-${randomUUID()}`,
      },
    );
    expect(proposed.disposition).toBe('proposed');
    const state = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ lifecycle_state: string }>('select lifecycle_state from core.object where id = $1', [
        target,
      ]),
    );
    expect(state.lifecycle_state).toBe('draft');
    expect((await ledger(target)).map((row) => row.action_type)).not.toContain('accept_decision');
    const waiting = await person('GET', '/needs-you');
    const proposals = (
      waiting.body['proposals'] as { items: { actionType: string; targetIds: string[] }[] }
    ).items;
    expect(
      proposals.some((p) => p.actionType === 'accept_decision' && p.targetIds.includes(target)),
    ).toBe(true);
  });
});

describe('a turn keeps nothing', () => {
  it('changes no table but the transient disclosure records', async () => {
    engineIds = [ids.internal, ids.public];
    await turn('bench rail canteen'); // compiles the master record if it is stale
    const counts = async () =>
      withTransaction(h.adminPool, async (tx) => {
        const tables = await tx.query<{ name: string }>(
          `select format('%I.%I', schemaname, relname) as name from pg_stat_user_tables
            where schemaname not in ('public') order by 1`,
        );
        const result = new Map<string, number>();
        for (const { name } of tables) {
          const row = await tx.one<{ n: string }>(`select count(*)::text as n from ${name}`);
          result.set(name, Number(row.n));
        }
        return result;
      });
    const before = await counts();
    await turn('bench rail canteen');
    const after = await counts();
    const changed = [...after].filter(([name, n]) => before.get(name) !== n).map(([name]) => name);
    // What a turn may leave behind: the §64B transient observations of the search and the reads.
    const TRANSIENT = new Set([
      'search.recorded_query',
      'search.demand_contribution',
      'search.asker_key',
      'search.context_disclosure',
      'retrieval.disclosure',
      'core.principal_attestation',
    ]);
    expect(changed.filter((name) => !TRANSIENT.has(name))).toEqual([]);
    expect(changed).toContain('search.context_disclosure');
  });
});
