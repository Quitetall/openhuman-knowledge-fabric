// Public root/custody/namespace proof, not real logins, signing authority or commissioning.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as handoff from './workstation-credentials.mjs';

let parent;
let phase = 'admission';
const buffers = [];
try {
  assert.equal(process.getuid(), 0);
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const swaps = readFileSync('/proc/swaps', 'utf8');
  parent = mkdtempSync('/run/kf-application-handoff-proof-');
  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  const env = {
    KF_ALERT_NTFY_URL: 'https://ntfy.sh/public-fixture',
    KF_ALERT_HEARTBEAT_URL: 'https://hc-ping.com/public-fixture',
    KF_RETRIEVAL_INDEX_KEY_HEX: '12'.repeat(32),
    KF_MIGRATOR_DATABASE_URL: 'postgres://migrator:public-prod@127.0.0.1:5432/kf',
    KF_REHEARSAL_DATABASE_URL: 'postgres://rehearsal:public-test@127.0.0.1:5433/kf_rehearsal',
    KF_REHEARSAL_RECEIPT_KEY_HEX: '34'.repeat(32),
    KF_B2_S3_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
    KF_B2_BUCKET_NAME: 'public-fixture-bucket',
    KF_B2_APPLICATION_KEY_ID: 'public-uploader-id-123456',
    KF_B2_APPLICATION_KEY: 'public-uploader-token-123456',
    KF_BACKUP_DATABASE_URL: 'postgres://backup_fixture:public-backup@127.0.0.1:5432/kf',
    KF_OFFSITE_DATABASE_URL: 'postgres://offsite_fixture:public-offsite@127.0.0.1:5432/kf',
    KF_DRILL_DATABASE_URL: 'postgres://drill_fixture:public-drill@127.0.0.1:5432/kf',
    KF_PRESERVATION_SIGNING_KEY_BASE64: Buffer.from(pem).toString('base64'),
    KF_BACKUP_RECOVERY_PRIVATE_KEY_BASE64: Buffer.from(
      '-----BEGIN PGP PRIVATE KEY BLOCK-----\npublic opaque armor\n-----END PGP PRIVATE KEY BLOCK-----\n',
    ).toString('base64'),
    KF_DRILL_S3_SECRET_ACCESS_KEY: 'public-object-token',
    KF_DRILL_B2_APPLICATION_KEY_ID: 'public-reader-id-123456',
    KF_DRILL_B2_APPLICATION_KEY: 'public-reader-token-123456',
  };
  const roles = ['api', 'worker', 'attestor', 'checkpoint', 'storage', 'readiness'];
  const names = [
    [
      'database-url',
      's3-secret-access-key',
      's3-durable-secret-access-key',
      'readiness-token',
      'master-record-link-secret',
    ],
    ['database-url', 's3-secret-access-key'],
    ['database-url'],
    ['database-url', 'checkpoint-signing-key', 's3-secret-access-key'],
    ['database-url', 's3-secret-access-key', 's3-durable-secret-access-key'],
    ['database-url'],
  ];
  // Maximum admitted fields exercise payloads larger than the old 16-KiB realm limit.
  const route = 'postgres://fixture:public@127.0.0.1:5432/kf';
  roles.forEach((role) => {
    const prefix = `KF_${role.toUpperCase()}_`;
    env[prefix + 'DATABASE_URL'] = route.replace('public', 'a'.repeat(8192 - route.length + 6));
    env[prefix + 'S3_SECRET_ACCESS_KEY'] = 'b'.repeat(8192);
    env[prefix + 'S3_DURABLE_SECRET_ACCESS_KEY'] = 'c'.repeat(8192);
    env[prefix + 'READINESS_TOKEN'] = 'd'.repeat(8192);
    env[prefix + 'MASTER_RECORD_LINK_SECRET'] = 'e'.repeat(8192);
    env[prefix + 'SIGNING_KEY_BASE64'] = Buffer.from(pem).toString('base64');
  });
  const prior = [
    ['', 'kf-workstation-credentials'],
    ['Migration', 'kf-workstation-migration-credentials'],
    ['B2', 'kf-workstation-b2-credentials'],
    ['Backup', 'kf-workstation-backup-credentials'],
    ['Offsite', 'kf-workstation-offsite-credentials'],
    ['Drill', 'kf-workstation-drill-credentials'],
    ['DrillB2', 'kf-workstation-drill-b2-credentials'],
  ];
  const priorBytes = prior.map(([role]) => handoff['encode' + role + 'Bundle'](env));
  const bytes = roles.map((role) => handoff.encodeApplicationBundle(role, env));
  buffers.push(...priorBytes, ...bytes);
  const roots = roles.map((role) => join(parent, `kf-workstation-application-${role}-credentials`));
  const snapshot = (paths) =>
    paths.map((root) => {
      const current = readlinkSync(join(root, 'current'));
      const generation = join(root, current);
      return [
        current,
        readdirSync(generation)
          .sort()
          .map((name) => [name, readFileSync(join(generation, name), 'utf8')]),
      ];
    });
  prior.forEach(([role], i) =>
    handoff['receive' + role + 'Bundle'](priorBytes[i], parent, 0, boot, swaps),
  );
  const oldRoots = prior.map(([, name]) => join(parent, name));
  const oldBefore = snapshot(oldRoots);
  roles.forEach((role, i) => {
    phase = `${role}-custody`;
    assert.throws(() => handoff.receiveApplicationBundle(role, bytes[i], parent, 1, boot, swaps));
    assert.throws(() =>
      handoff.receiveApplicationBundle(
        role,
        bytes[i],
        parent,
        0,
        boot,
        swaps + '/swap file 1 0 -2\n',
      ),
    );
    assert.equal(existsSync(roots[i]), false);
    assert.equal(handoff.receiveApplicationBundle(role, bytes[i], parent, 0, boot, swaps), 'ready');
    const current = readlinkSync(join(roots[i], 'current'));
    const generation = join(roots[i], current);
    assert.deepEqual(readdirSync(generation).sort(), [...names[i], 'boot-id'].sort());
    for (const path of [roots[i], generation]) assert.equal(statSync(path).mode & 0o777, 0o700);
    for (const name of readdirSync(generation)) {
      const path = join(generation, name);
      assert.equal(statSync(path).uid, 0);
      assert.equal(statSync(path).mode & 0o777, 0o400);
      assert.equal(statSync(path).nlink, 1);
    }
    for (const other of [...priorBytes, ...bytes.filter((_, j) => i !== j)])
      assert.throws(() => handoff.receiveApplicationBundle(role, other, parent, 0, boot, swaps));
    for (const [other] of prior)
      assert.throws(() => handoff['decode' + other + 'Bundle'](bytes[i]));
    assert.equal(readlinkSync(join(roots[i], 'current')), current);
    const status = () => handoff.applicationRuntimeStatus(role, parent, 0, boot, swaps);
    chmodSync(join(generation, 'database-url'), 0o440);
    assert.throws(status);
    chmodSync(join(generation, 'database-url'), 0o400);
    writeFileSync(join(generation, 'unexpected'), 'public extra field', { mode: 0o400 });
    assert.throws(status);
    unlinkSync(join(generation, 'unexpected'));
    assert.equal(status(), 'ready');
  });
  roles.forEach((role, i) => {
    phase = `${role}-rotation`;
    const before = snapshot(roots);
    handoff.receiveApplicationBundle(role, bytes[i], parent, 0, boot, swaps);
    const after = snapshot(roots);
    after.forEach((value, j) =>
      j === i ? assert.notEqual(value[0], before[j][0]) : assert.deepEqual(value, before[j]),
    );
    assert.deepEqual(snapshot(oldRoots), oldBefore);

    // CLI writes occur only in a private /run mount, never the selected host's real roots.
    phase = `${role}-command`;
    const receiver = fileURLToPath(new URL('./workstation-credentials.mjs', import.meta.url));
    const command = (input, refuse) =>
      spawnSync(
        '/usr/bin/unshare',
        [
          '--mount',
          '--propagation',
          'private',
          '/bin/sh',
          '-c',
          refuse
            ? 'set -eu; ulimit -c 0; mount -t tmpfs -o mode=0755 tmpfs /run; if /usr/bin/node "$1" "application-$2-receive"; then exit 2; fi; test "$(find /run -mindepth 1 -maxdepth 1 | wc -l)" = 0'
            : 'set -eu; ulimit -c 0; mount -t tmpfs -o mode=0755 tmpfs /run; /usr/bin/node "$1" "application-$2-receive"; /usr/bin/node "$1" "application-$2-status"; test "$(find /run -mindepth 1 -maxdepth 1 | wc -l)" = 1; test "$(find -L "/run/kf-workstation-application-$2-credentials/current" -mindepth 1 -maxdepth 1 -type f | wc -l)" = "$3"',
          'kf-public-application-proof',
          receiver,
          role,
          String(names[i].length + 1),
        ],
        {
          input,
          encoding: 'utf8',
          timeout: 15000,
          maxBuffer: 16384,
          env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        },
      );
    const result = command(bytes[i], false);
    assert.equal(result.status, 0);
    assert.equal(
      result.stdout,
      `kf-workstation-application-${role}-credentials-v1 ready\nkf-workstation-application-${role}-credentials-v1 ready\n`,
    );
    assert.equal(result.stderr, '');
    const refused = command(bytes[(i + 1) % roles.length], true);
    assert.equal(refused.status, 0);
    assert.equal(refused.stdout, '');
    assert.equal(
      refused.stderr,
      'workstation credential handoff refused; inspect the host locally\n',
    );
  });
  process.stdout.write(
    'public six-role application custody, isolation, rotation and private-namespace commands PASS\n',
  );
  process.stdout.write(
    'Scope: no real encrypted-store/SSH delivery, consumer startup, database/provider grants, signing authority or host qualification.\n',
  );
} catch (error) {
  process.stderr.write(
    `public application credential proof failed at ${phase}: ${error.code || error.name}\n`,
  );
  process.exitCode = 1;
} finally {
  buffers.forEach((buffer) => buffer.fill(0));
  if (parent) rmSync(parent, { recursive: true, force: true });
}
