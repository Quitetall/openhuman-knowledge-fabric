import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from 'jose';
import type { DogfoodIdentityConfig, OidcTransaction, WebSession } from './auth';

export interface OidcMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly endSessionEndpoint?: string;
}

function endpoint(raw: unknown, name: string): string {
  if (typeof raw !== 'string' || raw === '') throw new Error(`OIDC ${name} is missing`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`OIDC ${name} is not an absolute URL`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`OIDC ${name} must not contain credentials`);
  }
  const loopback =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error(`OIDC ${name} must use HTTPS unless it is loopback`);
  }
  return url.toString();
}

async function json(
  url: string,
  init: RequestInit,
  fetcher: typeof fetch,
): Promise<Record<string, unknown>> {
  const response = await fetcher(url, init);
  const body = await response.text();
  if (body.length > 128 * 1024) throw new Error('OIDC response exceeded 128 KiB');
  if (!response.ok) throw new Error(`OIDC endpoint refused request with HTTP ${response.status}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('OIDC endpoint returned invalid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('OIDC endpoint returned a non-object response');
  }
  return parsed as Record<string, unknown>;
}

export async function discoverOidc(
  config: DogfoodIdentityConfig,
  fetcher: typeof fetch = fetch,
): Promise<OidcMetadata> {
  const discoveryUrl = `${config.issuer}/.well-known/openid-configuration`;
  const data = await json(
    discoveryUrl,
    {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    },
    fetcher,
  );
  if (data['issuer'] !== config.issuer) throw new Error('OIDC discovery issuer does not match');
  const logout = data['end_session_endpoint'];
  return {
    issuer: config.issuer,
    authorizationEndpoint: endpoint(data['authorization_endpoint'], 'authorization endpoint'),
    tokenEndpoint: endpoint(data['token_endpoint'], 'token endpoint'),
    jwksUri: endpoint(data['jwks_uri'], 'JWKS URI'),
    ...(typeof logout === 'string' && logout !== ''
      ? { endSessionEndpoint: endpoint(logout, 'end session endpoint') }
      : {}),
  };
}

export function authorizationUrl(
  metadata: OidcMetadata,
  config: DogfoodIdentityConfig,
  transaction: OidcTransaction,
): URL {
  const url = new URL(metadata.authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: 'openid profile',
    state: transaction.state,
    nonce: transaction.nonce,
    code_challenge: transaction.challenge,
    code_challenge_method: 'S256',
  }).toString();
  return url;
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface ExchangeOptions {
  readonly fetcher?: typeof fetch;
  readonly keys?: JWTVerifyGetKey;
  readonly nowSeconds?: number;
}

function validatedSubject(payload: JWTPayload, nonce: string): string {
  if (typeof payload.nonce !== 'string' || !sameSecret(payload.nonce, nonce)) {
    throw new Error('OIDC ID token nonce does not match authorization transaction');
  }
  if (typeof payload.sub !== 'string' || payload.sub === '' || payload.sub.length > 512) {
    throw new Error('OIDC ID token has no usable subject');
  }
  return payload.sub;
}

export async function exchangeAuthorizationCode(
  metadata: OidcMetadata,
  config: DogfoodIdentityConfig,
  transaction: OidcTransaction,
  code: string,
  options: ExchangeOptions = {},
): Promise<WebSession> {
  if (code === '' || code.length > 4096) throw new Error('OIDC authorization code is invalid');
  const fetcher = options.fetcher ?? fetch;
  const token = await json(
    metadata.tokenEndpoint,
    {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        code,
        code_verifier: transaction.verifier,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    },
    fetcher,
  );
  const accessToken = token['access_token'];
  const idToken = token['id_token'];
  const expiresIn = token['expires_in'];
  if (typeof accessToken !== 'string' || accessToken === '' || accessToken.length > 12_000) {
    throw new Error('OIDC token response has no usable access token');
  }
  if (typeof idToken !== 'string' || idToken === '' || idToken.length > 12_000) {
    throw new Error('OIDC token response has no usable ID token');
  }
  if (!Number.isInteger(expiresIn) || (expiresIn as number) < 1) {
    throw new Error('OIDC token response has no usable access-token expiry');
  }

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const keys = options.keys ?? createRemoteJWKSet(new URL(metadata.jwksUri));
  const verified = await jwtVerify(idToken, keys, {
    issuer: config.issuer,
    audience: config.clientId,
    currentDate: new Date(nowSeconds * 1000),
    clockTolerance: 30,
  });
  const subject = validatedSubject(verified.payload, transaction.nonce);
  // No refresh token is retained. Dogfood session cannot outlive access token and is capped at
  // eight hours even if a provider is misconfigured with an unexpectedly long lifetime.
  const lifetime = Math.min(expiresIn as number, 8 * 60 * 60);
  return {
    version: 1,
    accessToken,
    subject,
    expiresAt: nowSeconds + lifetime,
  };
}

export function logoutUrl(
  metadata: OidcMetadata,
  config: DogfoodIdentityConfig,
  destination: string,
): URL | undefined {
  if (metadata.endSessionEndpoint === undefined) return undefined;
  const url = new URL(metadata.endSessionEndpoint);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    post_logout_redirect_uri: destination,
  }).toString();
  return url;
}
