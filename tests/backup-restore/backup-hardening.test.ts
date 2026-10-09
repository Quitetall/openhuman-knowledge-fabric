/**
 * What `backup.sh` does to the bytes it produces, beyond producing them.
 *
 * Found in the shipped script on 2026-09-23: every backup was a plaintext copy of every record,
 * kept on the database host forever, and handed to the off-site job as plaintext. A deployed
 * backup could also omit the checkpoint public keys, which the restore drill then recorded as a
 * partial restore every month. Each test below runs the real script with only its external
 * programs faked (see fake-toolchain.ts), and each was confirmed to fail against the script as
 * it was before the change.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decryptAndList,
  recipientKeys,
  ROOT,
  runScript,
  toolchain,
  type Toolchain,
} from './fake-toolchain.js';

const BACKUP = join(ROOT, 'scripts', 'backup.sh');
const open: Toolchain[] = [];

afterEach(() => {
  for (const tools of open.splice(0)) tools.cleanup();
});

function setup(): Toolchain {
  const tools = toolchain('kf-backup-hardening-');
  open.push(tools);
  writeFileSync(join(tools.responses, 'estimate'), '1000\n');
  return tools;
}

describe('backups leave the host only as ciphertext', () => {
  it('encrypts the verified bundle to the configured recipient and nothing else', () => {
    const tools = setup();
    const keys = recipientKeys(tools.work);
    const destination = join(tools.work, 'backups', '20260923T020000Z');

    const result = runScript(BACKUP, [destination], {
      ...tools.env,
      KF_BACKUP_RECIPIENT_FILE: keys.publicKey,
    });
    expect(result.code, result.output).toBe(0);

    const ciphertext = `${destination}.tar.gpg`;
    expect(existsSync(ciphertext), 'no encrypted archive beside the backup').toBe(true);
    // A public-key-encrypted session key packet leads, naming the recipient's encryption key.
    expect(readFileSync(ciphertext)[0]).toBe(0x84);
    expect(result.output).toContain(`recipient key ${keys.keyId}`);
    // The recipient can read back exactly the signed bundle.
    expect(decryptAndList(ciphertext, keys, tools.work)).toEqual(
      expect.arrayContaining([
        './backup.manifest.json',
        './backup.manifest.signature.json',
        './dump.pgcustom',
        './SHA256SUMS',
      ]),
    );
    // Recorded only after the archive existed.
    expect(tools.sqlLog()).toContain('insert into ops.backup_run');
  });

  it('leaves the bundle and its ciphertext readable by the archive group, under the unit umask', () => {
    // kf-backup writes; kf-offsite, through the kf-archive group the setgid /srv/kf-backups
    // gives every entry, re-verifies the bundle and ships the ciphertext. mktemp made both
    // owner-only and kf-backup.service runs with UMask=0077, so on the first host the off-site
    // copy could not enter the directory: "cd: /srv/kf-backups/<backup>/: Permission denied"
    // (KF-WAR-0001 rehearsal, 2026-10-07). Group read, never group write, never other.
    const tools = setup();
    const keys = recipientKeys(tools.work);
    const destination = join(tools.work, 'backups', '20261007T020000Z');
    const wrapper = join(tools.work, 'as-the-unit.sh');
    writeFileSync(wrapper, `umask 077\nexec bash ${JSON.stringify(BACKUP)} "$@"\n`);
    const result = runScript(wrapper, [destination], {
      ...tools.env,
      KF_BACKUP_RECIPIENT_FILE: keys.publicKey,
    });
    expect(result.code, result.output).toBe(0);
    const modes: string[] = [];
    const visit = (path: string): void => {
      const stat = statSync(path);
      const mode = stat.mode & 0o777;
      if (stat.isDirectory()) {
        if (mode !== 0o750) modes.push(`${path} ${mode.toString(8)}`);
        for (const entry of readdirSync(path)) visit(join(path, entry));
      } else if (mode !== 0o640) {
        modes.push(`${path} ${mode.toString(8)}`);
      }
    };
    visit(destination);
    visit(`${destination}.tar.gpg`);
    expect(modes).toEqual([]);
  });

  it('routes the role dump to the admitted database returned by PostgreSQL', () => {
    const tools = setup();
    writeFileSync(join(tools.responses, 'database-name'), 'kf_backup_target\n');
    const result = runScript(BACKUP, [join(tools.work, 'backups', 'routed')], tools.env);

    expect(result.code, result.output).toBe(0);
    expect(tools.sqlLog()).toContain('psql-c:select current_database()');
    expect(tools.sqlLog()).toMatch(/^pg_dumpall:.* --database=kf_backup_target$/m);
  });

  it('refuses the role dump when PostgreSQL returns no admitted database identity', () => {
    const tools = setup();
    writeFileSync(join(tools.responses, 'database-name'), '');
    const result = runScript(BACKUP, [join(tools.work, 'backups', 'unidentified')], tools.env);

    expect(result.code).not.toBe(0);
    expect(result.output).toContain(
      'refusing to dump roles without the admitted database identity',
    );
    expect(tools.sqlLog()).toContain('psql-c:select current_database()');
    expect(tools.sqlLog()).not.toContain('pg_dumpall:');
  });

  it('refuses a recipient file that carries a private key, before reading the database', () => {
    const tools = setup();
    const keys = recipientKeys(tools.work);
    const result = runScript(BACKUP, [join(tools.work, 'backups', 'b')], {
      ...tools.env,
      KF_BACKUP_RECIPIENT_FILE: keys.secretKey,
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('contains a private key');
    expect(tools.sqlLog()).not.toContain('pg_dump:');
    expect(tools.sqlLog()).not.toContain('coproc:');
  });

  it('on a deployed host, refuses to run without a recipient or checkpoint public keys', () => {
    const tools = setup();
    const keys = recipientKeys(tools.work);
    const checkpointKeys = join(tools.work, 'checkpoint-public-keys');
    mkdirSync(checkpointKeys);

    const noRecipient = runScript(BACKUP, [join(tools.work, 'backups', 'a')], {
      ...tools.env,
      KF_DEPLOYMENT_PROFILE: 'dogfood',
      CHECKPOINT_PUBLIC_KEY_DIR: checkpointKeys,
    });
    expect(noRecipient.code).not.toBe(0);
    expect(noRecipient.output).toContain('KF_BACKUP_RECIPIENT_FILE');

    const noCheckpointKeys = runScript(BACKUP, [join(tools.work, 'backups', 'b')], {
      ...tools.env,
      KF_DEPLOYMENT_PROFILE: 'dogfood',
      KF_BACKUP_RECIPIENT_FILE: keys.publicKey,
      CHECKPOINT_PUBLIC_KEY_DIR: '',
    });
    expect(noCheckpointKeys.code).not.toBe(0);
    expect(noCheckpointKeys.output).toContain('CHECKPOINT_PUBLIC_KEY_DIR');
    expect(tools.sqlLog()).not.toContain('pg_dump:');
  });

  it('the shipped backup unit declares the deployed profile and its env names a recipient', () => {
    const unit = readFileSync(join(ROOT, 'deploy', 'systemd', 'kf-backup.service'), 'utf8');
    const environment = readFileSync(join(ROOT, 'deploy', 'systemd', 'backup.env.example'), 'utf8');
    expect(unit).toContain('Environment=KF_DEPLOYMENT_PROFILE=dogfood');
    expect(unit).toContain('Environment=CHECKPOINT_PUBLIC_KEY_DIR=/etc/kf/checkpoint-public-keys');
    expect(environment).toMatch(/^KF_BACKUP_RECIPIENT_FILE=\/etc\/kf\//m);
    expect(environment).toMatch(/^KF_BACKUP_RETAIN_LOCAL=\d+$/m);
  });
});

describe('local plaintext does not accumulate forever', () => {
  it('prunes old backups that are safe off-site, and nothing the ledger names outside the root', () => {
    const tools = setup();
    const root = join(tools.work, 'backups');
    const old = join(root, '20260101T020000Z');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'dump.pgcustom'), 'old\n');
    writeFileSync(`${old}.tar.gpg`, 'old ciphertext\n');
    const elsewhere = join(tools.work, 'not-a-backup');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'keep'), 'keep\n');
    writeFileSync(join(tools.responses, 'prunable'), `${old}\n${elsewhere}\n`);

    const result = runScript(BACKUP, [join(root, '20260923T020000Z')], tools.env);
    expect(result.code, result.output).toBe(0);
    expect(existsSync(old), 'pruned backup still present').toBe(false);
    expect(existsSync(`${old}.tar.gpg`)).toBe(false);
    expect(existsSync(join(elsewhere, 'keep')), 'deleted a path outside the backup root').toBe(
      true,
    );
    expect(result.output).toContain('refusing to prune unexpected path');
    // Only runs the ledger says are off-site are ever offered for pruning.
    expect(tools.sqlLog()).toMatch(/select r\.location .*c\.offsite/);
  });

  it('refuses to start a backup the disk cannot hold', () => {
    const tools = setup();
    const result = runScript(BACKUP, [join(tools.work, 'backups', 'b')], {
      ...tools.env,
      KF_BACKUP_FREE_SPACE_RESERVE_BYTES: '999999999999999999',
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('bytes free');
    expect(tools.sqlLog()).not.toContain('pg_dump:');
  });
});
