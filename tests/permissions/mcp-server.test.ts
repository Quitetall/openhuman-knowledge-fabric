/**
 * The KF MCP server, end to end through every real seam (ADR 0035, ADR 0040; KF-SAS-RQ-020,
 * RQ-150, RQ-204, RQ-263 to RQ-266; KF-WAR-0004 OBL-001 to OBL-005).
 *
 * An MCP client talks to `createKfMcpServer` over the SDK's in-memory transport; the server calls
 * the real API (`buildApp`, dogfood profile) over loopback HTTP with a delegated token; the API
 * identifies every caller through the real kf-attestor over its Unix socket, which verifies the
 * token against a local key and attests under its own login; the API's own login is a bare
 * `kf_app` with no attestation issuer. Tokens have the shape Keycloak 26.4 issues through the
 * realm's `act-client-id` mapper: `sub` the person, `azp` the agent client, `act.client_id` the
 * same. Nothing is stubbed between the MCP client and PostgreSQL.
 *
 * Covered, each with the probe that shows it can fail:
 *   - an agent submits an observation through MCP; it is the person's act with the agent's
 *     participation, unverified; the authority verifies it from Needs you;
 *   - a policy verifies an agent's observations on arrival, and the answer names the policy;
 *   - an institutional act through MCP is proposed, never performed, never policy-verified (the
 *     database refuses the policy), and its person performs it from Needs you;
 *   - an undeclared agent, and a token that names no linked person, are refused;
 *   - MCP reaches no general write: the closed list is the only one, and an act outside it fails
 *     schema validation before anything is sent;
 *   - another organization's records are not found through MCP, exactly as an id that exists
 *     nowhere, and its words are not found or counted.
 */

import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SignJWT, createLocalJWKSet, exportJWK, type JWK } from 'jose';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { InMemoryObjectStore } from '@kf/artifacts';
import { LocalAttestor, TokenVerifier, linkIdentity } from '@kf/authorization';
import { createPool, withTransaction, type Pool } from '@kf/database';
import { AGENT_ACT_NAMES } from '@kf/domain';
import { createAttestorServer } from '../../apps/attestor/src/server.js';
import { buildApp } from '../../apps/api/src/app.js';
import { runDeclareAgent } from '../../apps/api/src/admin/declare-agent.js';
import { FabricApi } from '../../apps/mcp/src/api.js';
import { KF_MCP_TOOLS, createKfMcpServer } from '../../apps/mcp/src/server.js';
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
const AGENT = 'mcp-colleague-agent';
const PERFORMER = 'auth0|performer';
const REVIEWER = 'auth0|reviewer';
const OUTSIDER = 'auth0|outsider';

let h: Harness;
let f: Fixtures;
/** A second organization: the one whose records the first's agent must never reach. */
let g: Fixtures;
let privateKey: KeyObject;
let bareApp: Pool;
let attestorServer: Server;
let socketDir: string;
let api: FastifyInstance;
let apiUrl: URL;
const logLines: unknown[] = [];

async function token(claims: Record<string, unknown>, subject: string | null = PERFORMER) {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m');
  if (subject !== null) jwt.setSubject(subject);
  return jwt.sign(privateKey);
}

/** The performer's token exchanged for the declared agent: what the MCP server holds. */
const delegated = (agent = AGENT, subject: string | null = PERFORMER) =>
  token({ azp: agent, act: { client_id: agent } }, subject);
const own = (subject = PERFORMER) => token({ azp: WEB }, subject);

/** An MCP client connected to a server holding `bearer`, for the performer's context. */
async function mcpWith(
  bearer: () => Promise<string>,
  context: { organizationId?: string; actingRoleId?: string } = {},
): Promise<Client> {
  const fabric = new FabricApi({
    apiUrl,
    tokens: { describe: 'test', token: bearer },
    organizationId: context.organizationId ?? f.organizationId,
    actingRoleId: context.actingRoleId ?? f.performerRoleId,
    classification: 'restricted',
  });
  const server = createKfMcpServer(fabric, (entry) => logLines.push(entry));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'kf-mcp-test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

interface ToolAnswer {
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
  readonly content: { type: string; text?: string }[];
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolAnswer;
}

/** A person calling the API directly with their own token (the web application's position). */
async function asPerson(
  method: 'GET' | 'POST',
  path: string,
  who: { subject: string; roleId: string; organizationId?: string },
  body?: unknown,
  bearer?: string,
) {
  const res = await api.inject({
    method,
    url: path,
    headers: {
      authorization: `Bearer ${bearer ?? (await own(who.subject))}`,
      'x-kf-acting-role': who.roleId,
      'x-kf-organization': who.organizationId ?? f.organizationId,
      'x-kf-classification': 'restricted',
    },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

const reviewer = () => ({ subject: REVIEWER, roleId: f.reviewerRoleId });
const performer = () => ({ subject: PERFORMER, roleId: f.performerRoleId });

async function ledger(objectId: string) {
  return withTransaction(h.adminPool, (tx) =>
    tx.query<{ action_type: string; actor_id: string; agent_participation: string | null }>(
      `select action_type, actor_id, agent_participation from core.action
        where $1 = any(target_ids) order by recorded_at, id`,
      [objectId],
    ),
  );
}

async function verificationRow(objectId: string) {
  return withTransaction(h.adminPool, (tx) =>
    tx.maybeOne<{ basis: string; policy_id: string | null; verified_by: string }>(
      'select basis, policy_id, verified_by from core.object_verification where object_id = $1',
      [objectId],
    ),
  );
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
    reason: 'the MCP agent under test acts for the performer',
    withdraw: false,
  });

  await withTransaction(h.adminPool, async (tx) => {
    await tx.query(`create role kf_mcp_test_api login password 'test-only-not-a-secret'`);
    await tx.query('grant kf_app to kf_mcp_test_api');
    await tx.query('grant connect on database kf_test to kf_mcp_test_api');
  });
  const uri = new URL(h.connectionString);
  uri.username = 'kf_mcp_test_api';
  uri.password = 'test-only-not-a-secret';
  bareApp = createPool({ connectionString: uri.toString(), maxConnections: 2 });

  socketDir = mkdtempSync(join(tmpdir(), 'kf-mcp-'));
  const socketPath = join(socketDir, 'attestor.sock');
  attestorServer = createAttestorServer(new LocalAttestor(h.attestorPool, verifier));
  await new Promise<void>((resolve) => attestorServer.listen(socketPath, resolve));

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
    { objectStore: new InMemoryObjectStore() },
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

describe('the tool surface is closed', () => {
  it('lists exactly the nine tools, and none that verifies, confirms or writes generally', async () => {
    const client = await mcpWith(() => delegated());
    const { tools } = await client.listTools();
    expect(tools.map((tool: { name: string }) => tool.name).sort()).toEqual(
      [...KF_MCP_TOOLS].sort(),
    );
    for (const tool of tools as { name: string }[]) {
      expect(tool.name).not.toMatch(/verify|confirm|policy|resolve|^act$|write/);
    }
  });

  it('submit_act takes only the closed list: no verify, policy, proposal or resolution', async () => {
    const client = await mcpWith(() => delegated());
    const { tools } = await client.listTools();
    const submit = tools.find((tool: { name: string }) => tool.name === 'submit_act')!;
    const act = (submit.inputSchema as unknown as { properties: { act: { enum: string[] } } })
      .properties.act;
    expect([...act.enum].sort()).toEqual([...AGENT_ACT_NAMES].sort());
    for (const forbidden of [
      'verify_record',
      'set_verification_policy',
      'propose_act',
      'resolve_act_proposal',
      'grant_access',
      'correct_record',
    ]) {
      expect(act.enum).not.toContain(forbidden);
    }
  });

  it('an act outside the list is refused before anything is sent', async () => {
    const client = await mcpWith(() => delegated());
    const before = logLines.length;
    for (const act of ['verify_record', 'set_verification_policy', 'grant_access']) {
      let answer: ToolAnswer | undefined;
      let thrown: unknown;
      try {
        answer = await call(client, 'submit_act', { act, targetIds: [f.organizationId] });
      } catch (error: unknown) {
        thrown = error;
      }
      expect(thrown !== undefined || answer?.isError === true, act).toBe(true);
    }
    // Nothing reached the API: the server logs every call it makes, and it made none.
    expect(
      logLines.slice(before).filter((l) => (l as { status?: number }).status !== undefined),
    ).toEqual([]);
  });
});

describe('an agent submits; the authority verifies', () => {
  let observationId: string;

  it('a captured observation is the person’s act with the agent’s participation, unverified', async () => {
    const client = await mcpWith(() => delegated());
    const draft = await call(client, 'draft_act', {
      act: 'record_observation',
      fields: { body: 'Bench 4: rail at 3.29 V under load, below the 3.30 V floor' },
    });
    expect(draft.structuredContent?.['draft']).toMatchObject({
      ready: true,
      disposition: 'submit',
    });

    const submitted = await call(client, 'submit_act', {
      act: 'record_observation',
      fields: { body: 'Bench 4: rail at 3.29 V under load, below the 3.30 V floor' },
    });
    expect(submitted.isError, JSON.stringify(submitted.structuredContent)).not.toBe(true);
    const result = submitted.structuredContent!;
    expect(result['disposition']).toBe('submitted');
    observationId = (result['recordIds'] as string[])[0]!;
    expect(
      (result['verification'] as Record<string, { verified: boolean }>)[observationId],
    ).toMatchObject({
      verified: false,
    });
    expect(await ledger(observationId)).toEqual([
      { action_type: 'record_observation', actor_id: f.performerId, agent_participation: AGENT },
    ]);
    expect(await verificationRow(observationId)).toBeUndefined();
  });

  it('waits in the authority’s Needs you, and in the person’s as awaiting someone else', async () => {
    const theirs = await asPerson('GET', '/needs-you', reviewer());
    expect(theirs.status).toBe(200);
    const toVerify = (theirs.body['toVerify'] as { items: { id: string; agentClientId: string }[] })
      .items;
    expect(toVerify.find((item) => item.id === observationId)).toMatchObject({
      agentClientId: AGENT,
    });

    const mine = await asPerson('GET', '/needs-you', performer());
    const awaiting = (mine.body['awaitingOthers'] as { items: { id: string }[] }).items;
    expect(awaiting.map((item) => item.id)).toContain(observationId);
    expect(
      (mine.body['toVerify'] as { items: unknown[] }).items.map((i) => (i as { id: string }).id),
    ).not.toContain(observationId);

    // And the agent's own view through MCP says the same, read-only.
    const client = await mcpWith(() => delegated());
    const listed = await call(client, 'list_needs_you', {});
    expect(listed.isError).not.toBe(true);
  });

  it('the agent cannot answer Needs you, by name and in the database', async () => {
    const asAgent = await asPerson(
      'POST',
      '/needs-you/verify',
      reviewer(),
      {
        recordId: observationId,
        expectedVersion: 1,
        reason: 'agent verifying',
        idempotencyKey: `v-${randomUUID()}`,
      },
      await delegated(AGENT, REVIEWER),
    );
    expect(asAgent.status).toBe(403);
    expect(asAgent.body['error']).toBe('agent_cannot_answer');
    // Around the route, straight at the action endpoint: the database refuses it.
    const direct = await asPerson(
      'POST',
      '/actions/verify_record',
      reviewer(),
      {
        targetIds: [observationId],
        payload: { basis: 'promoted_in_bulk' },
        reason: 'agent verifying around the route',
        idempotencyKey: `v-${randomUUID()}`,
      },
      await delegated(AGENT, REVIEWER),
    );
    expect(direct.status).toBe(422);
    expect((direct.body['detail'] as { rule?: string }).rule).toBe('KF-AGENT-002');
    expect(await verificationRow(observationId)).toBeUndefined();
  });

  it('one click from Needs you verifies it, individually, as the version opened', async () => {
    const listed = await asPerson('GET', '/needs-you', reviewer());
    const item = (
      listed.body['toVerify'] as { items: { id: string; rowVersion: number }[] }
    ).items.find((i) => i.id === observationId)!;
    const stale = await asPerson('POST', '/needs-you/verify', reviewer(), {
      recordId: observationId,
      expectedVersion: 999,
      reason: 'checked against the bench log',
      idempotencyKey: `v-${randomUUID()}`,
    });
    expect(stale.status).toBe(409);
    const verified = await asPerson('POST', '/needs-you/verify', reviewer(), {
      recordId: observationId,
      expectedVersion: item.rowVersion,
      reason: 'checked against the bench log',
      idempotencyKey: `v-${randomUUID()}`,
    });
    expect(verified.status, JSON.stringify(verified.body)).toBe(201);
    expect(await verificationRow(observationId)).toMatchObject({
      basis: 'reviewed_individually',
      verified_by: f.reviewerId,
      policy_id: null,
    });
    const after = await asPerson('GET', '/needs-you', reviewer());
    expect(
      (after.body['toVerify'] as { items: { id: string }[] }).items.map((item) => item.id),
    ).not.toContain(observationId);
  });
});

describe('a verification policy', () => {
  it('verifies the trusted agent’s observations on arrival, and the answer names the policy', async () => {
    const set = await asPerson('POST', '/actions/set_verification_policy', reviewer(), {
      targetIds: [f.organizationId],
      payload: {
        object_type: 'observation',
        action_type: 'record_observation',
        agent_client_id: AGENT,
        mode: 'verified_on_submit',
      },
      reason: 'the bench agent’s readings have matched the log for a month',
      idempotencyKey: `policy-${randomUUID()}`,
    });
    expect(set.status, JSON.stringify(set.body)).toBe(201);
    const policyId = (set.body['receipt'] as { policyId: string }).policyId;

    const client = await mcpWith(() => delegated());
    const submitted = await call(client, 'submit_act', {
      act: 'record_observation',
      fields: { body: 'Bench 5: rail at 3.31 V under load' },
    });
    const id = (submitted.structuredContent!['recordIds'] as string[])[0]!;
    const verification = (
      submitted.structuredContent!['verification'] as Record<string, Record<string, unknown>>
    )[id]!;
    expect(verification).toMatchObject({ verified: true, basis: 'verified_by_policy', policyId });
    expect(String(verification['label'])).toContain(policyId);
    expect(await verificationRow(id)).toMatchObject({
      basis: 'verified_by_policy',
      policy_id: policyId,
    });

    // The listing shows it, and an agent cannot set one (it is institutional).
    const policies = await asPerson('GET', '/verification-policies', performer());
    expect((policies.body['policies'] as { id: string }[]).map((p) => p.id)).toContain(policyId);
    const byAgent = await asPerson(
      'POST',
      '/actions/set_verification_policy',
      reviewer(),
      {
        targetIds: [f.organizationId],
        payload: {
          object_type: 'observation',
          action_type: 'record_observation',
          agent_client_id: AGENT,
          mode: 'verified_on_submit',
        },
        reason: 'an agent trusting itself',
        idempotencyKey: `policy-${randomUUID()}`,
      },
      await delegated(AGENT, REVIEWER),
    );
    expect((byAgent.body['detail'] as { rule?: string }).rule).toBe('KF-AGENT-001');

    // Back to the default for the tests that follow.
    await asPerson('POST', '/actions/set_verification_policy', reviewer(), {
      targetIds: [f.organizationId],
      payload: {
        object_type: 'observation',
        action_type: 'record_observation',
        agent_client_id: AGENT,
        mode: 'required',
      },
      reason: 'back to a person verifying every reading',
      idempotencyKey: `policy-${randomUUID()}`,
    });
  });

  it('is refused for an institutional act, by the database (KF-VPOL-001)', async () => {
    const refused = await asPerson('POST', '/actions/set_verification_policy', reviewer(), {
      targetIds: [f.organizationId],
      payload: {
        object_type: 'observation',
        action_type: 'promote_observation',
        agent_client_id: AGENT,
        mode: 'verified_on_submit',
      },
      reason: 'trying to let the agent promote on its own',
      idempotencyKey: `policy-${randomUUID()}`,
    });
    expect(refused.status).toBe(422);
    expect((refused.body['detail'] as { rule?: string }).rule).toBe('KF-VPOL-001');
  });
});

describe('an institutional act through MCP', () => {
  it('is proposed, never performed; the person performs it from Needs you', async () => {
    const client = await mcpWith(() => delegated());
    const captured = await call(client, 'submit_act', {
      act: 'record_observation',
      fields: { body: 'Bench 6: rail recovered to 3.32 V after the regulator swap' },
    });
    const observation = (captured.structuredContent!['recordIds'] as string[])[0]!;

    const proposed = await call(client, 'submit_act', {
      act: 'promote_observation',
      targetIds: [observation],
      reason: 'the reading is confirmed by the log; promote it',
    });
    expect(proposed.isError, JSON.stringify(proposed.structuredContent)).not.toBe(true);
    expect(proposed.structuredContent).toMatchObject({ disposition: 'proposed', performed: false });
    const proposalId = String(proposed.structuredContent!['proposalId']);
    const stateOf = async () =>
      (
        await withTransaction(h.adminPool, (tx) =>
          tx.one<{ lifecycle_state: string }>(
            'select lifecycle_state from core.object where id = $1',
            [observation],
          ),
        )
      ).lifecycle_state;
    expect(await stateOf()).toBe('captured');

    // The agent's token straight at the action endpoint: refused by the database.
    const around = await asPerson(
      'POST',
      '/actions/promote_observation',
      performer(),
      {
        targetIds: [observation],
        reason: 'the agent promoting around the proposal',
        idempotencyKey: `p-${randomUUID()}`,
      },
      await delegated(),
    );
    expect(around.status).toBe(422);
    expect((around.body['detail'] as { rule?: string }).rule).toBe('KF-AGENT-001');
    expect(await stateOf()).toBe('captured');

    // Nor can the agent confirm its own proposal.
    const selfConfirm = await asPerson(
      'POST',
      `/needs-you/proposals/${proposalId}/confirm`,
      performer(),
      {},
      await delegated(),
    );
    expect(selfConfirm.status).toBe(403);

    // The person sees it, and performs it with their own token.
    const needs = await asPerson('GET', '/needs-you', performer());
    const proposals = (
      needs.body['proposals'] as { items: { id: string; confirmableHere: boolean }[] }
    ).items;
    expect(proposals.find((p) => p.id === proposalId)).toMatchObject({ confirmableHere: true });
    const confirmed = await asPerson(
      'POST',
      `/needs-you/proposals/${proposalId}/confirm`,
      performer(),
      {},
    );
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
    expect(await stateOf()).toBe('promoted');
    const acts = await ledger(observation);
    const promotion = acts.find((a) => a.action_type === 'promote_observation');
    expect(promotion).toMatchObject({ actor_id: f.performerId, agent_participation: null });
    // Promoted by its person, and still not verified by anything but a person.
    expect(await verificationRow(observation)).toBeUndefined();
    const again = await asPerson(
      'POST',
      `/needs-you/proposals/${proposalId}/confirm`,
      performer(),
      {},
    );
    expect(again.status).toBe(409);
  });
});

describe('identity at the MCP edge', () => {
  it('refuses an agent nobody declared', async () => {
    const client = await mcpWith(() => delegated('rogue-agent'));
    const answer = await call(client, 'search', { query: 'rail' });
    expect(answer.isError).toBe(true);
    expect(answer.structuredContent).toMatchObject({
      status: 401,
      refusal: { error: 'undeclared_agent' },
    });
  });

  it('refuses a token that names no linked person', async () => {
    const unlinked = await mcpWith(() => delegated(AGENT, 'auth0|nobody-we-know'));
    expect((await call(unlinked, 'search', { query: 'rail' })).structuredContent).toMatchObject({
      status: 401,
      refusal: { error: 'unknown_subject' },
    });
    const anonymous = await mcpWith(() => delegated(AGENT, null));
    const answer = await call(anonymous, 'list_needs_you', {});
    expect(answer.isError).toBe(true);
    expect((answer.structuredContent as { status: number }).status).toBe(401);
  });

  it('refuses a token whose agent claim is missing, so the agent cannot pass as its person', async () => {
    const client = await mcpWith(() => token({ azp: AGENT }));
    const answer = await call(client, 'list_needs_you', {});
    expect(answer.structuredContent).toMatchObject({
      status: 401,
      refusal: { error: 'undeclared_agent' },
    });
  });
});

describe('another organization, through MCP', () => {
  let foreign: string;
  const WORD = `quillwort${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    foreign = await createObject(h.adminPool, g, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: `Foreign ${WORD} reading`,
      createdBy: g.performerId,
    });
    await withTransaction(h.adminPool, (tx) =>
      tx.query('select search.index_object($1)', [foreign]),
    );
  });

  it('the probe can fail: the other organization’s own person reads and finds it', async () => {
    const outsider = {
      subject: OUTSIDER,
      roleId: g.performerRoleId,
      organizationId: g.organizationId,
    };
    const read = await asPerson('POST', `/objects/${foreign}/refresh`, outsider);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const found = await asPerson('GET', `/search?q=${WORD}`, outsider);
    expect((found.body['lexical'] as { total: number }).total).toBeGreaterThan(0);
  });

  it('is not found by id, exactly as an id that exists nowhere', async () => {
    const client = await mcpWith(() => delegated());
    const theirs = await call(client, 'read_record', { id: foreign });
    const nowhere = await call(client, 'read_record', { id: randomUUID() });
    expect(theirs.isError).toBe(true);
    expect(theirs.structuredContent).toEqual(nowhere.structuredContent);
    expect((theirs.structuredContent as { status: number }).status).toBe(404);
  });

  it('its words are neither found nor counted', async () => {
    const client = await mcpWith(() => delegated());
    const answer = await call(client, 'search', { query: WORD });
    expect(answer.isError).not.toBe(true);
    const body = answer.structuredContent as {
      lexical: { total: number };
      withheldCount: number;
    };
    expect(body.lexical.total).toBe(0);
    expect(body.withheldCount).toBe(0);
  });

  it('acting on it is not found, and nothing is recorded', async () => {
    const client = await mcpWith(() => delegated());
    const answer = await call(client, 'submit_act', {
      act: 'withdraw_observation',
      targetIds: [foreign],
      reason: 'an agent reaching across organizations',
    });
    expect(answer.isError).toBe(true);
    expect((answer.structuredContent as { status: number }).status).toBe(404);
    expect(await ledger(foreign)).toEqual([]);
  });

  it('naming the other organization as context is refused', async () => {
    const client = await mcpWith(() => delegated(), {
      organizationId: g.organizationId,
      actingRoleId: g.performerRoleId,
    });
    const answer = await call(client, 'search', { query: WORD });
    expect(answer.isError).toBe(true);
    expect([401, 404]).toContain((answer.structuredContent as { status: number }).status);
  });
});
