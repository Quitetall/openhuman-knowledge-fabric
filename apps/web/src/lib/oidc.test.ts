import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { loadWebIdentityConfig, makePkceTransaction } from './auth.js';
import {
  authorizationUrl,
  discoverOidc,
  exchangeAuthorizationCode,
  type OidcMetadata,
} from './oidc.js';

const config = loadWebIdentityConfig({
  KF_DEPLOYMENT_PROFILE: 'dogfood',
  KF_WEB_OIDC_ISSUER: 'https://id.example.test/realms/kf',
  KF_WEB_OIDC_CLIENT_ID: 'knowledge-fabric-web',
  KF_WEB_OIDC_REDIRECT_URI: 'https://kf.example.test/auth/callback',
  KF_WEB_SESSION_SECRET: Buffer.alloc(32, 4).toString('base64'),
});

if (config.profile !== 'dogfood') throw new Error('wrong fixture profile');

const metadata: OidcMetadata = {
  issuer: config.issuer,
  authorizationEndpoint: `${config.issuer}/protocol/openid-connect/auth`,
  tokenEndpoint: `${config.issuer}/protocol/openid-connect/token`,
  jwksUri: `${config.issuer}/protocol/openid-connect/certs`,
  endSessionEndpoint: `${config.issuer}/protocol/openid-connect/logout`,
};

describe('OIDC authorization code client', () => {
  it('accepts exact-issuer discovery and rejects issuer substitution', async () => {
    const response = {
      issuer: config.issuer,
      authorization_endpoint: metadata.authorizationEndpoint,
      token_endpoint: metadata.tokenEndpoint,
      jwks_uri: metadata.jwksUri,
      end_session_endpoint: metadata.endSessionEndpoint,
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
    await expect(discoverOidc(config, fetcher as typeof fetch)).resolves.toEqual(metadata);

    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ ...response, issuer: 'https://attacker.test' }), {
        status: 200,
      }),
    );
    await expect(discoverOidc(config, fetcher as typeof fetch)).rejects.toThrow(/issuer/);
  });

  it('stops reading a provider response at the cap instead of buffering it first', async () => {
    // The cap used to be applied to the result of `await response.text()`, which bounds what
    // is ACCEPTED and not what is buffered: by the time it ran, the whole body was already a
    // string. A hostile or compromised provider could make this process materialise an
    // arbitrarily large response before the limit had any say.
    //
    // So the assertion is not "it rejects a big body" — the old code did that too. It is "it
    // stops pulling", which is the property that actually bounds memory, and the stream
    // counts how many chunks were demanded of it.
    const CHUNK = new Uint8Array(16 * 1024);
    const TOTAL_CHUNKS = 100; // 1.6 MiB, if it read the whole thing
    let pulled = 0;
    const fetcher = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (pulled >= TOTAL_CHUNKS) {
                controller.close();
                return;
              }
              pulled += 1;
              controller.enqueue(CHUNK);
            },
          }),
          { status: 200 },
        ),
    );

    await expect(discoverOidc(config, fetcher as typeof fetch)).rejects.toThrow(/128 KiB/);
    // 128 KiB is eight 16 KiB chunks: it must refuse shortly after crossing that rather than
    // walking the remaining ninety-odd.
    expect(pulled).toBeLessThan(TOTAL_CHUNKS);
    expect(pulled).toBeLessThanOrEqual(12);
  });

  it('builds code plus S256 authorization requests with state and nonce', () => {
    const transaction = makePkceTransaction('/documents/doc-1');
    const url = authorizationUrl(metadata, config, transaction);
    expect(url.origin + url.pathname).toBe(metadata.authorizationEndpoint);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(config.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
    expect(url.searchParams.get('state')).toBe(transaction.state);
    expect(url.searchParams.get('nonce')).toBe(transaction.nonce);
    expect(url.searchParams.get('code_challenge')).toBe(transaction.challenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('exchanges verifier, validates signed ID token nonce, and bounds session expiry', async () => {
    const now = 1_800_000_000;
    const transaction = makePkceTransaction('/documents', now);
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const token = await new SignJWT({ nonce: transaction.nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
      .setIssuer(config.issuer)
      .setAudience(config.clientId)
      .setSubject('person-subject')
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(privateKey);
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('code')).toBe('one-use-code');
      expect(form.get('code_verifier')).toBe(transaction.verifier);
      return new Response(
        JSON.stringify({ access_token: 'api-access', id_token: token, expires_in: 3600 }),
        { status: 200 },
      );
    });
    const keys: JWTVerifyGetKey = async () => publicKey;

    await expect(
      exchangeAuthorizationCode(metadata, config, transaction, 'one-use-code', {
        fetcher: fetcher as typeof fetch,
        keys,
        nowSeconds: now,
      }),
    ).resolves.toEqual({
      version: 1,
      accessToken: 'api-access',
      subject: 'person-subject',
      expiresAt: now + 3600,
    });

    const wrongNonce = { ...transaction, nonce: 'wrong-nonce' };
    await expect(
      exchangeAuthorizationCode(metadata, config, wrongNonce, 'one-use-code', {
        fetcher: fetcher as typeof fetch,
        keys,
        nowSeconds: now,
      }),
    ).rejects.toThrow(/nonce/);
  });
});
