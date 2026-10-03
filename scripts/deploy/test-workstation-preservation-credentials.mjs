// Public native role/custody/command proof, not real keys, provider access or authorization.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as handoff from './workstation-credentials.mjs';

function proof() {
  assert.equal(process.getuid(), 0);
  const swaps = readFileSync('/proc/swaps', 'utf8');
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const parent = mkdtempSync('/run/kf-preservation-handoff-proof-');
  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  const prefix = '-----BEGIN PGP PRIVATE KEY BLOCK-----\n';
  const suffix = '\n-----END PGP PRIVATE KEY BLOCK-----\n';
  // Deliberately opaque, invalid-GPG public armor. Exercise the actual maximum
  // input through the CLI without generating or installing a recovery key.
  const armor = prefix + 'A'.repeat(65536 - prefix.length - suffix.length) + suffix;
  const env = {
    KF_BACKUP_DATABASE_URL: 'postgres://backup_fixture:public-backup@127.0.0.1:5432/kf',
    KF_OFFSITE_DATABASE_URL: 'postgres://offsite_fixture:public-offsite@127.0.0.1:5432/kf',
    KF_DRILL_DATABASE_URL: 'postgres://drill_fixture:public-drill@127.0.0.1:5432/kf',
    KF_PRESERVATION_SIGNING_KEY_BASE64: Buffer.from(pem).toString('base64'),
    KF_BACKUP_RECOVERY_PRIVATE_KEY_BASE64: Buffer.from(armor).toString('base64'),
    KF_DRILL_S3_SECRET_ACCESS_KEY: 'public-object-reader-key',
  };
  const roles = ['Backup', 'Offsite', 'Drill'];
  const oldRoles = ['', 'Migration', 'B2'];
  const bytes = roles.map((role) => handoff['encode' + role + 'Bundle'](env));
  const oldBytes = [
    handoff.encodeBundle({
      KF_ALERT_NTFY_URL: 'https://ntfy.sh/public',
      KF_ALERT_HEARTBEAT_URL: 'https://hc-ping.com/public',
      KF_RETRIEVAL_INDEX_KEY_HEX: '12'.repeat(32),
    }),
    handoff.encodeMigrationBundle({
      KF_MIGRATOR_DATABASE_URL: 'postgres://migrator:public-prod@127.0.0.1:5432/kf',
      KF_REHEARSAL_DATABASE_URL: 'postgres://rehearsal:public-test@127.0.0.1:5433/kf_rehearsal',
      KF_REHEARSAL_RECEIPT_KEY_HEX: '34'.repeat(32),
    }),
    handoff.encodeB2Bundle({
      KF_B2_S3_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
      KF_B2_BUCKET_NAME: 'public-fixture',
      KF_B2_APPLICATION_KEY_ID: 'public-id-1234567',
      KF_B2_APPLICATION_KEY: 'public-key-123456',
    }),
  ];
  const oldRoots = [
    'kf-workstation-credentials',
    'kf-workstation-migration-credentials',
    'kf-workstation-b2-credentials',
  ].map((name) => join(parent, name));
  try {
    oldRoles.forEach((role, i) =>
      handoff['receive' + role + 'Bundle'](oldBytes[i], parent, 0, boot, swaps),
    );
    const oldBefore = oldRoots.map((root) => readlinkSync(join(root, 'current')));
    roles.forEach((role, i) => {
      const receive = handoff['receive' + role + 'Bundle'];
      const status = handoff[role.toLowerCase() + 'RuntimeStatus'];
      assert.equal(receive(bytes[i], parent, 0, boot, swaps), 'ready');
      const root = join(parent, 'kf-workstation-' + role.toLowerCase() + '-credentials');
      const before = readlinkSync(join(root, 'current'));
      const generation = join(root, before);
      const names = [
        ['database-url', 'preservation-signing-key'],
        ['database-url'],
        ['database-url', 'backup-decryption-key', 's3-secret-access-key'],
      ][i];
      assert.deepEqual(readdirSync(generation).sort(), [...names, 'boot-id'].sort());
      for (const dir of [root, generation]) assert.equal(statSync(dir).mode & 0o777, 0o700);
      names.forEach((name) => assert.equal(statSync(join(generation, name)).mode & 0o777, 0o400));
      for (const other of [...oldBytes, ...bytes.filter((_, j) => j !== i)])
        assert.throws(() => receive(other, parent, 0, boot, swaps));
      assert.equal(readlinkSync(join(root, 'current')), before);
      assert.throws(() => receive(bytes[i], parent, 1, boot, swaps));
      assert.throws(() => receive(bytes[i], parent, 0, boot, swaps + '/swap file 1 0 -2\n'));
      chmodSync(join(generation, 'database-url'), 0o440);
      assert.throws(() => status(parent, 0, boot, swaps));
      chmodSync(join(generation, 'database-url'), 0o400);
      assert.equal(status(parent, 0, boot, swaps), 'ready');

      // Each command test gets a fresh private mount namespace. The real roots
      // are never modified, even when receive/status are invoked as root.
      const lower = role.toLowerCase();
      const receiver = fileURLToPath(new URL('./workstation-credentials.mjs', import.meta.url));
      const result = spawnSync(
        '/usr/bin/unshare',
        [
          '--mount',
          '--propagation',
          'private',
          '/bin/sh',
          '-c',
          'set -eu; ulimit -c 0; mount -t tmpfs -o mode=0755 tmpfs /run; /usr/bin/node "$1" "$2-receive"; /usr/bin/node "$1" "$2-status"; test "$(find /run -mindepth 1 -maxdepth 1 -type d | wc -l)" = 1',
          'kf-public-preservation-command-proof',
          receiver,
          lower,
        ],
        {
          input: bytes[i],
          encoding: 'utf8',
          timeout: 15000,
          maxBuffer: 16384,
          env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        },
      );
      assert.equal(result.status, 0);
      assert.equal(
        result.stdout,
        `kf-workstation-${lower}-credentials-v1 ready\nkf-workstation-${lower}-credentials-v1 ready\n`,
      );
      assert.equal(result.stderr, '');
    });
    assert.deepEqual(
      oldRoots.map((root) => readlinkSync(join(root, 'current'))),
      oldBefore,
    );
    assert.equal(handoff.runtimeStatus(parent, 0, boot, swaps), 'ready');
    assert.equal(handoff.migrationRuntimeStatus(parent, 0, boot, swaps), 'ready');
    assert.equal(handoff.b2RuntimeStatus(parent, 0, boot, swaps), 'ready');
  } finally {
    [...bytes, ...oldBytes].forEach((buffer) => buffer.fill(0));
    rmSync(parent, { recursive: true, force: true });
  }
  process.stdout.write('public native preservation role custody and isolated commands passed\n');
}

try {
  proof();
} catch {
  process.stderr.write('public native preservation role custody and isolated commands failed\n');
  process.exitCode = 1;
}
