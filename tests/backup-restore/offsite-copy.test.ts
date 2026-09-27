/**
 * What `backup-offsite.sh` records about a copy, and what it refuses to ship.
 *
 * Until 2026-09-23 the script called every local destination off-site unless the operator
 * remembered `--same-host`, shipped the plaintext bundle, and the evidence that a copy was
 * encrypted could only be typed in by hand. The unit that runs it also failed every night as
 * shipped: no environment file, an empty destination, no trust store. Every test here was
 * confirmed to fail against the previous script and unit.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  recipientKeys,
  ROOT,
  runScript,
  toolchain,
  type RecipientKeys,
  type Toolchain,
} from './fake-toolchain.js';

const OFFSITE = join(ROOT, 'scripts', 'backup-offsite.sh');
const open: Toolchain[] = [];

afterEach(() => {
  for (const tools of open.splice(0)) tools.cleanup();
});

function sha256(path: string): string {
  return execFileSync('sha256sum', [path], { encoding: 'utf8' }).split(' ')[0]!;
}

interface Fixture {
  readonly tools: Toolchain;
  readonly backup: string;
  readonly destination: string;
  readonly keys: RecipientKeys;
}

/** A recorded backup directory with a real encrypted archive beside it. */
function fixture(): Fixture {
  const tools = toolchain('kf-offsite-');
  open.push(tools);
  const keys = recipientKeys(tools.work);
  const backup = join(tools.work, 'backups', '20260923T020000Z');
  const destination = join(tools.work, 'vault');
  mkdirSync(backup, { recursive: true });
  mkdirSync(destination);
  writeFileSync(join(backup, 'dump.pgcustom'), 'dump\n');
  writeFileSync(join(backup, 'backup.manifest.json'), '{"database_snapshot_sha256":"x"}\n');
  writeFileSync(join(backup, 'backup.manifest.signature.json'), 'valid-signature\n');
  writeFileSync(
    join(backup, 'SHA256SUMS'),
    `${sha256(join(backup, 'dump.pgcustom'))}  ./dump.pgcustom\n`,
  );
  const home = join(tools.work, 'gnupg-encrypt');
  mkdirSync(home, { mode: 0o700 });
  execFileSync('bash', [
    '-c',
    'tar -cf - -C "$1" . | gpg --batch --no-tty --homedir "$2" --trust-model always --recipient-file "$3" --encrypt --output "$1.tar.gpg"',
    'encrypt',
    backup,
    home,
    keys.publicKey,
  ]);
  writeFileSync(
    join(tools.responses, 'run-row'),
    `11111111-1111-4111-8111-111111111111\t${sha256(join(backup, 'backup.manifest.json'))}\n`,
  );
  return { tools, backup, destination, keys };
}

function psqlCalls(tools: Toolchain): string[] {
  return tools
    .sqlLog()
    .split('\n')
    .filter((line) => line.startsWith('psql-args:'));
}

describe('a local destination is this host until somebody attests otherwise', () => {
  it('records an unattested local copy as NOT off-site, and says why', () => {
    const { tools, backup, destination } = fixture();
    const result = runScript(OFFSITE, [backup, destination, 'second-disk'], tools.env);
    expect(result.code, result.output).toBe(0);
    const insert = psqlCalls(tools).find((line) => line.includes('-v basis='));
    expect(insert).toContain('-v offsite=false');
    expect(insert).toContain('-v basis=local-unattested');
    expect(tools.sqlLog()).not.toContain('insert into ops.encrypted_backup_evidence');
    expect(result.output).toContain('Recorded as NOT off-site');
  });

  it('records an attested copy as off-site with encryption evidence it measured', () => {
    const { tools, backup, destination } = fixture();
    writeFileSync(join(tools.responses, 'domain-current'), '1\n');
    const ciphertextDigest = sha256(`${backup}.tar.gpg`);
    const result = runScript(
      OFFSITE,
      [backup, destination, 'vault-b', '--separate-domain', 'building-b-rack-4'],
      tools.env,
    );
    expect(result.code, result.output).toBe(0);
    const insert = psqlCalls(tools).find((line) => line.includes('-v basis='));
    expect(insert).toContain('-v offsite=true');
    expect(insert).toContain('-v basis=attested-domain');
    expect(insert).toContain('-v domain=building-b-rack-4');
    expect(insert).toContain(`-v ciphertext=${ciphertextDigest}`);
    expect(tools.sqlLog()).toContain('insert into ops.encrypted_backup_evidence');
    // Only the ciphertext crossed; the plaintext directory did not.
    expect(existsSync(join(destination, '20260923T020000Z.tar.gpg'))).toBe(true);
    expect(existsSync(join(destination, '20260923T020000Z'))).toBe(false);
  });

  it('refuses to attest a domain nobody approved, before copying anything', () => {
    const { tools, backup, destination } = fixture();
    writeFileSync(join(tools.responses, 'domain-current'), '0\n');
    const result = runScript(
      OFFSITE,
      [backup, destination, 'vault-b', '--separate-domain', 'made-up'],
      tools.env,
    );
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('no current approval');
    expect(existsSync(join(destination, '20260923T020000Z.tar.gpg'))).toBe(false);
    expect(tools.sqlLog()).not.toContain('insert into ops.backup_copy');
  });
});

describe('only ciphertext leaves, and only intact', () => {
  it('refuses a plaintext archive wearing an encrypted name', () => {
    const { tools, backup, destination } = fixture();
    execFileSync('tar', ['-cf', `${backup}.tar.gpg`, '-C', backup, '.']);
    const result = runScript(OFFSITE, [backup, destination, 'vault'], tools.env);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('does not begin with an OpenPGP public-key-encrypted packet');
    expect(existsSync(join(destination, '20260923T020000Z.tar.gpg'))).toBe(false);
  });

  it('refuses to record a copy that differs at the destination', () => {
    const { tools, backup, destination } = fixture();
    writeFileSync(
      join(tools.bin, 'rsync'),
      `#!/usr/bin/env bash
set -euo pipefail
dst="\${@: -1}"
printf 'corrupted in transit\\n' > "$dst"
`,
      { mode: 0o755 },
    );
    const result = runScript(OFFSITE, [backup, destination, 'vault'], tools.env);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('does not match the encrypted archive that was sent');
    expect(tools.sqlLog()).not.toContain('insert into ops.backup_copy');
  });
});

describe('the shipped off-site unit', () => {
  const unit = readFileSync(join(ROOT, 'deploy', 'systemd', 'kf-backup-offsite.service'), 'utf8');
  const environment = readFileSync(join(ROOT, 'deploy', 'systemd', 'offsite.env.example'), 'utf8');

  it('reads its destination and trust store from an environment file', () => {
    expect(unit).toContain('EnvironmentFile=/etc/kf/offsite.env');
    expect(unit).not.toMatch(/^Environment=KF_OFFSITE_DESTINATION=/m);
    expect(environment).toMatch(/^PRESERVATION_TRUST_STORE_DIR=\/etc\/kf\//m);
    expect(environment).toMatch(/^KF_OFFSITE_DESTINATION=$/m);
    expect(environment).toMatch(/^KF_OFFSITE_LABEL=$/m);
  });

  it('refuses to start with an unset destination, in words', () => {
    // The ExecStartPre= lines exactly as systemd hands them to /bin/sh: `$$` becomes `$`.
    const checks = [...unit.matchAll(/^ExecStartPre=\/bin\/sh -c '(.*)'$/gm)].map((match) =>
      match[1]!.replaceAll('$$', '$'),
    );
    expect(checks.length).toBeGreaterThanOrEqual(2);
    const run = (env: Record<string, string>): { code: number; output: string } => {
      for (const check of checks) {
        const r = spawnSync('/bin/sh', ['-c', check], { env, encoding: 'utf8' });
        if (r.status !== 0) return { code: r.status ?? 1, output: `${r.stdout}${r.stderr}` };
      }
      return { code: 0, output: '' };
    };
    const unset = run({ PATH: '/usr/bin:/bin' });
    expect(unset.code).not.toBe(0);
    expect(unset.output).toContain('KF_OFFSITE_DESTINATION and KF_OFFSITE_LABEL must be set');

    const tools = toolchain('kf-offsite-unit-');
    open.push(tools);
    const readOnly = run({
      PATH: '/usr/bin:/bin',
      KF_OFFSITE_DESTINATION: join(tools.work, 'missing'),
      KF_OFFSITE_LABEL: 'vault',
    });
    expect(readOnly.code).not.toBe(0);
    expect(readOnly.output).toContain('ReadWritePaths=');

    expect(
      run({ PATH: '/usr/bin:/bin', KF_OFFSITE_DESTINATION: tools.work, KF_OFFSITE_LABEL: 'vault' })
        .code,
    ).toBe(0);
    expect(
      run({
        PATH: '/usr/bin:/bin',
        KF_OFFSITE_DESTINATION: 'kf@vault.example:/srv/kf',
        KF_OFFSITE_LABEL: 'vault',
      }).code,
    ).toBe(0);
  });
});
