// Public native custody proof only; no database connection, real credential or application change.
import assert from 'node:assert/strict';
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
import {
  encodeBundle,
  encodeMigrationBundle,
  migrationRuntimeStatus,
  receiveBundle,
  receiveMigrationBundle,
  runtimeStatus,
} from './workstation-credentials.mjs';

function proof() {
  assert.equal(process.getuid(), 0, 'native proof requires root');
  const swaps = readFileSync('/proc/swaps', 'utf8');
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const parent = mkdtempSync('/run/kf-migration-handoff-proof-');
  const startup = encodeBundle({
    KF_ALERT_NTFY_URL: 'https://ntfy.sh/public-native-fixture',
    KF_ALERT_HEARTBEAT_URL: 'https://hc-ping.com/public-native-fixture',
    KF_RETRIEVAL_INDEX_KEY_HEX: '12'.repeat(32),
  });
  const migration = encodeMigrationBundle({
    KF_MIGRATOR_DATABASE_URL:
      'postgres://kf_migrator_login:public-production@127.0.0.1:5432/kf?sslmode=disable',
    KF_REHEARSAL_DATABASE_URL:
      'postgresql://kf_rehearsal_migrator:public-rehearsal@127.0.0.1:5433/kf_rehearsal_fixture',
    KF_REHEARSAL_RECEIPT_KEY_HEX: '34'.repeat(32),
  });
  try {
    assert.equal(migrationRuntimeStatus(parent, 0, boot, swaps), 'missing');
    assert.equal(receiveBundle(startup, parent, 0, boot, swaps), 'ready');
    const startupRoot = join(parent, 'kf-workstation-credentials');
    const beforeStartup = readlinkSync(join(startupRoot, 'current'));
    assert.equal(receiveMigrationBundle(migration, parent, 0, boot, swaps), 'ready');
    const root = join(parent, 'kf-workstation-migration-credentials');
    const before = readlinkSync(join(root, 'current'));
    const generation = join(root, before);
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(statSync(generation).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(generation).sort(), [
      'boot-id',
      'database-url',
      'rehearsal-database-url',
      'rehearsal-receipt-key',
    ]);
    for (const name of readdirSync(generation)) {
      assert.equal(statSync(join(generation, name)).mode & 0o777, 0o400);
    }
    assert.equal(readFileSync(join(generation, 'rehearsal-receipt-key'), 'utf8'), '34'.repeat(32));
    assert.throws(() => receiveMigrationBundle(startup, parent, 0, boot, swaps));
    assert.throws(() => receiveBundle(migration, parent, 0, boot, swaps));
    assert.throws(() => receiveMigrationBundle(migration, parent, 1, boot, swaps));
    assert.throws(() =>
      receiveMigrationBundle(migration, parent, 0, boot, swaps + '/swap file 1 0 -2\n'),
    );
    const nextBoot = boot.endsWith('0') ? boot.slice(0, -1) + '1' : boot.slice(0, -1) + '0';
    assert.throws(() => migrationRuntimeStatus(parent, 0, nextBoot, swaps));
    const keyPath = join(generation, 'rehearsal-receipt-key');
    chmodSync(keyPath, 0o440);
    assert.throws(() => migrationRuntimeStatus(parent, 0, boot, swaps));
    chmodSync(keyPath, 0o400);
    assert.equal(readlinkSync(join(root, 'current')), before);
    assert.equal(readlinkSync(join(startupRoot, 'current')), beforeStartup);
    assert.equal(runtimeStatus(parent, 0, boot, swaps), 'ready');
    assert.equal(migrationRuntimeStatus(parent, 0, boot, swaps), 'ready');
  } finally {
    startup.fill(0);
    migration.fill(0);
    rmSync(parent, { recursive: true, force: true });
  }
  process.stdout.write('public native migration handoff proof passed\n');
}

try {
  proof();
} catch {
  process.stderr.write('public native migration handoff proof failed\n');
  process.exitCode = 1;
}
