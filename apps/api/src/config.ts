/**
 * Process configuration, resolved once at startup.
 *
 * Configuration is read here and nowhere else, so that a missing or malformed setting fails
 * at boot with a precise message rather than at the first request that happens to need it.
 */

import { loadSecret } from '@kf/operations';

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly databaseUrl: string | undefined;
  readonly environment: 'development' | 'test' | 'staging' | 'production';
  /**
   * Whether a proxy in front of this process terminates TLS.
   *
   * Stated rather than assumed. This process serves HTTP; whether that is safe depends
   * entirely on what is in front of it, and that is a fact about the deployment which the
   * deployment has to assert.
   */
  readonly tlsTerminatedUpstream: boolean;
  /** Present only when an identity provider is configured. Absent means header identity. */
  readonly identity:
    { readonly issuer: string; readonly audience: string; readonly jwksUri: string } | undefined;
}

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readPort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ConfigError(`PORT must be an integer in 1..65535, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function readEnvironment(raw: string | undefined): ApiConfig['environment'] {
  const value = raw ?? 'development';
  if (
    value === 'development' ||
    value === 'test' ||
    value === 'staging' ||
    value === 'production'
  ) {
    return value;
  }
  throw new ConfigError(
    `NODE_ENV must be development, test, staging or production, got ${JSON.stringify(raw)}`,
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const environment = readEnvironment(env['NODE_ENV']);

  // Serving plain HTTP with nothing terminating TLS means bearer tokens cross the network in
  // clear. Refused rather than warned: the warning would be read once.
  const tlsTerminatedUpstream = env['KF_TLS_TERMINATED_UPSTREAM'] === '1';
  if (environment !== 'development' && environment !== 'test' && !tlsTerminatedUpstream) {
    throw new ConfigError(
      `This process serves HTTP. When NODE_ENV=${environment} it must sit behind a proxy that ` +
        'terminates TLS, and the deployment must say so by setting ' +
        'KF_TLS_TERMINATED_UPSTREAM=1. Without TLS every bearer token crosses the network in ' +
        'clear.',
    );
  }

  // A connection string is a credential. Outside development it must arrive as a file:
  // DATABASE_URL in the environment is readable from /proc/<pid>/environ by anything running
  // as the same user, is inherited by every child process, and is printed by crash reporters.
  const inlineAllowed = environment === 'development' || environment === 'test';
  const databaseUrl =
    env['DATABASE_URL_FILE'] !== undefined || env['DATABASE_URL'] !== undefined
      ? loadSecret('DATABASE_URL', env, { allowInline: inlineAllowed })
      : undefined;

  // Outside development a missing database URL means the process would start, pass its
  // liveness probe, and fail every real request. Refuse to boot instead.
  if (environment !== 'development' && environment !== 'test' && !databaseUrl) {
    throw new ConfigError(`DATABASE_URL is required when NODE_ENV=${environment}`);
  }

  // All three or none. A half-configured provider is the shape that silently falls back to
  // trusting headers, which is the failure this whole path exists to prevent.
  const issuer = env['OIDC_ISSUER'];
  const audience = env['OIDC_AUDIENCE'];
  const jwksUri = env['OIDC_JWKS_URI'];
  const identityParts = [issuer, audience, jwksUri].filter((v) => v !== undefined && v !== '');
  if (identityParts.length > 0 && identityParts.length < 3) {
    throw new ConfigError(
      'OIDC_ISSUER, OIDC_AUDIENCE and OIDC_JWKS_URI must all be set, or none of them. ' +
        'A partially configured identity provider falls back to trusting headers.',
    );
  }
  const identity =
    identityParts.length === 3
      ? { issuer: issuer!, audience: audience!, jwksUri: jwksUri! }
      : undefined;

  // Outside development an identity provider is not optional. Without this the process would
  // start, serve, and attribute every action to whoever set a header.
  if (environment !== 'development' && environment !== 'test' && identity === undefined) {
    throw new ConfigError(
      `An identity provider is required when NODE_ENV=${environment}. Set OIDC_ISSUER, ` +
        'OIDC_AUDIENCE and OIDC_JWKS_URI.',
    );
  }

  return {
    host: env['HOST'] ?? '0.0.0.0',
    port: readPort(env['PORT'], 4000),
    logLevel: env['LOG_LEVEL'] ?? (environment === 'production' ? 'info' : 'debug'),
    databaseUrl,
    environment,
    tlsTerminatedUpstream,
    identity,
  };
}

export { ConfigError };
