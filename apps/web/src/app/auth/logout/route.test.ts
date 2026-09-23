import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ID_TOKEN_HINT_COOKIE, SESSION_COOKIE, sealIdTokenHint } from '../../../lib/auth';
import { POST } from './route';

const ISSUER = 'https://id.example.test/realms/kf';
const ORIGIN = 'https://kf.example.test';
const SECRET = Buffer.alloc(32, 7);
const ENV = {
  KF_DEPLOYMENT_PROFILE: 'dogfood',
  KF_WEB_OIDC_ISSUER: ISSUER,
  KF_WEB_OIDC_CLIENT_ID: 'knowledge-fabric-web',
  KF_WEB_OIDC_REDIRECT_URI: `${ORIGIN}/auth/callback`,
  KF_WEB_SESSION_SECRET: SECRET.toString('base64'),
};

function logoutRequest(cookie: string, origin = ORIGIN): NextRequest {
  return new NextRequest(`${ORIGIN}/auth/logout`, {
    method: 'POST',
    headers: { origin, cookie },
  });
}

/** Every cookie the response sets to expire, by name. */
function expired(response: Response): string[] {
  return response.headers
    .getSetCookie()
    .filter((line) => /expires=Thu, 01 Jan 1970/i.test(line))
    .map((line) => line.slice(0, line.indexOf('=')));
}

beforeEach(() => {
  for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
            token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
            jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
            end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
          }),
          { status: 200 },
        ),
    ),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('POST /auth/logout', () => {
  it('names the session being ended to the provider with id_token_hint', async () => {
    // Without the hint Keycloak asks for confirmation, and closing that page leaves the SSO
    // session alive for the next person at a shared machine.
    const hint = await sealIdTokenHint('the.id.token', Math.floor(Date.now() / 1000) + 600, SECRET);
    const response = await POST(logoutRequest(`${ID_TOKEN_HINT_COOKIE}=${hint}`));
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.get('id_token_hint')).toBe('the.id.token');
    expect(expired(response)).toEqual(
      expect.arrayContaining([SESSION_COOKIE, ID_TOKEN_HINT_COOKIE]),
    );
  });

  it('clears the local session even when configuration cannot be loaded', async () => {
    vi.stubEnv('KF_WEB_SESSION_SECRET', '');
    const response = await POST(logoutRequest(`${SESSION_COOKIE}=anything`));
    expect(expired(response)).toEqual(
      expect.arrayContaining([SESSION_COOKIE, ID_TOKEN_HINT_COOKIE]),
    );
  });

  it('clears the local session on a refused cross-origin request, without the provider hop', async () => {
    const response = await POST(logoutRequest(`${SESSION_COOKIE}=anything`, 'https://evil.test'));
    expect(response.status).toBe(403);
    expect(expired(response)).toContain(SESSION_COOKIE);
  });
});
