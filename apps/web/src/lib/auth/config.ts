import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { WebIdentityConfig } from './types';

type Environment = Readonly<Record<string, string | undefined>>;

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === '') throw new Error(`${name} is required in dogfood`);
  return value;
}

function normalizedUrl(raw: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`${name} must not contain credentials`);
  }
  if (url.protocol === 'https:') return url;
  const loopback =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if (!loopback) throw new Error(`${name} must use HTTPS unless it is a loopback URL`);
  return url;
}

function sessionKey(raw: string, source: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new Error(`${source} must contain canonical base64`);
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error(`${source} must decode to exactly 32 bytes`);
  if (key.toString('base64') !== raw) {
    throw new Error(`${source} must contain canonical base64`);
  }
  return key;
}

function configuredSessionKey(env: Environment): Uint8Array {
  const inline = env['KF_WEB_SESSION_SECRET']?.trim();
  const file = env['KF_WEB_SESSION_SECRET_FILE']?.trim();
  if (inline !== undefined && inline !== '' && file !== undefined && file !== '') {
    throw new Error('configure exactly one of KF_WEB_SESSION_SECRET or KF_WEB_SESSION_SECRET_FILE');
  }
  if (env['NODE_ENV'] === 'production' && inline !== undefined && inline !== '') {
    throw new Error(
      'KF_WEB_SESSION_SECRET is refused in production; use KF_WEB_SESSION_SECRET_FILE',
    );
  }
  if (file !== undefined && file !== '') {
    if (!isAbsolute(file)) throw new Error('KF_WEB_SESSION_SECRET_FILE must be an absolute path');
    let size: number;
    try {
      const metadata = statSync(file);
      if (!metadata.isFile()) throw new Error('not a regular file');
      size = metadata.size;
    } catch {
      throw new Error('KF_WEB_SESSION_SECRET_FILE must name a readable regular file');
    }
    if (size < 1 || size > 1_024) {
      throw new Error('KF_WEB_SESSION_SECRET_FILE must be between 1 byte and 1 KiB');
    }
    let contents: string;
    try {
      contents = readFileSync(file, 'utf8');
    } catch {
      throw new Error('KF_WEB_SESSION_SECRET_FILE must name a readable regular file');
    }
    if (Buffer.byteLength(contents, 'utf8') > 1_024) {
      throw new Error('KF_WEB_SESSION_SECRET_FILE must be between 1 byte and 1 KiB');
    }
    const raw = contents.endsWith('\r\n')
      ? contents.slice(0, -2)
      : contents.endsWith('\n')
        ? contents.slice(0, -1)
        : contents;
    return sessionKey(raw, 'KF_WEB_SESSION_SECRET_FILE');
  }
  if (inline !== undefined && inline !== '') {
    return sessionKey(inline, 'KF_WEB_SESSION_SECRET');
  }
  throw new Error(
    env['NODE_ENV'] === 'production'
      ? 'KF_WEB_SESSION_SECRET_FILE is required in dogfood production'
      : 'KF_WEB_SESSION_SECRET or KF_WEB_SESSION_SECRET_FILE is required in dogfood',
  );
}

/** Resolve web identity once per request. No incomplete dogfood fallback exists. */
export function loadWebIdentityConfig(env: Environment = process.env): WebIdentityConfig {
  const profile = required(env, 'KF_DEPLOYMENT_PROFILE');
  if (profile === 'development') return { profile };
  if (profile !== 'dogfood') {
    throw new Error(`KF_DEPLOYMENT_PROFILE must be development or dogfood, got ${profile}`);
  }

  const issuer = normalizedUrl(required(env, 'KF_WEB_OIDC_ISSUER'), 'KF_WEB_OIDC_ISSUER');
  const clientId = required(env, 'KF_WEB_OIDC_CLIENT_ID');
  const redirectUri = normalizedUrl(
    required(env, 'KF_WEB_OIDC_REDIRECT_URI'),
    'KF_WEB_OIDC_REDIRECT_URI',
  );
  return {
    profile,
    issuer: issuer.toString().replace(/\/$/, ''),
    clientId,
    redirectUri: redirectUri.toString(),
    sessionKey: configuredSessionKey(env),
  };
}
