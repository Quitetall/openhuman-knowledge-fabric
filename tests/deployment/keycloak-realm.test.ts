import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The committed Keycloak realm is a deployment artifact, and two things about it are
 * load-bearing enough to be asserted rather than remembered.
 *
 * The first is a security property: the export must carry NO users. A realm export containing
 * users contains their credential representations, and a credential committed to git is
 * disclosed permanently — reverting does not undo it. The export was taken with users excluded
 * on purpose, and `scripts/deploy/create-dev-user.sh` supplies the account at runtime instead.
 * A future re-export taken without `exportUsers=false` would silently reintroduce them, and
 * nothing else in the repository would notice.
 *
 * The second is that the realm is actually reachable: compose must pass `--import-realm` and
 * mount the directory holding it. Before 2026-08-27 it did neither, so the stack came up healthy
 * with no realm at all while every OIDC setting pointed at one, and the resulting 404 read as an
 * application fault. See docs/deployment/identity-and-login.md.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const REALM_PATH = join(ROOT, 'deploy', 'keycloak', 'knowledge-fabric-realm.json');
const COMPOSE_PATH = join(ROOT, 'docker-compose.yml');

const REALM = 'knowledge-fabric';
const WEB_CLIENT = 'knowledge-fabric-web';
const API_CLIENT = 'knowledge-fabric-api';
const REDIRECT_URI = 'http://localhost:3000/auth/callback';

interface ProtocolMapper {
  readonly protocolMapper?: string;
  readonly config?: Record<string, string>;
}

interface Client {
  readonly clientId: string;
  readonly publicClient?: boolean;
  readonly redirectUris?: readonly string[];
  readonly attributes?: Record<string, string>;
  readonly protocolMappers?: readonly ProtocolMapper[];
}

interface RealmExport {
  readonly realm: string;
  readonly clients?: readonly Client[];
  readonly users?: readonly unknown[];
}

function realm(): RealmExport {
  return JSON.parse(readFileSync(REALM_PATH, 'utf8')) as RealmExport;
}

function client(clientId: string): Client {
  const found = realm().clients?.find((candidate) => candidate.clientId === clientId);
  if (found === undefined) throw new Error(`no client ${clientId} in the realm export`);
  return found;
}

describe('the committed Keycloak realm', () => {
  it('declares the realm every deployment profile points at', () => {
    expect(realm().realm).toBe(REALM);
  });

  it('carries no users, because an exported user carries its credentials', () => {
    expect(realm().users ?? []).toHaveLength(0);
  });

  it('carries no client secret', () => {
    // A confidential client's secret is a secret regardless of how development-only the realm
    // is; `secret` present with a value is the shape a full export produces.
    for (const candidate of realm().clients ?? []) {
      expect(candidate).not.toHaveProperty('secret');
    }
  });

  it('registers the web client as public with the exact reviewed redirect URI', () => {
    const web = client(WEB_CLIENT);
    expect(web.publicClient).toBe(true);
    // Exact, not a prefix or wildcard: a loose redirect URI is how an authorization code is
    // delivered to somebody else.
    expect(web.redirectUris).toStrictEqual([REDIRECT_URI]);
  });

  it('requires PKCE S256 on the web client', () => {
    expect(client(WEB_CLIENT).attributes?.['pkce.code.challenge.method']).toBe('S256');
  });

  it('puts the API into the web client audience', () => {
    // Without this mapper the flow completes and the API rejects every token, because
    // apps/api/src/config.ts validates `aud`. It is the least visible way for login to fail.
    const mappers = client(WEB_CLIENT).protocolMappers ?? [];
    const audience = mappers.filter((mapper) => mapper.protocolMapper === 'oidc-audience-mapper');
    expect(audience.map((mapper) => mapper.config?.['included.client.audience'])).toContain(
      API_CLIENT,
    );
  });

  it('registers the API client the audience refers to', () => {
    expect(client(API_CLIENT).clientId).toBe(API_CLIENT);
  });
});

describe('compose actually imports that realm', () => {
  const compose = (): string => readFileSync(COMPOSE_PATH, 'utf8');

  it('passes --import-realm to Keycloak', () => {
    expect(compose()).toMatch(/command:.*'--import-realm'/s);
  });

  it('mounts the realm directory read-only into the import path', () => {
    // Read-only so a container cannot rewrite the committed artifact and make local drift look
    // like the checked-in truth.
    expect(compose()).toContain('./deploy/keycloak:/opt/keycloak/data/import:ro');
  });
});
