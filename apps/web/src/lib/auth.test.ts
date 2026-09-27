import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadWebIdentityConfig,
  MAX_WEB_COOKIE_VALUE_BYTES,
  makePkceTransaction,
  openContextHint,
  openOidcTransaction,
  openWebSession,
  sealContextHint,
  sealOidcTransaction,
  sealWebSession,
  validateContextSelection,
} from './auth.js';

const SESSION_SECRET = Buffer.alloc(32, 7).toString('base64');

describe('web OIDC boundary', () => {
  it('requires complete dogfood identity configuration and a 256-bit session key', () => {
    expect(() =>
      loadWebIdentityConfig({
        KF_DEPLOYMENT_PROFILE: 'dogfood',
        KF_WEB_OIDC_ISSUER: 'https://id.example.test/realms/kf',
      }),
    ).toThrow(/KF_WEB_OIDC_CLIENT_ID/);

    expect(() =>
      loadWebIdentityConfig({
        KF_DEPLOYMENT_PROFILE: 'dogfood',
        KF_WEB_OIDC_ISSUER: 'https://id.example.test/realms/kf',
        KF_WEB_OIDC_CLIENT_ID: 'knowledge-fabric-web',
        KF_WEB_OIDC_REDIRECT_URI: 'https://kf.example.test/auth/callback',
        KF_WEB_SESSION_SECRET: Buffer.alloc(31).toString('base64'),
      }),
    ).toThrow(/32 bytes/);

    expect(
      loadWebIdentityConfig({
        KF_DEPLOYMENT_PROFILE: 'dogfood',
        KF_WEB_OIDC_ISSUER: 'https://id.example.test/realms/kf/',
        KF_WEB_OIDC_CLIENT_ID: 'knowledge-fabric-web',
        KF_WEB_OIDC_REDIRECT_URI: 'https://kf.example.test/auth/callback',
        KF_WEB_SESSION_SECRET: SESSION_SECRET,
      }),
    ).toMatchObject({
      profile: 'dogfood',
      issuer: 'https://id.example.test/realms/kf',
      clientId: 'knowledge-fabric-web',
      redirectUri: 'https://kf.example.test/auth/callback',
    });
  });

  it('permits cleartext OIDC only when every endpoint is loopback dogfood', () => {
    expect(() =>
      loadWebIdentityConfig({
        KF_DEPLOYMENT_PROFILE: 'dogfood',
        KF_WEB_OIDC_ISSUER: 'http://id.example.test/realms/kf',
        KF_WEB_OIDC_CLIENT_ID: 'knowledge-fabric-web',
        KF_WEB_OIDC_REDIRECT_URI: 'http://localhost:3000/auth/callback',
        KF_WEB_SESSION_SECRET: SESSION_SECRET,
      }),
    ).toThrow(/HTTPS/);

    expect(
      loadWebIdentityConfig({
        KF_DEPLOYMENT_PROFILE: 'dogfood',
        KF_WEB_OIDC_ISSUER: 'http://127.0.0.1:18080/realms/kf',
        KF_WEB_OIDC_CLIENT_ID: 'knowledge-fabric-web',
        KF_WEB_OIDC_REDIRECT_URI: 'http://localhost:3000/auth/callback',
        KF_WEB_SESSION_SECRET: SESSION_SECRET,
      }),
    ).toMatchObject({ profile: 'dogfood' });
  });

  it('requires a secret file instead of an inline production key', () => {
    const base = {
      NODE_ENV: 'production',
      KF_DEPLOYMENT_PROFILE: 'dogfood',
      KF_WEB_OIDC_ISSUER: 'https://id.example.test/realms/kf',
      KF_WEB_OIDC_CLIENT_ID: 'knowledge-fabric-web',
      KF_WEB_OIDC_REDIRECT_URI: 'https://kf.example.test/auth/callback',
    } as const;
    expect(() => loadWebIdentityConfig({ ...base, KF_WEB_SESSION_SECRET: SESSION_SECRET })).toThrow(
      /refused in production/,
    );

    const directory = mkdtempSync(join(tmpdir(), 'kf-web-auth-'));
    const secretPath = join(directory, 'session-secret');
    try {
      writeFileSync(secretPath, `${SESSION_SECRET}\n`, { mode: 0o600 });
      expect(
        loadWebIdentityConfig({ ...base, KF_WEB_SESSION_SECRET_FILE: secretPath }),
      ).toMatchObject({ profile: 'dogfood' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('creates an S256 PKCE transaction and preserves only a safe local return path', () => {
    const transaction = makePkceTransaction('https://attacker.test/steal');
    expect(transaction.returnTo).toBe('/documents');
    expect(transaction.verifier.length).toBeGreaterThanOrEqual(43);
    expect(transaction.challenge).toBe(
      createHash('sha256').update(transaction.verifier).digest('base64url'),
    );
    expect(transaction.state).not.toBe(transaction.nonce);

    expect(makePkceTransaction('/documents/doc-1?tab=metrics').returnTo).toBe(
      '/documents/doc-1?tab=metrics',
    );
  });

  it.each([
    '/.//evil.com',
    '/a/..//evil.com',
    '/%2e//evil.com',
    '/./\\evil.com',
    '/.//evil.com/x?y',
  ])('refuses a return path that normalises into another host (%s)', (candidate) => {
    // Each passes a check on the raw input and collapses to `//evil.com` once normalised.
    const returned = makePkceTransaction(candidate).returnTo;
    expect(returned).toBe('/documents');
  });

  it.each(['/documents/doc-1?tab=metrics', '/search?q=a:b', '/a/../documents', '/.//evil.com'])(
    'returns a fixed point: sanitising the result again changes nothing (%s)',
    (candidate) => {
      const once = makePkceTransaction(candidate).returnTo;
      expect(once.startsWith('//')).toBe(false);
      expect(makePkceTransaction(once).returnTo).toBe(once);
    },
  );

  it('round-trips encrypted transaction and session cookies and rejects tampering', async () => {
    const config = loadWebIdentityConfig({
      KF_DEPLOYMENT_PROFILE: 'dogfood',
      KF_WEB_OIDC_ISSUER: 'https://id.example.test/realms/kf',
      KF_WEB_OIDC_CLIENT_ID: 'knowledge-fabric-web',
      KF_WEB_OIDC_REDIRECT_URI: 'https://kf.example.test/auth/callback',
      KF_WEB_SESSION_SECRET: SESSION_SECRET,
    });
    if (config.profile !== 'dogfood') throw new Error('wrong fixture profile');

    const transaction = makePkceTransaction('/documents');
    const transactionCookie = await sealOidcTransaction(transaction, config.sessionKey);
    await expect(openOidcTransaction(transactionCookie, config.sessionKey)).resolves.toEqual(
      transaction,
    );

    const session = {
      version: 1 as const,
      accessToken: 'access-token',
      subject: 'keycloak-subject',
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      context: {
        actingRoleId: '01900000-0000-7000-8000-000000000001',
        organizationId: '01900000-0000-7000-8000-000000000002',
        maxClassification: 'internal' as const,
      },
    };
    const sessionCookie = await sealWebSession(session, config.sessionKey);
    expect(Buffer.byteLength(sessionCookie)).toBeLessThanOrEqual(MAX_WEB_COOKIE_VALUE_BYTES);
    await expect(openWebSession(sessionCookie, config.sessionKey)).resolves.toEqual(session);
    const middle = Math.floor(sessionCookie.length / 2);
    const replacement = sessionCookie[middle] === 'x' ? 'y' : 'x';
    await expect(
      openWebSession(
        `${sessionCookie.slice(0, middle)}${replacement}${sessionCookie.slice(middle + 1)}`,
        config.sessionKey,
      ),
    ).resolves.toBeUndefined();
    await expect(
      openWebSession('x'.repeat(MAX_WEB_COOKIE_VALUE_BYTES + 1), config.sessionKey),
    ).resolves.toBeUndefined();
    await expect(
      sealWebSession(
        {
          version: 1,
          subject: session.subject,
          expiresAt: session.expiresAt,
          accessToken: 'x'.repeat(4_000),
        },
        config.sessionKey,
      ),
    ).rejects.toThrow(/cookie budget/);
  });

  it('accepts a UUID role assignment of any RFC 4122 version, a UUIDv7 organization and known classifications', () => {
    expect(
      validateContextSelection({
        actingRoleId: '01900000-0000-7000-8000-000000000001',
        organizationId: '01900000-0000-7000-8000-000000000002',
        maxClassification: 'confidential',
      }),
    ).toEqual({
      actingRoleId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      maxClassification: 'confidential',
    });

    // A founding assignment minted before identifiers were time-ordered is version 4, and is
    // an immutable record: its holder must still be able to choose it.
    expect(
      validateContextSelection({
        actingRoleId: 'f03a6a9e-a2e4-4c23-94d9-d8db1d08f0d8',
        organizationId: '01900000-0000-7000-8000-000000000002',
        maxClassification: 'restricted',
      }).actingRoleId,
    ).toBe('f03a6a9e-a2e4-4c23-94d9-d8db1d08f0d8');

    for (const actingRoleId of [
      '01900000-0000-0000-8000-000000000001',
      '01900000-0000-9000-8000-000000000001',
      '01900000-0000-4000-c000-000000000001',
      '01900000000070008000000000000001',
      'not-a-uuid',
      42,
    ]) {
      expect(() =>
        validateContextSelection({
          actingRoleId,
          organizationId: '01900000-0000-7000-8000-000000000002',
          maxClassification: 'internal',
        }),
      ).toThrow(/acting role/);
    }
    expect(() =>
      validateContextSelection({
        actingRoleId: '01900000-0000-7000-8000-000000000001',
        organizationId: 'f03a6a9e-a2e4-4c23-94d9-d8db1d08f0d8',
        maxClassification: 'internal',
      }),
    ).toThrow(/organization/);
    expect(() =>
      validateContextSelection({
        actingRoleId: '01900000-0000-7000-8000-000000000001',
        organizationId: '01900000-0000-7000-8000-000000000002',
        maxClassification: 'top-secret',
      }),
    ).toThrow(/classification/);
  });

  it('takes an optional deployment organization, refusing one that could never be chosen', () => {
    const base = {
      KF_DEPLOYMENT_PROFILE: 'dogfood',
      KF_WEB_OIDC_ISSUER: 'https://id.example.test/realms/kf',
      KF_WEB_OIDC_CLIENT_ID: 'knowledge-fabric-web',
      KF_WEB_OIDC_REDIRECT_URI: 'https://kf.example.test/auth/callback',
      KF_WEB_SESSION_SECRET: SESSION_SECRET,
    } as const;
    expect(loadWebIdentityConfig(base)).not.toHaveProperty('organizationId');
    expect(loadWebIdentityConfig({ ...base, KF_WEB_ORGANIZATION: '  ' })).not.toHaveProperty(
      'organizationId',
    );
    expect(
      loadWebIdentityConfig({
        ...base,
        KF_WEB_ORGANIZATION: '01A0D661-0AAE-71E9-954F-FB10FB1222DB',
      }),
    ).toMatchObject({ organizationId: '01a0d661-0aae-71e9-954f-fb10fb1222db' });
    expect(() =>
      loadWebIdentityConfig({
        ...base,
        KF_WEB_ORGANIZATION: 'f03a6a9e-a2e4-4c23-94d9-d8db1d08f0d8',
      }),
    ).toThrow(/KF_WEB_ORGANIZATION/);
    expect(() => loadWebIdentityConfig({ ...base, KF_WEB_ORGANIZATION: 'veracier' })).toThrow(
      /KF_WEB_ORGANIZATION/,
    );
  });
});

describe('context hint cookie', () => {
  const key = Buffer.alloc(32, 7);
  const context = {
    actingRoleId: 'f03a6a9e-a2e4-4c23-94d9-d8db1d08f0d8',
    organizationId: '01900000-0000-7000-8000-000000000002',
    maxClassification: 'restricted' as const,
  };
  const inTwelveHours = () => Math.floor(Date.now() / 1000) + 12 * 60 * 60;

  it('round-trips the chosen context for the subject that chose it, and carries no token', async () => {
    const compact = await sealContextHint(
      { subject: 'subject-a', ...context },
      inTwelveHours(),
      key,
    );
    expect(Buffer.byteLength(compact)).toBeLessThanOrEqual(MAX_WEB_COOKIE_VALUE_BYTES);
    await expect(openContextHint(compact, key, 'subject-a')).resolves.toEqual(context);
    // Sealed, not merely signed: nothing of the context is readable from the cookie.
    expect(compact).not.toContain(context.actingRoleId);
    expect(Buffer.from(compact.split('.')[3] ?? '', 'base64url').toString('latin1')).not.toContain(
      context.organizationId,
    );
  });

  it('refuses the hint to any other subject', async () => {
    const compact = await sealContextHint(
      { subject: 'subject-a', ...context },
      inTwelveHours(),
      key,
    );
    await expect(openContextHint(compact, key, 'subject-b')).resolves.toBeUndefined();
    await expect(openContextHint(compact, key, '')).resolves.toBeUndefined();
  });

  it('refuses a tampered, expired, foreign-key or other-kind cookie', async () => {
    const compact = await sealContextHint(
      { subject: 'subject-a', ...context },
      inTwelveHours(),
      key,
    );
    const middle = Math.floor(compact.length / 2);
    const tampered = `${compact.slice(0, middle)}${compact[middle] === 'x' ? 'y' : 'x'}${compact.slice(middle + 1)}`;
    await expect(openContextHint(tampered, key, 'subject-a')).resolves.toBeUndefined();
    await expect(
      openContextHint(compact, Buffer.alloc(32, 8), 'subject-a'),
    ).resolves.toBeUndefined();
    const expired = await sealContextHint(
      { subject: 'subject-a', ...context },
      Math.floor(Date.now() / 1000) - 60,
      key,
    );
    await expect(openContextHint(expired, key, 'subject-a')).resolves.toBeUndefined();
    // A session cookie is not a hint, even for the same subject and key.
    const session = await sealWebSession(
      {
        version: 1,
        accessToken: 'access-token',
        subject: 'subject-a',
        expiresAt: inTwelveHours(),
        context,
      },
      key,
    );
    await expect(openContextHint(session, key, 'subject-a')).resolves.toBeUndefined();
    await expect(openContextHint(undefined, key, 'subject-a')).resolves.toBeUndefined();
  });

  it('refuses to seal a hint without a subject or with a malformed context', async () => {
    await expect(
      sealContextHint({ subject: '', ...context }, inTwelveHours(), key),
    ).rejects.toThrow(/subject/);
    await expect(
      sealContextHint(
        { subject: 'subject-a', ...context, actingRoleId: 'role-1' },
        inTwelveHours(),
        key,
      ),
    ).rejects.toThrow(/acting role/);
  });
});
