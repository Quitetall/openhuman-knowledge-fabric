/**
 * Loading secrets.
 *
 * Three rules, each because of a specific way secrets escape.
 *
 * FILES, NOT ENVIRONMENT. An environment variable is readable from `/proc/<pid>/environ` by
 * anything running as the same user, is inherited by every child process, and is printed in
 * full by most crash reporters and container inspection tools. A file has an owner and a mode.
 * So `X_FILE` is preferred over `X`, and outside development `X` is refused outright.
 *
 * PERMISSIONS ARE CHECKED. A private key readable by the world is not a private key. This
 * refuses to load one rather than warning, because a warning at startup is read once.
 *
 * NEVER RETURNED IN AN ERROR. Every failure names the variable and the path, never the value.
 * The most common way a key reaches a log is a message that helpfully included it.
 */

import { readFileSync, statSync } from 'node:fs';

export class SecretRejected extends Error {
  readonly reason: 'missing' | 'too_permissive' | 'empty' | 'inline_in_production';

  constructor(reason: SecretRejected['reason'], message: string) {
    super(message);
    this.name = 'SecretRejected';
    this.reason = reason;
  }
}

export interface SecretOptions {
  /** Development and test may pass a secret inline; nothing else may. */
  readonly allowInline?: boolean;
  /**
   * Permission bits that must NOT be set. Group and other by default: a secret readable by
   * anyone but its owner is one an attacker on the same host already has.
   */
  readonly forbiddenMode?: number;
}

const GROUP_AND_OTHER = 0o077;

/**
 * Read a secret from a path that was supplied directly.
 *
 * For variables that name a file by design rather than by the `_FILE` convention — the
 * checkpoint signing key, which has always been a path because a private key in an
 * environment variable was never acceptable. Same permission rule, same refusal.
 */
export function readSecretFile(path: string, label: string, forbiddenMode?: number): string {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    throw new SecretRejected('missing', `${label} points at ${path}, which cannot be read`);
  }
  const forbidden = forbiddenMode ?? GROUP_AND_OTHER;
  if ((mode & forbidden) !== 0) {
    throw new SecretRejected(
      'too_permissive',
      `${path} is mode ${(mode & 0o777).toString(8)} — a secret readable beyond its owner ` +
        `is already disclosed to anything running as another user on this host. chmod 600 it.`,
    );
  }
  const value = readFileSync(path, 'utf8').replace(/\s+$/, '');
  if (value === '') throw new SecretRejected('empty', `${path} is empty`);
  return value;
}

/**
 * Read a secret from `<NAME>_FILE`, or from `<NAME>` where that is allowed.
 *
 * Trailing whitespace is stripped, because every editor and every `echo` adds a newline and a
 * key that differs from the intended one by a trailing byte fails in a way nobody diagnoses
 * quickly.
 */
export function loadSecret(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  options: SecretOptions = {},
): string {
  const path = env[`${name}_FILE`];

  if (path !== undefined && path !== '') {
    return readSecretFile(path, `${name}_FILE`, options.forbiddenMode);
  }

  const inline = env[name];
  if (inline === undefined || inline === '') {
    throw new SecretRejected(
      'missing',
      `${name}_FILE is not set${options.allowInline === true ? ` and neither is ${name}` : ''}`,
    );
  }

  if (options.allowInline !== true) {
    throw new SecretRejected(
      'inline_in_production',
      `${name} was supplied inline. Environment variables are readable from /proc, inherited ` +
        `by every child process, and printed by most crash reporters — use ${name}_FILE.`,
    );
  }
  return inline.replace(/\s+$/, '');
}

/**
 * Redact anything that looks like a secret before it reaches a log.
 *
 * A backstop, not a substitute for not logging them. It exists because the connection string
 * is the one secret that genuinely has to be passed around as a string, and it is the one that
 * ends up in error messages.
 */
export function redact(text: string): string {
  return (
    text
      // postgres://user:password@host — the password, and nothing else
      .replace(/(:\/\/[^:@/\s]+:)[^@\s]+@/g, '$1<redacted>@')
      // Bearer tokens and anything else following one of these keywords.
      //
      // The value stops at a separator rather than running to the next space: with `\S+` the
      // string `password=x&host=db&port=5432` redacted to `password=<redacted>`, taking the
      // host and port with it. Over-redaction is the safe direction and it is still the wrong
      // one — a redactor that removes the context around the secret gets removed.
      .replace(/\b(bearer|token|secret|password|apikey|api_key)([=:\s]+)[^\s&;"']+/gi,
        '$1$2<redacted>')
      // PEM blocks
      .replace(
        /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
        '<redacted private key>',
      )
  );
}
