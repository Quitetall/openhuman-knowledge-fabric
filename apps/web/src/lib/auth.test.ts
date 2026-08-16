import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadWebIdentityConfig,
  MAX_WEB_COOKIE_VALUE_BYTES,
  makePkceTransaction,
  openOidcTransaction,
  openWebSession,
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

  it('accepts only explicit UUIDv7 organization and role context plus known classifications', () => {
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

    expect(() =>
      validateContextSelection({
        actingRoleId: '01900000-0000-4000-8000-000000000001',
        organizationId: '01900000-0000-7000-8000-000000000002',
        maxClassification: 'restricted',
      }),
    ).toThrow(/acting role/);
    expect(() =>
      validateContextSelection({
        actingRoleId: '01900000-0000-7000-8000-000000000001',
        organizationId: '01900000-0000-7000-8000-000000000002',
        maxClassification: 'top-secret',
      }),
    ).toThrow(/classification/);
  });
});
