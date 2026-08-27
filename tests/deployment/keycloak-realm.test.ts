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
    // Confidential (`publicClient: false`) and deliberately WITHOUT a secret. The API only
    // validates tokens; it never requests one, so it needs no credential — and a credential is
    // the one thing this file must never carry. A confidential client with no secret cannot be
    // used for a client-credentials flow; that is a consequence, not an oversight.
    const api = client(API_CLIENT);
    // Assert existence by name as well as posture: `publicClient` is optional in an export, so a
    // posture-only check would be satisfied by `undefined ?? false` on a client that had drifted.
    expect(api.clientId).toBe(API_CLIENT);
    expect(api.publicClient ?? false).toBe(false);
  });
});

/**
 * Scoped to the `keycloak` service rather than matched against the whole file: a bare search for
 * `--import-realm` would pass if the flag appeared under any other service, which is exactly the
 * regression this is supposed to catch. Matching is tolerant of quoting and of `./` on the mount
 * source, because neither changes behaviour and a test that reddens on a cosmetic edit trains
 * people to ignore it.
 */
function keycloakService(): string {
  const compose = readFileSync(COMPOSE_PATH, 'utf8');
  // Search from `services:` onward. A bare search for `\n  keycloak:` would also match a volume
  // or network of that name under a later top-level key, and would then slice the wrong block —
  // today's volume is `keycloak-data`, but that is a coincidence to not depend on.
  const services = compose.indexOf('\nservices:');
  if (services === -1) throw new Error('no services block in docker-compose.yml');
  const start = compose.indexOf('\n  keycloak:', services);
  if (start === -1) throw new Error('no keycloak service in docker-compose.yml');
  // Ends at the next key at the same indentation — the next service, or the top-level `volumes:`.
  // A 2-space-indented comment between services would also end it early; that would under-read
  // rather than over-read, so the guards stay conservative.
  const rest = compose.slice(start + 1);
  const next = rest.search(/\n(?: {2}\S|\S)/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('compose actually imports that realm', () => {
  it('passes --import-realm to Keycloak', () => {
    expect(keycloakService()).toMatch(/command:[\s\S]*--import-realm/);
  });

  it('mounts the realm directory read-only into the import path', () => {
    // Read-only so a container cannot rewrite the committed artifact and make local drift look
    // like the checked-in truth.
    expect(keycloakService()).toMatch(
      /(?:\.\/)?deploy\/keycloak\/?:\/opt\/keycloak\/data\/import:ro/,
    );
  });

  it('scopes those assertions to the keycloak service', () => {
    // Guards the guard: if the slice above ever returned the whole file, the two tests before
    // this one would pass for the wrong reason.
    const section = keycloakService();
    expect(section).toContain('kf-keycloak');
    expect(section).not.toContain('kf-postgres');
    expect(section).not.toContain('kf-minio');
  });
});
