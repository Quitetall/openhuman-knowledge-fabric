import { readFileSync } from 'node:fs';
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
      expect(unit).toContain('ExecStartPre=/usr/bin/test -d /etc/kf/preservation-trust.d');
    }
    // Only the backup SIGNS. The drill verifies the backup's signature against the trust store
    // and signs its throwaway re-export with a key made for the run, so it never names — and,
    // as kf-drill, cannot read — the preservation private key.
    expect(backup).toContain(
      'ExecStartPre=/usr/bin/test -s /etc/kf/backup/preservation-manifest-key',
    );
    expect(restore).not.toContain('preservation-manifest-key');
    expect(backup).toContain('CHECKPOINT_PUBLIC_KEY_DIR=/etc/kf/checkpoint-public-keys');
    expect(environment).toContain('PRESERVATION_SIGNING_KEY_ID=replace-with-immutable-key-id');
    expect(environment).toContain(
      'PRESERVATION_SIGNING_KEY_PATH=/etc/kf/backup/preservation-manifest-key',
    );
    expect(environment).toContain('PRESERVATION_TRUST_STORE_DIR=/etc/kf/preservation-trust.d');
    // The object-store verifier ships in the release; a host-supplied program is an override,
    // not a prerequisite, so the drill no longer refuses to start without one.
    expect(restore).not.toContain('/usr/local/libexec/kf-verify-object-store');
    expect(restore).toContain('EnvironmentFile=/etc/kf/drill.env');
    expect(restore).toContain(
      'Environment=S3_SECRET_ACCESS_KEY_FILE=/etc/kf/drill/s3-secret-access-key',
    );
    expect(environment).toMatch(
      /^# KF_OBJECT_STORE_VERIFY_PROGRAM=\/usr\/local\/libexec\/kf-verify-object-store$/m,
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
    expect(copy).toContain('rsync --checksum --times --fsync');
    expect(copy).toContain('sync -f -- "$DESTINATION/$NAME.tar.gpg"');
    expect(copy).toContain('ssh "$REMOTE_HOST" "sync -f -- $REMOTE_DIRECTORY_QUOTED"');
    expect(copy.indexOf('sync -f -- "$DESTINATION/$NAME.tar.gpg"')).toBeLessThan(
      copy.indexOf('insert into ops.backup_copy'),
    );
  });

  it('authenticates the source, ships only ciphertext, and re-measures it at the destination', () => {
    const copy = readFileSync(join(ROOT, 'scripts', 'backup-offsite.sh'), 'utf8');
    const sourceVerify = copy.indexOf('verify-backup "$LOCATION"');
    const ledgerCheck = copy.indexOf('"$SOURCE_MANIFEST_DIGEST" != "$RUN_MANIFEST_DIGEST"');
    const transfer = copy.indexOf('rsync --checksum');
    const localDigest = copy.indexOf('sha256sum -- "$DESTINATION/$NAME.tar.gpg"');
    const remoteDigest = copy.indexOf('sha256sum -- $REMOTE_FILE_QUOTED');
    const compare = copy.indexOf('"$DESTINATION_DIGEST" != "$CIPHERTEXT_DIGEST"');
    const insert = copy.indexOf('insert into ops.backup_copy');
    for (const marker of [
      sourceVerify,
      ledgerCheck,
      transfer,
      localDigest,
      remoteDigest,
      compare,
      insert,
    ]) {
      expect(marker).toBeGreaterThanOrEqual(0);
    }
    expect(sourceVerify).toBeLessThan(transfer);
    expect(ledgerCheck).toBeLessThan(transfer);
    expect(localDigest).toBeLessThan(compare);
    expect(remoteDigest).toBeLessThan(compare);
    expect(compare).toBeLessThan(insert);
    // The plaintext directory is never a transfer source.
    expect(copy).not.toContain('"$LOCATION/" "$DESTINATION/$NAME/"');
    expect(copy).toContain('-- "$CIPHERTEXT" "$DESTINATION/$NAME.tar.gpg"');
    expect(copy).toContain('-v digest="$RUN_MANIFEST_DIGEST"');
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
