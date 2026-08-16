/**
 * Where the external Secure Object Authority erasure signer lives, if anywhere.
 *
 * Absent by default, and absent is a working state: `recordErasure` fails closed with
 * `signing_key_unavailable` when no signer is configured, which is the correct posture for a
 * deployment that has not qualified an authority. Configuration is what turns that off, so it
 * is validated here rather than at the first erasure somebody attempts.
 *
 * The endpoint carries a tombstone that names an organization and a key; the response carries
 * a signature this system will record permanently. That makes the transport worth being strict
 * about — cleartext is refused outside a loopback sidecar, and a URL that smuggles credentials
 * is refused everywhere.
 */

import {
  DEFAULT_AUTHORITY_SIGNER_TIMEOUT_MS,
  MAX_AUTHORITY_SIGNER_TIMEOUT_MS,
} from '@kf/integration';

export class SecureObjectSignerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecureObjectSignerConfigError';
  }
}

export interface SecureObjectSignerConfig {
  readonly endpoint: URL;
  readonly timeoutMs: number;
}

const URL_VARIABLE = 'KF_SECURE_OBJECT_ERASURE_SIGNER_URL';
const TIMEOUT_VARIABLE = 'KF_SECURE_OBJECT_ERASURE_SIGNER_TIMEOUT_MS';

/** Matches `apps/api/src/config.ts`; a signer is configured per environment, not per profile. */
export type SecureObjectSignerEnvironment = 'development' | 'test' | 'staging' | 'production';

/**
 * Loopback only, and only by literal address.
 *
 * `localhost` is deliberately NOT loopback here. It resolves through the host's name
 * resolution, which a compromised or merely misconfigured `/etc/hosts` or DNS search path can
 * point anywhere — so accepting it would let "cleartext is safe, it never leaves the machine"
 * be false while still reading as true.
 */
function isLoopback(hostname: string): boolean {
  if (hostname === '[::1]' || hostname === '::1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  // The whole 127.0.0.0/8 block, not just 127.0.0.1 — a sidecar on 127.0.0.2 is as local.
  return v4 !== null && v4[1] === '127' && v4.slice(1).every((o) => Number(o) <= 255);
}

function parseEndpoint(raw: string, environment: SecureObjectSignerEnvironment): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    // The value is not echoed: an operator who pasted a credential-bearing URL should not have
    // it copied into a startup log by the error that rejected it.
    throw new SecureObjectSignerConfigError(`${URL_VARIABLE} is not a valid absolute URL`);
  }

  if (endpoint.username !== '' || endpoint.password !== '') {
    throw new SecureObjectSignerConfigError(
      `${URL_VARIABLE} must not carry credentials in the URL. Userinfo is logged by proxies ` +
        'and shows up in process listings; supply authority credentials out of band.',
    );
  }
  if (endpoint.search !== '' || endpoint.hash !== '') {
    // A query string or fragment on a signing endpoint is either a smuggled secret or a
    // caller-supplied parameter this client does not control. Neither should be silently kept.
    throw new SecureObjectSignerConfigError(
      `${URL_VARIABLE} must be a bare endpoint with no query string or fragment`,
    );
  }

  const cleartextAllowed = environment === 'development' || environment === 'test';
  if (endpoint.protocol !== 'https:') {
    if (!(cleartextAllowed && endpoint.protocol === 'http:' && isLoopback(endpoint.hostname))) {
      throw new SecureObjectSignerConfigError(
        `${URL_VARIABLE} must use HTTPS or a loopback address in development and test. A ` +
          'tombstone names an organization and a key, and the reply is a signature this ' +
          'system records permanently.',
      );
    }
  }
  return endpoint;
}

function parseTimeout(raw: string): number {
  const timeoutMs = Number(raw);
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_AUTHORITY_SIGNER_TIMEOUT_MS
  ) {
    // The bound comes from the integration package rather than a literal, so the two cannot
    // drift into disagreeing about what this system will wait for.
    throw new SecureObjectSignerConfigError(
      `${TIMEOUT_VARIABLE} must be an integer in 1..${MAX_AUTHORITY_SIGNER_TIMEOUT_MS} milliseconds`,
    );
  }
  return timeoutMs;
}

/**
 * Resolve the signer configuration, or `undefined` when none is configured.
 *
 * A timeout with no endpoint is an error rather than a harmless leftover: it means somebody
 * intended to configure a signer and the deployment is running without one, which is exactly
 * the case where silence produces a fail-closed erasure path nobody expected.
 */
export function loadSecureObjectSignerConfig(
  env: NodeJS.ProcessEnv,
  environment: SecureObjectSignerEnvironment,
): SecureObjectSignerConfig | undefined {
  const rawUrl = env[URL_VARIABLE];
  const rawTimeout = env[TIMEOUT_VARIABLE];

  if (rawUrl === undefined || rawUrl === '') {
    if (rawTimeout !== undefined && rawTimeout !== '') {
      throw new SecureObjectSignerConfigError(
        `${TIMEOUT_VARIABLE} requires ${URL_VARIABLE}; a timeout alone configures nothing and ` +
          'leaves erasure recording fail-closed.',
      );
    }
    return undefined;
  }

  return {
    endpoint: parseEndpoint(rawUrl, environment),
    timeoutMs:
      rawTimeout === undefined || rawTimeout === ''
        ? DEFAULT_AUTHORITY_SIGNER_TIMEOUT_MS
        : parseTimeout(rawTimeout),
  };
}
