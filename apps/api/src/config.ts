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

  return {
    host: env['HOST'] ?? '0.0.0.0',
    port: readPort(env['PORT'], 4000),
    logLevel: env['LOG_LEVEL'] ?? (environment === 'production' ? 'info' : 'debug'),
    databaseUrl,
    environment,
  };
}

export { ConfigError };
