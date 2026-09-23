/**
 * kf-attestor configuration: an issuer to verify against, a database login that may attest,
 * and the socket the API reaches it on. Nothing optional, nothing defaulted that decides trust.
 */

import { isAbsolute } from 'node:path';
import type { IdentityConfig } from '@kf/authorization';
import { loadSecret } from '@kf/operations';

export class AttestorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttestorConfigError';
  }
}

export interface AttestorConfig {
  readonly identity: IdentityConfig;
  readonly databaseUrl: string;
  /** Absolute path of the Unix socket to listen on. Created 0660, in the process's group. */
  readonly socketPath: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new AttestorConfigError(`${name} is required`);
  }
  return value;
}

/** Keys and issuer over TLS, or loopback in development: a cleartext JWKS lets anyone mint. */
function requireHttpsUnlessLoopback(name: string, raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AttestorConfigError(`${name} must be an absolute URL, got ${JSON.stringify(raw)}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new AttestorConfigError(`${name} must not contain credentials`);
  }
  const loopback =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if (url.protocol !== 'https:' && !loopback) {
    throw new AttestorConfigError(
      `${name} must use https unless it is loopback, got ${url.protocol}//`,
    );
  }
}

export function loadAttestorConfig(env: NodeJS.ProcessEnv = process.env): AttestorConfig {
  const issuer = required(env, 'OIDC_ISSUER');
  const audience = required(env, 'OIDC_AUDIENCE');
  const jwksUri = required(env, 'OIDC_JWKS_URI');
  requireHttpsUnlessLoopback('OIDC_ISSUER', issuer);
  requireHttpsUnlessLoopback('OIDC_JWKS_URI', jwksUri);
  const socketPath = required(env, 'KF_ATTESTOR_SOCKET');
  if (!isAbsolute(socketPath)) {
    throw new AttestorConfigError(`KF_ATTESTOR_SOCKET must be an absolute path, got ${socketPath}`);
  }
  const databaseUrl = loadSecret('DATABASE_URL', env, {
    allowInline: env['NODE_ENV'] !== 'production',
  });
  return { identity: { issuer, audience, jwksUri }, databaseUrl, socketPath };
}
