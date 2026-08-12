/**
 * Loading secrets.
 *
 * Three properties, each corresponding to a specific way secrets escape: they are read from
 * files rather than the environment, a file readable beyond its owner is refused rather than
 * warned about, and no failure message ever contains the value.
 *
 * The last one is tested by looking at the messages, not by reading the implementation. The
 * most common way a key reaches a log is a message that helpfully included it, and that
 * message is always added later by somebody being helpful.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadSecret, readSecretFile, redact, SecretRejected } from '@kf/operations';

const dir = mkdtempSync(join(tmpdir(), 'kf-secrets-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function secretFile(name: string, contents: string, mode = 0o600): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  chmodSync(path, mode);
  return path;
}

const VALUE = 'postgres://kf_app:hunter2@db.internal:5432/kf';

describe('files over environment variables', () => {
  it('prefers <NAME>_FILE', () => {
    const path = secretFile('prefer', VALUE);
    expect(
      loadSecret('DATABASE_URL', { DATABASE_URL_FILE: path, DATABASE_URL: 'wrong' }, {
        allowInline: true,
      }),
    ).toBe(VALUE);
  });

  it('refuses an inline secret outside development', () => {
    const err = (() => {
      try {
        loadSecret('DATABASE_URL', { DATABASE_URL: VALUE });
        return undefined;
      } catch (e: unknown) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(SecretRejected);
    expect((err as SecretRejected).reason).toBe('inline_in_production');
    // Says WHY, because "use a file" without the reason gets worked around.
    expect((err as SecretRejected).message).toMatch(/proc/);
    expect((err as SecretRejected).message).not.toContain('hunter2');
  });

  it('allows an inline secret where development has said so', () => {
    expect(loadSecret('DATABASE_URL', { DATABASE_URL: VALUE }, { allowInline: true })).toBe(VALUE);
  });

  it('strips the trailing newline every editor adds', () => {
    const path = secretFile('newline', `${VALUE}\n`);
    expect(loadSecret('DATABASE_URL', { DATABASE_URL_FILE: path })).toBe(VALUE);
  });

  it('keeps internal spaces, which a libpq keyword string needs', () => {
    // Stripping all whitespace instead of trailing whitespace would corrupt this into
    // something that fails to connect for a reason nobody would guess.
    const conninfo = 'host=db.internal user=kf_app dbname=kf';
    const path = secretFile('conninfo', `${conninfo}\n`);
    expect(loadSecret('DATABASE_URL', { DATABASE_URL_FILE: path })).toBe(conninfo);
  });
});

describe('permissions', () => {
  it.each([
    ['group-readable', 0o640],
    ['world-readable', 0o604],
    ['world-writable', 0o602],
    ['wide open', 0o666],
  ])('refuses a %s secret file', (_label, mode) => {
    const path = secretFile(`mode-${mode.toString(8)}`, VALUE, mode);
    let caught: unknown;
    try {
      loadSecret('DATABASE_URL', { DATABASE_URL_FILE: path });
    } catch (e: unknown) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SecretRejected);
    expect((caught as SecretRejected).reason).toBe('too_permissive');
    // Refused, not warned. A warning at startup is read once, on the day it is added.
    expect((caught as SecretRejected).message).toMatch(/chmod 600/);
    expect((caught as SecretRejected).message).not.toContain('hunter2');
  });

  it('accepts 0600 and 0400', () => {
    for (const mode of [0o600, 0o400]) {
      const path = secretFile(`ok-${mode.toString(8)}`, VALUE, mode);
      expect(loadSecret('DATABASE_URL', { DATABASE_URL_FILE: path })).toBe(VALUE);
    }
  });

  it('applies the same rule to a path-valued variable', () => {
    // The checkpoint signing key is named by CHECKPOINT_SIGNING_KEY_PATH rather than by the
    // _FILE convention, and it is the one secret in the system whose disclosure lets somebody
    // forge the evidence that the records were never altered.
    const path = secretFile('key.pem', '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----', 0o644);
    expect(() => readSecretFile(path, 'CHECKPOINT_SIGNING_KEY_PATH')).toThrow(SecretRejected);
  });
});

describe('refusing rather than defaulting', () => {
  it('refuses an empty file', () => {
    const path = secretFile('empty', '   \n');
    expect(() => loadSecret('DATABASE_URL', { DATABASE_URL_FILE: path })).toThrow(/is empty/);
  });

  it('refuses a file that does not exist, naming the variable and the path', () => {
    const missing = join(dir, 'nope');
    expect(() => loadSecret('DATABASE_URL', { DATABASE_URL_FILE: missing })).toThrow(
      /DATABASE_URL_FILE points at .*nope/,
    );
  });

  it('refuses when neither form is set', () => {
    expect(() => loadSecret('DATABASE_URL', {})).toThrow(SecretRejected);
  });
});

describe('redaction', () => {
  it('removes the password from a connection string and keeps the rest', () => {
    const out = redact(`connecting to ${VALUE}`);
    expect(out).not.toContain('hunter2');
    // The host and database survive, because an error message about a connection failure is
    // useless without them — redaction that removes everything gets removed.
    expect(out).toContain('db.internal:5432/kf');
  });

  it('removes bearer tokens and private keys', () => {
    expect(redact('authorization: Bearer eyJhbGciOi.abc.def')).not.toContain('eyJhbGciOi');
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----';
    expect(redact(`key: ${pem}`)).toBe('key: <redacted private key>');
  });

  it('leaves text with no secret in it alone', () => {
    const plain = 'the checkpoint at seq 4102 does not verify';
    expect(redact(plain)).toBe(plain);
  });
});
