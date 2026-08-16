import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

describe('preservation key custody deployment contract', () => {
  it('requires external signing and historical trust paths for backup and restore', () => {
    const backup = readFileSync(join(ROOT, 'deploy', 'systemd', 'kf-backup.service'), 'utf8');
    const restore = readFileSync(
      join(ROOT, 'deploy', 'systemd', 'kf-restore-drill.service'),
      'utf8',
    );
    const environment = readFileSync(join(ROOT, 'deploy', 'systemd', 'backup.env.example'), 'utf8');

    for (const unit of [backup, restore]) {
      expect(unit).toContain('EnvironmentFile=/etc/kf/backup.env');
      expect(unit).toContain('ExecStartPre=/usr/bin/test -s /etc/kf/preservation-manifest-key');
      expect(unit).toContain('ExecStartPre=/usr/bin/test -d /etc/kf/preservation-trust.d');
    }
    expect(backup).toContain('CHECKPOINT_PUBLIC_KEY_DIR=/etc/kf/checkpoint-public-keys');
    expect(environment).toContain('PRESERVATION_SIGNING_KEY_ID=replace-with-immutable-key-id');
    expect(environment).toContain(
      'PRESERVATION_SIGNING_KEY_PATH=/etc/kf/preservation-manifest-key',
    );
    expect(environment).toContain('PRESERVATION_TRUST_STORE_DIR=/etc/kf/preservation-trust.d');
    expect(restore).toContain(
      'ExecStartPre=/usr/bin/test -x /usr/local/libexec/kf-verify-object-store',
    );
    expect(environment).toContain(
      'KF_OBJECT_STORE_VERIFY_PROGRAM=/usr/local/libexec/kf-verify-object-store',
    );
    expect(environment).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
  });

  it('passes key custody paths explicitly and authenticates before using archived keys', () => {
    const backup = readFileSync(join(ROOT, 'scripts', 'backup.sh'), 'utf8');
    const restore = readFileSync(join(ROOT, 'scripts', 'restore-verify.sh'), 'utf8');

    expect(backup).toContain('--signing-key "$PRESERVATION_SIGNING_KEY_PATH"');
    expect(backup).toContain('--key-id "$PRESERVATION_SIGNING_KEY_ID"');
    expect(backup).toContain('--trust-store "$PRESERVATION_TRUST_STORE_DIR"');
    expect(backup).toContain('--checkpoint-public-key-dir "$CHECKPOINT_PUBLIC_KEY_DIR"');
    expect(backup).toContain('sign-backup "$DEST"');
    expect(backup).toContain('verify-backup "$DEST"');
    expect(restore).toContain('--stage "$VERIFIED_BACKUP"');
    const rootVerify = restore.indexOf('verify-backup "$BACKUP"');
    const stagedExportVerify = restore.indexOf('verify "$VERIFIED_BACKUP/export"');
    const stagedRoles = restore.indexOf('-f "$VERIFIED_BACKUP/roles.sql"');
    const stagedRestore = restore.indexOf('"$KF_PG_RESTORE" --dbname="$TARGET"');
    const archivedKeyUse = restore.indexOf('CHECKPOINT_PUBLIC_KEY_DIR="$ARCHIVED_CHECKPOINT_KEYS"');
    for (const marker of [
      rootVerify,
      stagedExportVerify,
      stagedRoles,
      stagedRestore,
      archivedKeyUse,
    ]) {
      expect(marker).toBeGreaterThanOrEqual(0);
    }
    expect(rootVerify).toBeLessThan(stagedRoles);
    expect(rootVerify).toBeLessThan(stagedRestore);
    expect(restore).not.toContain('-f "$BACKUP/roles.sql"');
    expect(restore).not.toContain('"$BACKUP/dump.pgcustom"');
    expect(stagedExportVerify).toBeLessThan(archivedKeyUse);
    expect(restore).toContain('--exclude=manifest.signature.json');
    expect(restore).toContain('OBJECT_STORE_VERIFIED=false');
    expect(restore).toContain('RESTORE PARTIAL:');
    expect(restore).toContain('if [ "$OUTCOME" != verified ]');
  });

  it('accepts database credentials only through owner-only files, never URL argv', () => {
    const restore = readFileSync(join(ROOT, 'scripts', 'restore-verify.sh'), 'utf8');
    const drill = readFileSync(join(ROOT, 'scripts', 'restore-drill.sh'), 'utf8');
    const documentation = readFileSync(
      join(ROOT, 'docs', 'backup-and-restore', 'README.md'),
      'utf8',
    );

    expect(restore).toContain('TARGET_URL_FILE="${2:');
    expect(restore).toContain('kf_read_secret_file "$TARGET_URL_FILE"');
    expect(restore).toContain('kf_read_secret_file "$LEDGER_URL_FILE"');
    expect(restore).not.toContain('<target-database-url>');
    expect(drill).toContain('"$RESTORE_TARGET_URL_FILE" "$RESTORE_LEDGER_URL_FILE"');
    expect(documentation).not.toContain('postgres://...target');
    expect(documentation).toContain('/proc/<pid>/cmdline');
  });

  it('holds one exported repeatable-read snapshot through every database artifact', () => {
    const backup = readFileSync(join(ROOT, 'scripts', 'backup.sh'), 'utf8');
    const databaseCommands = readFileSync(
      join(ROOT, 'packages', 'export', 'src', 'cli', 'database-commands.ts'),
      'utf8',
    );

    expect(backup).toContain('begin transaction isolation level repeatable read read only;');
    expect(backup).toContain('select pg_export_snapshot();');
    expect(backup.match(/--snapshot="\$SNAPSHOT_ID"/g)).toHaveLength(2);
    expect(backup).toContain('--snapshot "$SNAPSHOT_ID"');
    expect(backup.indexOf('select pg_export_snapshot();')).toBeLessThan(
      backup.indexOf('"$KF_PG_DUMP" --format=custom'),
    );
    expect(backup.indexOf('"$KF_PG_DUMP" --schema-only')).toBeLessThan(
      backup.lastIndexOf("printf 'rollback;"),
    );
    expect(backup).toContain('kf_at_exit snapshot_coordinator_cleanup');
    expect(databaseCommands).toContain('{ strictSnapshotToken: args.snapshotToken }');
  });

  it('publishes a backup only after staging bytes are durably flushed', () => {
    const backup = readFileSync(join(ROOT, 'scripts', 'backup.sh'), 'utf8');
    const staging = backup.indexOf('STAGING_DEST="$(mktemp -d');
    const dump = backup.indexOf('"$KF_PG_DUMP" --format=custom');
    const durable = backup.indexOf('sync -f "$STAGING_DEST"');
    const publish = backup.indexOf('mv -- "$STAGING_DEST" "$FINAL_DEST"');
    const parentDurable = backup.indexOf('sync -f "$DEST_PARENT"');
    const ledger = backup.indexOf('insert into ops.backup_run');
    for (const marker of [staging, dump, durable, publish, parentDurable, ledger]) {
      expect(marker).toBeGreaterThanOrEqual(0);
    }
    expect(staging).toBeLessThan(dump);
    expect(dump).toBeLessThan(durable);
    expect(durable).toBeLessThan(publish);
    expect(publish).toBeLessThan(parentDurable);
    expect(parentDurable).toBeLessThan(ledger);
  });

  it('flushes off-site transfer bytes before recording copy evidence', () => {
    const copy = readFileSync(join(ROOT, 'scripts', 'backup-offsite.sh'), 'utf8');
    expect(copy).toContain('rsync --archive --checksum --delete --delay-updates --fsync');
    expect(copy).toContain('sync -f -- "$DESTINATION/$NAME"');
    expect(copy).toContain('ssh "$REMOTE_HOST" "sync -f -- $REMOTE_DIRECTORY_QUOTED"');
    expect(copy.indexOf('sync -f -- "$DESTINATION/$NAME"')).toBeLessThan(
      copy.indexOf('insert into ops.backup_copy'),
    );
  });

  it('authenticates the complete off-site bundle and records the root manifest digest', () => {
    const copy = readFileSync(join(ROOT, 'scripts', 'backup-offsite.sh'), 'utf8');
    const sourceVerify = copy.indexOf('verify-backup "$LOCATION"');
    const localVerify = copy.indexOf('verify-backup "$DESTINATION/$NAME"');
    const localRootDigest = copy.indexOf('sha256sum "$DESTINATION/$NAME/backup.manifest.json"');
    const remoteRootDigest = copy.indexOf(
      'sha256sum $REMOTE_DIRECTORY_QUOTED/backup.manifest.json',
    );
    const remoteSignatureDigest = copy.indexOf(
      'sha256sum $REMOTE_DIRECTORY_QUOTED/backup.manifest.signature.json',
    );
    const remoteSumsDigest = copy.indexOf('sha256sum $REMOTE_DIRECTORY_QUOTED/SHA256SUMS');
    const insert = copy.indexOf('insert into ops.backup_copy');

    for (const marker of [
      sourceVerify,
      localVerify,
      localRootDigest,
      remoteRootDigest,
      remoteSignatureDigest,
      remoteSumsDigest,
      insert,
    ]) {
      expect(marker).toBeGreaterThanOrEqual(0);
    }
    expect(copy).toContain('--trust-store "$PRESERVATION_TRUST_STORE_DIR"');
    expect(copy).not.toContain('REMOTE_TRUST_STORE_QUOTED');
    expect(copy).not.toContain('REMOTE_ROOT_QUOTED');
    expect(copy).not.toContain('SOURCE_DIGEST="$(sha256sum "$LOCATION/SHA256SUMS"');
    expect(sourceVerify).toBeLessThan(localVerify);
    expect(localVerify).toBeLessThan(localRootDigest);
    expect(localRootDigest).toBeLessThan(insert);
    expect(remoteRootDigest).toBeLessThan(insert);
    expect(remoteSignatureDigest).toBeLessThan(insert);
    expect(remoteSumsDigest).toBeLessThan(insert);
    expect(copy).toContain('-v digest="$DIGEST"');
  });

  it('refuses to record an off-site copy when a destination sidecar is corrupted', () => {
    const work = mkdtempSync(join(tmpdir(), 'kf-offsite-sidecar-'));
    try {
      const backup = join(work, 'backup');
      const destination = join(work, 'destination');
      const bin = join(work, 'bin');
      const trust = join(work, 'trust');
      const recorded = join(work, 'recorded-copy');
      mkdirSync(backup);
      mkdirSync(destination);
      mkdirSync(bin);
      mkdirSync(trust);
      writeFileSync(join(backup, 'payload.txt'), 'payload\n');
      writeFileSync(join(backup, 'backup.manifest.json'), 'valid-root\n');
      writeFileSync(join(backup, 'backup.manifest.signature.json'), 'valid-signature\n');
      const payloadDigest = spawnSync('sha256sum', [join(backup, 'payload.txt')], {
        encoding: 'utf8',
      }).stdout.split(' ')[0]!;
      writeFileSync(join(backup, 'SHA256SUMS'), `${payloadDigest}  payload.txt\n`);
      const manifestDigest = spawnSync('sha256sum', [join(backup, 'backup.manifest.json')], {
        encoding: 'utf8',
      }).stdout.split(' ')[0]!;

      writeFileSync(
        join(bin, 'node'),
        `#!/usr/bin/env bash
set -euo pipefail
if [ "\${2:-}" != verify-backup ]; then
  echo "unexpected node invocation: $*" >&2
  exit 2
fi
dir="\${3:?missing backup directory}"
if ! grep -qx 'valid-root' "$dir/backup.manifest.json"; then
  echo "backup manifest corrupt at $dir" >&2
  exit 3
fi
if ! grep -qx 'valid-signature' "$dir/backup.manifest.signature.json"; then
  echo "backup manifest signature corrupt at $dir" >&2
  exit 4
fi
`,
        { mode: 0o700 },
      );
      writeFileSync(
        join(bin, 'rsync'),
        `#!/usr/bin/env bash
set -euo pipefail
src="\${@: -2:1}"
dst="\${@: -1}"
mkdir -p "$dst"
cp -a "$src". "$dst"
printf 'corrupt-signature\\n' > "$dst/backup.manifest.signature.json"
`,
        { mode: 0o700 },
      );
      writeFileSync(
        join(bin, 'psql'),
        `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = --version ]; then
  echo 'psql (PostgreSQL) 18.0'
  exit 0
fi
sql="$(cat)"
case "$sql" in
  *'select id, manifest_digest from ops.backup_run'*)
    printf '11111111-1111-4111-8111-111111111111\\t%s\\n' "$KF_TEST_MANIFEST_DIGEST"
    ;;
  *'insert into ops.backup_copy'*)
    printf 'inserted\\n' > "$KF_TEST_RECORDED_COPY"
    ;;
  *)
    echo "unexpected psql SQL: $sql" >&2
    exit 5
    ;;
esac
`,
        { mode: 0o700 },
      );
      for (const tool of ['pg_dump', 'pg_dumpall', 'pg_restore']) {
        writeFileSync(
          join(bin, tool),
          `#!/usr/bin/env bash
set -euo pipefail
echo '${tool} (PostgreSQL) 18.0'
`,
          { mode: 0o700 },
        );
      }

      const result = spawnSync(
        'bash',
        [join(ROOT, 'scripts', 'backup-offsite.sh'), backup, destination, 'sidecar-corrupt-test'],
        {
          cwd: ROOT,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            DATABASE_URL: 'postgres://kf@localhost/kf',
            KF_POSTGRES_CLIENT_DIR: bin,
            KF_TEST_MANIFEST_DIGEST: manifestDigest,
            KF_TEST_RECORDED_COPY: recorded,
            PRESERVATION_TRUST_STORE_DIR: trust,
          },
          encoding: 'utf8',
        },
      );

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('backup manifest signature corrupt');
      expect(existsSync(join(destination, 'backup', 'backup.manifest.signature.json'))).toBe(true);
      expect(existsSync(recorded), 'ops.backup_copy insert ran after failed verification').toBe(
        false,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('documents append-only external trust custody and forbids private-key backup', () => {
    const documentation = readFileSync(join(ROOT, 'deploy', 'systemd', 'README.md'), 'utf8');
    expect(documentation.replace(/\s+/g, ' ')).toContain('Treat that directory as append-only');
    expect(documentation).toContain(
      'The trust store is not bootstrapped from a preservation package',
    );
    expect(documentation).toContain('Checkpoint private keys are never copied');
    expect(documentation).toContain('backup.manifest.json');
  });
});
