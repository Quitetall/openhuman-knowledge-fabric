/**
 * Which copy the restore drill restores, and where it restores it.
 *
 * Until 2026-09-23 `restore-drill.sh` chose the newest backup BECAUSE it had an off-site copy,
 * then restored the local original — so the copy a real recovery would depend on was never
 * read. And it created its scratch database inside the production cluster. These tests run the
 * real drill script with its PostgreSQL client, server tools and `restore-verify.sh` faked, and
 * real gpg/rsync/tar, and were confirmed to fail against the previous script.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
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

const open: Toolchain[] = [];
afterEach(() => {
  for (const tools of open.splice(0)) tools.cleanup();
});

function sha256(path: string): string {
  return execFileSync('sha256sum', [path], { encoding: 'utf8' }).split(' ')[0]!;
}

interface Drill {
  readonly tools: Toolchain;
  readonly script: string;
  readonly location: string;
  readonly vault: string;
  readonly workRoot: string;
  readonly verifyLog: string;
  readonly keys: RecipientKeys;
  readonly env: Record<string, string>;
}

/**
 * The drill script copied into a scratch release tree beside a fake `restore-verify.sh`, so
 * the drill itself is the real bytes and only what it delegates to is replaced.
 */
function drill(): Drill {
  const tools = toolchain('kf-drill-');
  open.push(tools);
  const keys = recipientKeys(tools.work);
  const release = join(tools.work, 'release');
  mkdirSync(join(release, 'scripts', 'lib'), { recursive: true });
  const script = join(release, 'scripts', 'restore-drill.sh');
  copyFileSync(join(ROOT, 'scripts', 'restore-drill.sh'), script);
  copyFileSync(
    join(ROOT, 'scripts', 'lib', 'secret.sh'),
    join(release, 'scripts', 'lib', 'secret.sh'),
  );
  const verifyLog = join(tools.work, 'restore-verify.log');
  const verify = join(release, 'scripts', 'restore-verify.sh');
  writeFileSync(
    verify,
    `#!/usr/bin/env bash
set -euo pipefail
{
  echo "source=$1"
  echo "manifest=$(cat "$1/backup.manifest.json")"
  echo "target=$(cat "$2")"
  echo "ledger-location=\${KF_RESTORE_LEDGER_LOCATION:-}"
  echo "notes=\${KF_RESTORE_DRILL_NOTES:-}"
} > "${verifyLog}"
`,
  );
  chmodSync(verify, 0o755);

  // PostgreSQL 18 server tools, faked: initdb makes the data directory, pg_ctl start writes the
  // pid file the cleanup looks for and stop removes it.
  const server = join(tools.work, 'server');
  mkdirSync(server);
  for (const [tool, body] of [
    ['initdb', 'for a in "$@"; do case "$a" in --pgdata=*) mkdir -p "${a#--pgdata=}";; esac; done'],
    [
      'pg_ctl',
      'data=""; for a in "$@"; do case "$a" in --pgdata=*) data="${a#--pgdata=}";; esac; done\n' +
        'case " $* " in *" start"*) echo 1 > "$data/postmaster.pid";; *" stop"*) rm -f "$data/postmaster.pid";; esac',
    ],
  ] as const) {
    writeFileSync(
      join(server, tool),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = --version ]; then echo '${tool} (PostgreSQL) 18.1'; exit 0; fi
printf '${tool}:%s\\n' "$*" >> "$KF_FAKE_LOG"
${body}
`,
      { mode: 0o755 },
    );
  }

  // The recorded backup, its ciphertext, and the off-site vault holding a copy of it.
  const location = join(tools.work, 'backups', '20260923T020000Z');
  mkdirSync(location, { recursive: true });
  writeFileSync(join(location, 'backup.manifest.json'), '{"which":"the recorded backup"}\n');
  writeFileSync(join(location, 'backup.manifest.signature.json'), 'valid-signature\n');
  const home = join(tools.work, 'gnupg-encrypt');
  mkdirSync(home, { mode: 0o700 });
  const vault = join(tools.work, 'vault');
  mkdirSync(vault);
  execFileSync('bash', [
    '-c',
    'tar -cf - -C "$1" . | gpg --batch --no-tty --homedir "$2" --trust-model always --recipient-file "$3" --encrypt --output "$4"',
    'encrypt',
    location,
    home,
    keys.publicKey,
    join(vault, '20260923T020000Z.tar.gpg'),
  ]);
  const ciphertext = sha256(join(vault, '20260923T020000Z.tar.gpg'));
  writeFileSync(
    join(tools.responses, 'drill-row'),
    `11111111-1111-4111-8111-111111111111\t${location}\t${sha256(join(location, 'backup.manifest.json'))}\t${ciphertext}\n`,
  );
  const workRoot = join(tools.work, 'drill-work');
  return {
    tools,
    script,
    location,
    vault,
    workRoot,
    verifyLog,
    keys,
    env: {
      ...tools.env,
      KF_POSTGRES_SERVER_DIR: server,
      KF_DRILL_WORK_ROOT: workRoot,
      KF_DRILL_OFFSITE_SOURCE: vault,
      KF_DRILL_OFFSITE_LABEL: 'vault-b',
      KF_DRILL_DECRYPTION_KEY_FILE: keys.secretKey,
    },
  };
}

function verified(d: Drill): Record<string, string> {
  return Object.fromEntries(
    readFileSync(d.verifyLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}

describe('the drill restores the copy that left, not the one that stayed', () => {
  it('pulls the off-site ciphertext back, decrypts it, and restores that', () => {
    const d = drill();
    // Make the local original distinguishable: if the drill restores it, the manifest says so.
    writeFileSync(join(d.location, 'backup.manifest.json'), '{"which":"LOCAL ORIGINAL"}\n');
    // The ledger row was written before this edit: it names the backup that was encrypted.
    const result = runScript(d.script, [], d.env);
    expect(result.code, result.output).toBe(0);
    const facts = verified(d);
    expect(facts['manifest']).toBe('{"which":"the recorded backup"}');
    expect(facts['source']!.startsWith(d.workRoot)).toBe(true);
    expect(facts['ledger-location']).toBe(d.location);
    expect(facts['notes']).toMatch(/^source=offsite label=vault-b ciphertext_sha256=[0-9a-f]{64}$/);
  });

  it('refuses an off-site object that is not the ciphertext recorded as sent', () => {
    const d = drill();
    writeFileSync(join(d.vault, '20260923T020000Z.tar.gpg'), 'replaced by somebody\n');
    const result = runScript(d.script, [], d.env);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('not the one recorded as sent');
    expect(existsSync(d.verifyLog), 'restore-verify ran on an unverified copy').toBe(false);
  });

  it('falls back to the local original only when told to, and records that it did', () => {
    const d = drill();
    const env = { ...d.env, KF_DRILL_OFFSITE_SOURCE: '' };
    const refused = runScript(d.script, [], env);
    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain('--allow-local-fallback');
    expect(existsSync(d.verifyLog)).toBe(false);

    const fallback = runScript(d.script, ['--allow-local-fallback'], env);
    expect(fallback.code, fallback.output).toBe(0);
    const facts = verified(d);
    expect(facts['source']).toBe(d.location);
    expect(facts['notes']).toMatch(/^source=local-fallback reason=/);
  });
});

describe('the drill never restores into the production cluster', () => {
  it('restores into a throwaway socket-only cluster and removes it afterwards', () => {
    const d = drill();
    const result = runScript(d.script, [], d.env);
    expect(result.code, result.output).toBe(0);
    const target = verified(d)['target']!;
    expect(target).toMatch(/^postgresql:\/\/\/kf_drill\?host=.+&port=55432&user=kf_drill$/);
    expect(target).toContain(d.workRoot);

    const log = d.tools.sqlLog();
    expect(log).toContain('initdb:');
    expect(log).toMatch(/pg_ctl:.*listen_addresses=''.*start/);
    expect(log).toMatch(/pg_ctl:.*--mode=immediate.*stop/);
    // `create database` went to the throwaway cluster's socket, never to the production URL.
    const creates = log.split('\n').filter((line) => line.startsWith('psql-c:'));
    expect(creates).toEqual(['psql-c:create database kf_drill']);
    const createArgs = log
      .split('\n')
      .filter((line) => line.startsWith('psql-args:') && line.includes('create database'));
    expect(createArgs.every((line) => line.includes(`host=${d.workRoot}`))).toBe(true);
    expect(log).not.toMatch(/psql-args:postgres:\/\/kf@localhost\/kf .*create database/);
    // Nothing left behind: the cluster, the decrypted bundle and the key ring are gone.
    expect(readdirSync(d.workRoot)).toEqual([]);
  });

  it('the shipped unit gives the drill its own state directory and a sealed decryption key', () => {
    const unit = readFileSync(join(ROOT, 'deploy', 'systemd', 'kf-restore-drill.service'), 'utf8');
    expect(unit).toContain('StateDirectory=kf-restore-drill');
    expect(unit).toMatch(/^LoadCredentialEncrypted=backup-decryption-key:/m);
    expect(unit).toContain('Environment=KF_DRILL_DECRYPTION_KEY_FILE=%d/backup-decryption-key');
    const backupUnit = readFileSync(join(ROOT, 'deploy', 'systemd', 'kf-backup.service'), 'utf8');
    expect(backupUnit).not.toContain('backup-decryption-key');
  });
});
