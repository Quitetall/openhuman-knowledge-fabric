/**
 * Process configuration, resolved once at startup.
 *
 * Configuration is read here and nowhere else, so that a missing or malformed setting fails
 * at boot with a precise message rather than at the first request that happens to need it.
 */

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly databaseUrl: string | undefined;
  readonly environment: 'development' | 'test' | 'staging' | 'production';
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
  const databaseUrl = env['DATABASE_URL'];

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
    identity,
  };
}

export { ConfigError };
