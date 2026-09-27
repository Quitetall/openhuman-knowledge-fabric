import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from './csp';

function directives(policy: string): Map<string, string> {
  return new Map(
    policy.split(';').map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name ?? '', values.join(' ')];
    }),
  );
}

describe('contentSecurityPolicy', () => {
  const production = directives(
    contentSecurityPolicy('abc123', {
      NODE_ENV: 'production',
      KF_WEB_OIDC_ISSUER: 'https://identity.example.internal/realms/knowledge-fabric',
      KF_WEB_OIDC_REDIRECT_URI: 'https://fabric.example.internal/auth/callback',
    }),
  );

  it('runs only nonced script and refuses to be framed', () => {
    expect(production.get('script-src')).toBe("'self' 'nonce-abc123' 'strict-dynamic'");
    expect(production.get('frame-ancestors')).toBe("'none'");
    expect(production.get('object-src')).toBe("'none'");
    expect(production.get('base-uri')).toBe("'self'");
  });

  it('never allows eval or inline script in production', () => {
    for (const value of production.values()) {
      expect(value).not.toContain('unsafe-eval');
    }
    expect(production.get('script-src')).not.toContain('unsafe-inline');
    expect(production.get('style-src')).not.toContain('unsafe-inline');
  });

  it('lets sign-out reach the identity provider it redirects to', () => {
    expect(production.get('form-action')).toBe("'self' https://identity.example.internal");
  });

  it('upgrades insecure requests only where the public origin is https', () => {
    expect(production.has('upgrade-insecure-requests')).toBe(true);
    const plain = directives(
      contentSecurityPolicy('n', {
        NODE_ENV: 'production',
        KF_WEB_OIDC_REDIRECT_URI: 'http://127.0.0.1:3000/auth/callback',
      }),
    );
    expect(plain.has('upgrade-insecure-requests')).toBe(false);
  });
});
