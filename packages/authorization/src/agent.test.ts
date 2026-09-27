/**
 * The `act` claim of a delegated token (ADR 0035), at the token-parsing seam.
 *
 * The accepted shape is the one Keycloak 26.4 issues through the realm's `act-client-id` mapper,
 * measured against the pinned image (docs/deployment/identity-and-login.md):
 *
 *   { "sub": <person>, "azp": "knowledge-fabric-agent", "act": { "client_id": "knowledge-fabric-agent" } }
 *
 * Whether the client is a DECLARED agent is the database's question and is tested there
 * (tests/database/agent-participation.test.ts) and end to end over the attestor's socket
 * (tests/permissions/agent-participation.test.ts).
 */

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { IdentityRejected, TokenVerifier, agentOf } from './identity.js';

const ISSUER = 'https://idp.example.test/realms/knowledge-fabric';
const AUDIENCE = 'knowledge-fabric-api';
const AGENT = 'knowledge-fabric-agent';

/** The claims of a token the attestor has already verified; only `azp` and `act` matter here. */
const payload = (claims: Record<string, unknown>): JWTPayload => ({
  iss: ISSUER,
  aud: AUDIENCE,
  sub: 'person-subject',
  exp: Math.floor(Date.now() / 1000) + 300,
  ...claims,
});

describe('agentOf', () => {
  it('reads no agent from a person’s own token', () => {
    expect(agentOf(payload({ azp: 'knowledge-fabric-web' }))).toBeUndefined();
  });

  it('reads the agent from the exact shape the realm issues', () => {
    expect(agentOf(payload({ azp: AGENT, act: { client_id: AGENT } }))).toBe(AGENT);
  });

  it.each([
    ['act is a string', { azp: AGENT, act: AGENT }],
    ['act is null', { azp: AGENT, act: null }],
    ['act is an array', { azp: AGENT, act: [{ client_id: AGENT }] }],
    ['act is empty', { azp: AGENT, act: {} }],
    ['act names a sub, not a client_id', { azp: AGENT, act: { sub: AGENT } }],
    ['act carries a second member', { azp: AGENT, act: { client_id: AGENT, sub: 'x' } }],
    [
      'act is nested (a chain of actors)',
      { azp: AGENT, act: { client_id: AGENT, act: { client_id: 'another-agent' } } },
    ],
    ['act.client_id is not a string', { azp: AGENT, act: { client_id: 7 } }],
    ['act.client_id is empty', { azp: '', act: { client_id: '' } }],
    ['act.client_id is not a client id', { azp: 'a b', act: { client_id: 'a b' } }],
    [
      'act.client_id names a client other than azp',
      { azp: 'knowledge-fabric-web', act: { client_id: AGENT } },
    ],
    ['the token has no azp', { act: { client_id: AGENT } }],
  ])('refuses a token whose %s', (_name, claims) => {
    expect(() => agentOf(payload(claims))).toThrow();
  });
});

describe('TokenVerifier refuses a malformed delegation as a token defect', () => {
  let verifier: TokenVerifier;
  let sign: (claims: Record<string, unknown>) => Promise<string>;
  const reasons: string[] = [];

  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    verifier = new TokenVerifier(
      { issuer: ISSUER, audience: AUDIENCE, jwksUri: 'https://unused.invalid/jwks' },
      createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg: 'RS256' }] }),
      (reason) => reasons.push(reason),
    );
    sign = (claims) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k' })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject('person-subject')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
  });

  it('accepts the exchanged shape', async () => {
    const verified = await verifier.verify(await sign({ azp: AGENT, act: { client_id: AGENT } }));
    expect(agentOf(verified)).toBe(AGENT);
  });

  it('refuses a nested act with the one collapsed code, and logs why', async () => {
    const err = await verifier
      .verify(
        await sign({ azp: AGENT, act: { client_id: AGENT, act: { client_id: 'another-agent' } } }),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdentityRejected);
    expect((err as IdentityRejected).failure).toBe('invalid_token');
    expect(reasons.at(-1)).toMatch(/nested/);
  });

  it('refuses an act naming a client the token was not issued to', async () => {
    const err = await verifier
      .verify(await sign({ azp: 'knowledge-fabric-web', act: { client_id: AGENT } }))
      .catch((e: unknown) => e);
    expect((err as IdentityRejected).failure).toBe('invalid_token');
    expect(reasons.at(-1)).toMatch(/azp/);
  });
});
