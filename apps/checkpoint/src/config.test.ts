import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { anchorConfig, assertSigningKeyTrusted, missingAnchor, signingKeyId } from './config.js';
import { generateSigningKey } from './sign.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function trustDirectory(entries: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'kf-checkpoint-trust-'));
  directories.push(directory);
  for (const [name, body] of Object.entries(entries)) writeFileSync(join(directory, name), body);
  return directory;
}

function pem(key: ReturnType<typeof generateSigningKey>): string {
  return key.publicKey.export({ format: 'pem', type: 'spki' }) as string;
}

describe('the checkpoint key id', () => {
  it('has no default in production, because a shared default hides a key swap', () => {
    expect(() => signingKeyId({ NODE_ENV: 'production' })).toThrow(
      'CHECKPOINT_SIGNING_KEY_ID must be set in production',
    );
    expect(signingKeyId({ NODE_ENV: 'production', CHECKPOINT_SIGNING_KEY_ID: 'host-a-2026' })).toBe(
      'host-a-2026',
    );
    // A workstation still needs no configuration.
    expect(signingKeyId({ NODE_ENV: 'development' })).toBe('checkpoint-1');
  });
});

describe('--run refuses a key verifiers do not already trust', () => {
  const production = (directory: string): NodeJS.ProcessEnv => ({
    NODE_ENV: 'production',
    CHECKPOINT_PUBLIC_KEY_DIR: directory,
  });

  it('requires the trust directory in production', () => {
    const key = generateSigningKey('host-a-2026');
    expect(() => assertSigningKeyTrusted(key, { NODE_ENV: 'production' })).toThrow(
      'CHECKPOINT_PUBLIC_KEY_DIR must be set in production',
    );
  });

  it('refuses when <id>.pub is missing', () => {
    const key = generateSigningKey('host-a-2026');
    const other = generateSigningKey('host-a-2025');
    const directory = trustDirectory({ 'host-a-2025.pub': pem(other) });
    expect(() => assertSigningKeyTrusted(key, production(directory))).toThrow(
      'host-a-2026.pub is not in',
    );
  });

  it('refuses when <id>.pub is a different key — a swapped private key under a reused id', () => {
    const published = generateSigningKey('checkpoint-1');
    const swapped = generateSigningKey('checkpoint-1');
    const directory = trustDirectory({ 'checkpoint-1.pub': pem(published) });
    expect(() => assertSigningKeyTrusted(swapped, production(directory))).toThrow(
      'is a different key from the private key',
    );
  });

  it('accepts the key whose public half is published under its id', () => {
    const key = generateSigningKey('host-a-2026');
    const directory = trustDirectory({ 'host-a-2026.pub': pem(key) });
    expect(() => assertSigningKeyTrusted(key, production(directory))).not.toThrow();
  });
});

describe('the external anchor', () => {
  it('is required in production: a database-only checkpoint is reported as a failure', () => {
    expect(missingAnchor({ NODE_ENV: 'production' }, undefined)).toContain(
      'production requires an external anchor',
    );
    expect(missingAnchor({ NODE_ENV: 'development' }, undefined)).toBeUndefined();
  });

  it('reads the anchor secret from a file and refuses it inline in production', () => {
    const directory = trustDirectory({});
    const secret = join(directory, 'secret');
    writeFileSync(secret, 'anchor-secret\n', { mode: 0o600 });
    const base = {
      NODE_ENV: 'production',
      CHECKPOINT_S3_ENDPOINT: 'https://anchor.example',
      CHECKPOINT_S3_ACCESS_KEY_ID: 'kf-checkpoint',
    };
    const anchor = anchorConfig({ ...base, CHECKPOINT_S3_SECRET_ACCESS_KEY_FILE: secret });
    expect(anchor?.secretAccessKey).toBe('anchor-secret');
    expect(missingAnchor(base, anchor)).toBeUndefined();
    expect(() => anchorConfig({ ...base, CHECKPOINT_S3_SECRET_ACCESS_KEY: 'inline' })).toThrow();
  });
});

describe('the shipped signer uses these refusals', () => {
  it('main.ts checks the key before touching the database and reports a missing anchor', () => {
    const main = readFileSync(join(import.meta.dirname, 'main.ts'), 'utf8');
    expect(main).not.toContain("?? 'checkpoint-1'");
    const trusted = main.indexOf('assertSigningKeyTrusted(key, process.env)');
    const run = main.indexOf('await runCheckpoint(');
    const anchored = main.indexOf('missingAnchor(process.env, anchor)');
    expect(trusted).toBeGreaterThan(0);
    expect(trusted).toBeLessThan(run);
    expect(anchored).toBeGreaterThan(run);
  });

  it('kf-checkpoint.service pins production, the key id file and the trust directory', () => {
    const root = join(import.meta.dirname, '..', '..', '..');
    const unit = readFileSync(join(root, 'deploy', 'systemd', 'kf-checkpoint.service'), 'utf8');
    const environment = readFileSync(
      join(root, 'deploy', 'systemd', 'checkpoint.env.example'),
      'utf8',
    );
    expect(unit).toContain('Environment=NODE_ENV=production');
    expect(unit).toContain('Environment=CHECKPOINT_PUBLIC_KEY_DIR=/etc/kf/checkpoint-public-keys');
    expect(unit).toContain('EnvironmentFile=/etc/kf/checkpoint.env');
    expect(unit).toMatch(/^Environment=CHECKPOINT_S3_SECRET_ACCESS_KEY_FILE=\//m);
    expect(environment).toMatch(/^CHECKPOINT_SIGNING_KEY_ID=/m);
    expect(environment).toMatch(/^CHECKPOINT_S3_ENDPOINT=/m);
  });
});
