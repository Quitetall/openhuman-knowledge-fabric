import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { publicOrigin, publicUrl } from './origin';

const DOGFOOD = {
  KF_DEPLOYMENT_PROFILE: 'dogfood',
  KF_WEB_OIDC_ISSUER: 'https://id.internal/realms/kf',
  KF_WEB_OIDC_CLIENT_ID: 'kf-web',
  KF_WEB_OIDC_REDIRECT_URI: 'https://kf.internal/auth/callback',
  KF_WEB_SESSION_SECRET: 'x'.repeat(64),
} as const;

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

/** What Next.js hands a route behind nginx: the private address the app itself was reached on. */
const behindProxy = { url: 'https://localhost:3000/auth/callback?code=abc' };

describe('the public origin comes from configuration, not from the request', () => {
  it('uses the registered redirect URI in the dogfood profile', () => {
    Object.assign(process.env, DOGFOOD);
    expect(publicOrigin(behindProxy)).toBe('https://kf.internal');
    expect(publicUrl(behindProxy, '/documents').toString()).toBe('https://kf.internal/documents');
  });

  it('does not let the request widen or move the origin', () => {
    Object.assign(process.env, DOGFOOD);
    const forged = { url: 'https://attacker.example/auth/callback' };
    expect(publicOrigin(forged)).toBe('https://kf.internal');
  });

  it('falls back to the request in development, where there is no proxy and no configuration', () => {
    process.env = { ...saved, KF_DEPLOYMENT_PROFILE: 'development' };
    expect(publicOrigin({ url: 'http://localhost:3000/documents' })).toBe('http://localhost:3000');
  });

  it('still redirects when no profile is set, rather than throwing at the caller', () => {
    process.env = { ...saved };
    delete process.env['KF_DEPLOYMENT_PROFILE'];
    expect(publicUrl(behindProxy, '/auth/error?code=x').toString()).toBe(
      'https://localhost:3000/auth/error?code=x',
    );
  });

  it('does not depend on the session secret, so a missing one cannot move the origin', () => {
    Object.assign(process.env, DOGFOOD);
    delete process.env['KF_WEB_SESSION_SECRET'];
    delete process.env['KF_WEB_SESSION_SECRET_FILE'];
    expect(publicOrigin(behindProxy)).toBe('https://kf.internal');
  });

  it('refuses rather than guessing when dogfood names no redirect URI', () => {
    Object.assign(process.env, DOGFOOD);
    delete process.env['KF_WEB_OIDC_REDIRECT_URI'];
    expect(() => publicOrigin(behindProxy)).toThrow(/KF_WEB_OIDC_REDIRECT_URI/);
  });
});

function routeFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...routeFiles(path));
    else if (entry.name === 'route.ts') found.push(path);
  }
  return found;
}

describe('no route rebuilds the defect', () => {
  /**
   * The bug was not one wrong line; it was ten, written the same way, because
   * `new URL(path, request.url)` is the obvious thing to write and is wrong behind a proxy.
   * A fix that only corrects today's ten is a fix that gets undone by the next route.
   */
  it('builds no URL from the request address', () => {
    const offenders = routeFiles(join(process.cwd(), 'apps/web/src/app'))
      .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
      .filter(({ source }) => /new URL\([^)]*\brequest\.url\b/.test(source))
      .map(({ file }) => file.slice(process.cwd().length + 1));
    expect(
      offenders,
      'these routes derive a URL from the address the application was reached on. Behind a ' +
        'reverse proxy that is the private interface, so the caller is redirected to an origin ' +
        'that is not theirs. Use publicUrl(request, path).',
    ).toEqual([]);
  });
});
