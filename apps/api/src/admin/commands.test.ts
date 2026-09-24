import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  ownerUrl,
  runBootstrapCommand,
  runGrantAuthorityCommand,
  runRetireOrganizationCommand,
  runRevokeIdentityCommand,
} from './commands.js';

/**
 * RQ-151: the owner connection string is a secret and goes through the shared loader.
 *
 * `DATABASE_OWNER_URL_FILE` (owner-only) always works; the inline `DATABASE_OWNER_URL` works in
 * development and test and is refused everywhere else, before any argument is parsed or any
 * pool is opened. No test here reaches a database: every case is decided by the loader.
 */

const URL = 'postgres://kf_owner:not-a-real-password@127.0.0.1:5432/kf';

function sink(): { stream: Writable; text: () => string } {
  let buffer = '';
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, done) {
      buffer += chunk.toString();
      done();
    },
  });
  return { stream, text: () => buffer };
}

async function secretFile(mode: number, value = `${URL}\n`): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kf-owner-'));
  const path = join(dir, 'database-url');
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, mode);
  return path;
}

describe('ownerUrl (RQ-151)', () => {
  it('reads DATABASE_OWNER_URL_FILE, trailing newline stripped', async () => {
    const err = sink();
    const path = await secretFile(0o600);
    expect(ownerUrl({ NODE_ENV: 'production', DATABASE_OWNER_URL_FILE: path }, err.stream)).toBe(
      URL,
    );
    expect(err.text()).toBe('');
  });

  it('refuses the inline variable outside development and test, without echoing it', () => {
    for (const nodeEnv of ['production', 'staging', undefined]) {
      const err = sink();
      const env: NodeJS.ProcessEnv = { DATABASE_OWNER_URL: URL };
      if (nodeEnv !== undefined) env['NODE_ENV'] = nodeEnv;
      expect(ownerUrl(env, err.stream)).toBeUndefined();
      expect(err.text()).toMatch(/DATABASE_OWNER_URL_FILE/);
      expect(err.text()).not.toContain('not-a-real-password');
    }
  });

  it('accepts the inline variable in development and test', () => {
    for (const nodeEnv of ['development', 'test']) {
      const err = sink();
      expect(ownerUrl({ NODE_ENV: nodeEnv, DATABASE_OWNER_URL: URL }, err.stream)).toBe(URL);
    }
  });

  it('refuses an owner URL file readable beyond its owner', async () => {
    const err = sink();
    const path = await secretFile(0o644);
    expect(
      ownerUrl({ NODE_ENV: 'development', DATABASE_OWNER_URL_FILE: path }, err.stream),
    ).toBeUndefined();
    expect(err.text()).toMatch(/chmod 600/);
    expect(err.text()).not.toContain('not-a-real-password');
  });

  it('refuses when neither is set', () => {
    const err = sink();
    expect(ownerUrl({ NODE_ENV: 'development' }, err.stream)).toBeUndefined();
    expect(err.text()).toMatch(/DATABASE_OWNER_URL_FILE is not set/);
  });
});

describe('owner-tier commands refuse an inline owner URL in production (RQ-151)', () => {
  const commands = [
    runBootstrapCommand,
    runGrantAuthorityCommand,
    runRevokeIdentityCommand,
    runRetireOrganizationCommand,
  ];

  it.each(commands.map((command) => [command.name, command] as const))(
    '%s exits 1 before parsing arguments',
    async (_name, command) => {
      const out = sink();
      const err = sink();
      const code = await command(
        ['--not-a-real-flag'],
        { NODE_ENV: 'production', DATABASE_OWNER_URL: URL },
        out.stream,
        err.stream,
      );
      expect(code).toBe(1);
      expect(err.text()).toMatch(/use DATABASE_OWNER_URL_FILE/);
      expect(err.text()).not.toContain('not-a-real-password');
      expect(out.text()).toBe('');
    },
  );

  it.each(commands.map((command) => [command.name, command] as const))(
    '%s gets past the secret to argument parsing with the file',
    async (_name, command) => {
      const path = await secretFile(0o600);
      const err = sink();
      const code = await command(
        ['--not-a-real-flag'],
        { NODE_ENV: 'production', DATABASE_OWNER_URL_FILE: path },
        sink().stream,
        err.stream,
      );
      // 2 is the usage refusal: the loader admitted the file and the parser refused the flag.
      expect(code).toBe(2);
      expect(err.text()).not.toMatch(/is not set|supplied inline|owner connection is required/);
    },
  );
});
