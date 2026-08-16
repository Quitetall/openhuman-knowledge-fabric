/**
 * Process configuration, resolved once at startup.
 *
 * Configuration is read here and nowhere else, so that a missing or malformed setting fails
 * at boot with a precise message rather than at the first request that happens to need it.
 */

import { loadSecret } from '@kf/operations';
import type { S3Config } from '@kf/artifacts';

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly databaseUrl: string | undefined;
  readonly environment: 'development' | 'test' | 'staging' | 'production';
  /**
   * What kind of records this process may serve.
   *
   * `development` is a visibly non-authoritative, fixed-identity workspace. `dogfood` may
   * be shared and therefore requires verified bearer identity even when Node itself runs in
   * development mode.
   */
  readonly deploymentProfile: 'development' | 'dogfood';
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
  /** Evidence vault. Absent only in tests or intentionally metadata-only development. */
  readonly artifactStore?: S3Config;
}

class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    // `cause` is carried so that an error re-thrown from another layer keeps the stack that
    // says where it actually came from. Without it the trace points at the catch block, which
    // is the least useful line in the file.
    super(message, options);
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

function readDeploymentProfile(raw: string | undefined): ApiConfig['deploymentProfile'] {
  if (raw === undefined || raw === '') {
    throw new ConfigError(
      'KF_DEPLOYMENT_PROFILE is required; set it explicitly to development or dogfood',
    );
  }
  if (raw === 'development' || raw === 'dogfood') return raw;
  throw new ConfigError(
    `KF_DEPLOYMENT_PROFILE must be development or dogfood, got ${JSON.stringify(raw)}`,
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const environment = readEnvironment(env['NODE_ENV']);
  const deploymentProfile = readDeploymentProfile(env['KF_DEPLOYMENT_PROFILE']);
  const host = env['HOST'] ?? (deploymentProfile === 'dogfood' ? '127.0.0.1' : '0.0.0.0');

  // The development profile is the only place header-supplied identity can exist. Naming it
  // in a deployed Node environment would make a non-authoritative mode look deployable, so
  // reject that contradiction before considering any credentials.
  if (
    deploymentProfile === 'development' &&
    environment !== 'development' &&
    environment !== 'test'
  ) {
    throw new ConfigError(
      'The development profile is allowed only when NODE_ENV=development or test; use ' +
        'KF_DEPLOYMENT_PROFILE=dogfood with verified bearer identity for a shared deployment.',
    );
  }

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
  if (
    deploymentProfile === 'dogfood' &&
    !tlsTerminatedUpstream &&
    host !== '127.0.0.1' &&
    host !== '::1' &&
    host !== 'localhost'
  ) {
    throw new ConfigError(
      'cleartext dogfood is permitted only on a loopback listener; set HOST=127.0.0.1 or ' +
        'terminate TLS upstream and set KF_TLS_TERMINATED_UPSTREAM=1',
    );
  }

  // A connection string is a credential. Outside development it must arrive as a file:
  // DATABASE_URL in the environment is readable from /proc/<pid>/environ by anything running
  // as the same user, is inherited by every child process, and is printed by crash reporters.
  const inlineAllowed = environment === 'development' || environment === 'test';
  let databaseUrl: string | undefined;
  try {
    databaseUrl =
      env['DATABASE_URL_FILE'] !== undefined || env['DATABASE_URL'] !== undefined
        ? loadSecret('DATABASE_URL', env, { allowInline: inlineAllowed })
        : undefined;
  } catch (err: unknown) {
    // Re-thrown as ConfigError so that "loadConfig throws ConfigError" stays true. The message
    // is kept verbatim — it is the one that says which file and why.
    throw new ConfigError(err instanceof Error ? err.message : String(err), { cause: err });
  }

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

  // Dogfood is allowed to run with NODE_ENV=development on a workstation, but it may be
  // shared and its records still need an authenticated actor. NODE_ENV therefore cannot be
  // the identity boundary: the explicit deployment profile is.
  if (deploymentProfile === 'dogfood' && identity === undefined) {
    throw new ConfigError(
      'An identity provider is required when KF_DEPLOYMENT_PROFILE=dogfood. Set ' +
        'OIDC_ISSUER, OIDC_AUDIENCE and OIDC_JWKS_URI.',
    );
  }

  const s3Endpoint = env['S3_ENDPOINT'];
  const s3Region = env['S3_REGION'];
  const s3AccessKeyId = env['S3_ACCESS_KEY_ID'];
  const s3Bucket = env['S3_BUCKET_ARTIFACTS'];
  const s3Parts = [s3Endpoint, s3Region, s3AccessKeyId, s3Bucket].filter(
    (value) => value !== undefined && value !== '',
  );
  const secretConfigured =
    (env['S3_SECRET_ACCESS_KEY'] !== undefined && env['S3_SECRET_ACCESS_KEY'] !== '') ||
    (env['S3_SECRET_ACCESS_KEY_FILE'] !== undefined && env['S3_SECRET_ACCESS_KEY_FILE'] !== '');
  if ((s3Parts.length > 0 || secretConfigured) && (s3Parts.length !== 4 || !secretConfigured)) {
    throw new ConfigError(
      'S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_BUCKET_ARTIFACTS and ' +
        'S3_SECRET_ACCESS_KEY[_FILE] must all be set, or none of them.',
    );
  }
  let artifactStore: S3Config | undefined;
  if (s3Parts.length === 4 && secretConfigured) {
    try {
      artifactStore = {
        endpoint: s3Endpoint!,
        region: s3Region!,
        accessKeyId: s3AccessKeyId!,
        secretAccessKey: loadSecret('S3_SECRET_ACCESS_KEY', env, { allowInline: inlineAllowed }),
        bucket: s3Bucket!,
        forcePathStyle: env['S3_FORCE_PATH_STYLE'] !== 'false',
      };
    } catch (error: unknown) {
      throw new ConfigError(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
    }
  }

  return {
    host,
    port: readPort(env['PORT'], 4000),
    logLevel: env['LOG_LEVEL'] ?? (environment === 'production' ? 'info' : 'debug'),
    databaseUrl,
    environment,
    deploymentProfile,
    tlsTerminatedUpstream,
    identity,
    ...(artifactStore === undefined ? {} : { artifactStore }),
  };
}

export { ConfigError };
