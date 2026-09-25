#!/usr/bin/env node
/* global fetch, URLSearchParams */
// Register an agent client in the Véracier fixture's loopback realm, shaped as ADR 0035 and
// docs/deployment/identity-and-login.md ("Using it — derived") require:
//
//   - a CONFIDENTIAL client with standard token exchange switched on, no browser flow, no direct
//     grant, no service account, and `fullScopeAllowed: false`;
//   - a hard-coded `act.client_id` claim equal to its own client id, plus the
//     `knowledge-fabric-api` audience (the attestor accepts `act` only when `act.client_id == azp`);
//   - on `knowledge-fabric-web`, an audience mapper naming the new client, so a person's own token
//     lists it as an audience and it may exchange that token.
//
// The committed realm's `knowledge-fabric-agent` client is the template. A client withdrawn with
// `kf declare-agent --withdraw` cannot be declared again under the same id (the declaration row is
// permanent evidence), so a fixture that needs a fresh declared agent registers a new client id.
//
//   node fixtures/veracier/stack/agent-client.mjs <client-id>
//
// Idempotent: an existing client and existing mappers are left as they are. The client secret is
// written to $state/agent-clients/<client-id>.secret (0600) and never printed. This does NOT
// declare the agent to Knowledge Fabric: that is the owner-credential act `kf declare-agent`.

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { adminToken, assertLoopback } from '../lib/keycloak.mjs';

const clientId = process.argv[2];
if (!clientId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(clientId)) {
  throw new Error(
    'usage: agent-client.mjs <client-id>  (the org.declared_agent client_id grammar)',
  );
}
const origin = process.env.KF_VERACIER_KEYCLOAK ?? 'http://localhost:18080';
const realm = 'knowledge-fabric';
const state =
  process.env.KF_VERACIER_STATE ?? path.join(homedir(), '.local', 'state', 'kf-veracier');
assertLoopback(origin);

const token = await adminToken(
  origin,
  readFileSync(path.join(state, 'keycloak-admin-password'), 'utf8').trim(),
);
const admin = async (method, route, body) => {
  const response = await fetch(`${origin}/admin/realms/${realm}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status}`);
  const text = await response.text();
  return text === '' ? undefined : JSON.parse(text);
};
const clientByName = async (id) =>
  (await admin('GET', `/clients?clientId=${encodeURIComponent(id)}`)).find(
    (c) => c.clientId === id,
  );

let agent = await clientByName(clientId);
if (agent === undefined) {
  await admin('POST', '/clients', {
    clientId,
    name: `Fixture agent ${clientId} (acts for a person by token exchange, ADR 0035)`,
    protocol: 'openid-connect',
    enabled: true,
    publicClient: false,
    clientAuthenticatorType: 'client-secret',
    bearerOnly: false,
    standardFlowEnabled: false,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    fullScopeAllowed: false,
    consentRequired: false,
    frontchannelLogout: false,
    redirectUris: [],
    webOrigins: [],
    defaultClientScopes: ['acr', 'basic'],
    optionalClientScopes: [],
    attributes: { 'standard.token.exchange.enabled': 'true', realm_client: 'false' },
    protocolMappers: [
      {
        name: 'knowledge-fabric-api-audience',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-audience-mapper',
        config: {
          'included.client.audience': 'knowledge-fabric-api',
          'access.token.claim': 'true',
          'id.token.claim': 'false',
          'introspection.token.claim': 'true',
          'userinfo.token.claim': 'false',
        },
      },
      {
        name: 'act-client-id',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-hardcoded-claim-mapper',
        config: {
          'claim.name': 'act.client_id',
          'claim.value': clientId,
          'jsonType.label': 'String',
          'access.token.claim': 'true',
          'id.token.claim': 'false',
          'introspection.token.claim': 'true',
          'lightweight.claim': 'false',
          'userinfo.token.claim': 'false',
        },
      },
    ],
  });
  agent = await clientByName(clientId);
  console.log(`registered client ${clientId}`);
} else {
  console.log(`client ${clientId} already registered; left as it is`);
}

const web = await clientByName('knowledge-fabric-web');
if (web === undefined) throw new Error('the realm has no knowledge-fabric-web client');
const mapperName = `${clientId}-audience`;
const mappers = await admin('GET', `/clients/${web.id}/protocol-mappers/models`);
if (!mappers.some((m) => m.name === mapperName)) {
  await admin('POST', `/clients/${web.id}/protocol-mappers/models`, {
    name: mapperName,
    protocol: 'openid-connect',
    protocolMapper: 'oidc-audience-mapper',
    config: {
      'included.client.audience': clientId,
      'access.token.claim': 'true',
      'id.token.claim': 'false',
      'userinfo.token.claim': 'false',
    },
  });
  console.log(`knowledge-fabric-web now lists ${clientId} as an audience`);
} else {
  console.log(`knowledge-fabric-web already lists ${clientId} as an audience`);
}

const { value: secret } = await admin('GET', `/clients/${agent.id}/client-secret`);
const dir = path.join(state, 'agent-clients');
await mkdir(dir, { recursive: true, mode: 0o700 });
const file = path.join(dir, `${clientId}.secret`);
await writeFile(file, `${secret}\n`, { mode: 0o600 });
await chmod(file, 0o600);
console.log(`client secret in ${file} (0600)`);
console.log(
  `next: declare it to Knowledge Fabric with \`kf declare-agent --client ${clientId} …\``,
);
