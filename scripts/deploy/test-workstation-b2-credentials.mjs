// Public native custody/command proof only; no provider, database or real credential access.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
import {
  encodeB2Bundle,
  encodeBundle,
  encodeMigrationBundle,
  b2RuntimeStatus,
  migrationRuntimeStatus,
  receiveB2Bundle,
  receiveBundle,
  receiveMigrationBundle,
  runtimeStatus,
} from './workstation-credentials.mjs';

function proof() {
  assert.equal(process.getuid(), 0, 'native proof requires root');
  const swaps = readFileSync('/proc/swaps', 'utf8');
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const parent = mkdtempSync('/run/kf-b2-handoff-proof-');
  const startup = encodeBundle({
    KF_ALERT_NTFY_URL: 'https://ntfy.sh/public-native-fixture',
    KF_ALERT_HEARTBEAT_URL: 'https://hc-ping.com/public-native-fixture',
    KF_RETRIEVAL_INDEX_KEY_HEX: '12'.repeat(32),
  });
  const migration = encodeMigrationBundle({
    KF_MIGRATOR_DATABASE_URL: 'postgres://kf_migrator:public-production@127.0.0.1:5432/kf',
    KF_REHEARSAL_DATABASE_URL:
      'postgres://kf_rehearsal:public-rehearsal@127.0.0.1:5433/kf_rehearsal',
    KF_REHEARSAL_RECEIPT_KEY_HEX: '34'.repeat(32),
  });
  const b2 = encodeB2Bundle({
    KF_B2_S3_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
    KF_B2_BUCKET_NAME: 'public-native-fixture',
    KF_B2_APPLICATION_KEY_ID: 'public-key-id-123456',
    KF_B2_APPLICATION_KEY: 'public-application-key-123456',
  });
  try {
    assert.equal(b2RuntimeStatus(parent, 0, boot, swaps), 'missing');
    receiveBundle(startup, parent, 0, boot, swaps);
    receiveMigrationBundle(migration, parent, 0, boot, swaps);
    const otherRoots = ['kf-workstation-credentials', 'kf-workstation-migration-credentials'].map(
      (name) => join(parent, name),
    );
    const otherBefore = otherRoots.map((path) => readlinkSync(join(path, 'current')));
    assert.equal(receiveB2Bundle(b2, parent, 0, boot, swaps), 'ready');
    const root = join(parent, 'kf-workstation-b2-credentials');
    const before = readlinkSync(join(root, 'current'));
    const generation = join(root, before);
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(statSync(generation).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(generation).sort(), [
      'b2-bucket',
      'b2-endpoint',
      'b2-key',
      'b2-key-id',
      'boot-id',
    ]);
    for (const name of readdirSync(generation)) {
      assert.equal(statSync(join(generation, name)).mode & 0o777, 0o400);
    }
    assert.equal(readFileSync(join(generation, 'b2-key'), 'utf8'), 'public-application-key-123456');
    for (const other of [startup, migration]) {
      assert.throws(() => receiveB2Bundle(other, parent, 0, boot, swaps));
    }
    assert.throws(() => receiveBundle(b2, parent, 0, boot, swaps));
    assert.throws(() => receiveMigrationBundle(b2, parent, 0, boot, swaps));
    assert.throws(() => receiveB2Bundle(b2, parent, 1, boot, swaps));
    assert.throws(() => receiveB2Bundle(b2, parent, 0, boot, swaps + '/swap file 1 0 -2\n'));
    const nextBoot = boot.endsWith('0') ? boot.slice(0, -1) + '1' : boot.slice(0, -1) + '0';
    assert.throws(() => b2RuntimeStatus(parent, 0, nextBoot, swaps));
    const keyPath = join(generation, 'b2-key');
    chmodSync(keyPath, 0o440);
    assert.throws(() => b2RuntimeStatus(parent, 0, boot, swaps));
    chmodSync(keyPath, 0o400);
    assert.equal(readlinkSync(join(root, 'current')), before);
    assert.deepEqual(
      otherRoots.map((path) => readlinkSync(join(path, 'current'))),
      otherBefore,
    );
    assert.equal(runtimeStatus(parent, 0, boot, swaps), 'ready');
    assert.equal(migrationRuntimeStatus(parent, 0, boot, swaps), 'ready');
    assert.equal(b2RuntimeStatus(parent, 0, boot, swaps), 'ready');

    // A private mount namespace shadows /run for this child only. Test production
    // command verbs without installing a public fixture into the real B2 realm.
    const receiver = fileURLToPath(new URL('./workstation-credentials.mjs', import.meta.url));
    const result = spawnSync(
      '/usr/bin/unshare',
      [
        '--mount',
        '--propagation',
        'private',
        '/bin/sh',
        '-c',
        'set -eu; ulimit -c 0; mount -t tmpfs -o mode=0755 tmpfs /run; /usr/bin/node "$1" b2-receive; /usr/bin/node "$1" b2-status; test ! -e /run/kf-workstation-credentials; test ! -e /run/kf-workstation-migration-credentials',
        'kf-public-b2-command-proof',
        receiver,
      ],
      {
        input: b2,
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 16_384,
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      },
    );
    assert.equal(result.status, 0);
    assert.equal(
      result.stdout,
      'kf-workstation-b2-credentials-v1 ready\nkf-workstation-b2-credentials-v1 ready\n',
    );
    assert.equal(result.stderr, '');
  } finally {
    for (const bytes of [startup, migration, b2]) bytes.fill(0);
    rmSync(parent, { recursive: true, force: true });
  }
  process.stdout.write('public native B2 handoff and isolated command proof passed\n');
}

try {
  proof();
} catch {
  process.stderr.write('public native B2 handoff and isolated command proof failed\n');
  process.exitCode = 1;
}
