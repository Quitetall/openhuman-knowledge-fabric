// Public root/mount-namespace proof, not provider capability or real key custody.
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
  parent = mkdtempSync('/run/kf-drill-b2-handoff-proof-');
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
    KF_PRESERVATION_SIGNING_KEY_BASE64: Buffer.from(
      generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
    ).toString('base64'),
    KF_BACKUP_RECOVERY_PRIVATE_KEY_BASE64: Buffer.from(
      '-----BEGIN PGP PRIVATE KEY BLOCK-----\npublic opaque armor\n-----END PGP PRIVATE KEY BLOCK-----\n',
    ).toString('base64'),
    KF_DRILL_S3_SECRET_ACCESS_KEY: 'public-object-token',
    KF_DRILL_B2_APPLICATION_KEY_ID: 'public-reader-id-123456',
    KF_DRILL_B2_APPLICATION_KEY: 'public-reader-token-123456',
  };
  const prior = [
    ['', 'kf-workstation-credentials'],
    ['Migration', 'kf-workstation-migration-credentials'],
    ['B2', 'kf-workstation-b2-credentials'],
    ['Backup', 'kf-workstation-backup-credentials'],
    ['Offsite', 'kf-workstation-offsite-credentials'],
    ['Drill', 'kf-workstation-drill-credentials'],
  ];
  const priorBytes = prior.map(([role]) => handoff['encode' + role + 'Bundle'](env));
  buffers.push(...priorBytes);
  prior.forEach(([role], i) =>
    handoff['receive' + role + 'Bundle'](priorBytes[i], parent, 0, boot, swaps),
  );
  const snapshot = () =>
    prior.map(([, name]) => {
      const root = join(parent, name);
      const current = readlinkSync(join(root, 'current'));
      const generation = join(root, current);
      return [
        current,
        readdirSync(generation)
          .sort()
          .map((file) => [file, readFileSync(join(generation, file), 'utf8')]),
      ];
    });
  const before = snapshot();
  phase = 'reader-source';
  const bytes = handoff.encodeDrillB2Bundle(env);
  buffers.push(bytes);
  assert.deepEqual(handoff.decodeDrillB2Bundle(bytes), [
    env.KF_DRILL_B2_APPLICATION_KEY_ID,
    env.KF_DRILL_B2_APPLICATION_KEY,
  ]);
  phase = 'reader-custody';
  assert.equal(handoff.receiveDrillB2Bundle(bytes, parent, 0, boot, swaps), 'ready');
  const root = join(parent, 'kf-workstation-drill-b2-credentials');
  const current = readlinkSync(join(root, 'current'));
  const generation = join(root, current);
  assert.deepEqual(readdirSync(generation).sort(), ['b2-key', 'b2-key-id', 'boot-id']);
  for (const path of [root, generation]) assert.equal(statSync(path).mode & 0o777, 0o700);
  for (const name of readdirSync(generation))
    assert.equal(statSync(join(generation, name)).mode & 0o777, 0o400);
  for (const other of priorBytes)
    assert.throws(() => handoff.receiveDrillB2Bundle(other, parent, 0, boot, swaps));
  for (const [role] of prior)
    assert.throws(() => handoff['receive' + role + 'Bundle'](bytes, parent, 0, boot, swaps));
  assert.equal(readlinkSync(join(root, 'current')), current);
  assert.throws(() => handoff.receiveDrillB2Bundle(bytes, parent, 1, boot, swaps));
  assert.throws(() =>
    handoff.receiveDrillB2Bundle(bytes, parent, 0, boot, swaps + '/swap file 1 0 -2\n'),
  );
  chmodSync(join(generation, 'b2-key'), 0o440);
  assert.throws(() => handoff.drillB2RuntimeStatus(parent, 0, boot, swaps));
  chmodSync(join(generation, 'b2-key'), 0o400);
  writeFileSync(join(generation, 'unexpected'), 'public extra field', { mode: 0o400 });
  assert.throws(() => handoff.drillB2RuntimeStatus(parent, 0, boot, swaps));
  unlinkSync(join(generation, 'unexpected'));
  const rotated = handoff.encodeDrillB2Bundle({
    ...env,
    KF_DRILL_B2_APPLICATION_KEY: 'public-rotated-reader-token',
  });
  buffers.push(rotated);
  handoff.receiveDrillB2Bundle(rotated, parent, 0, boot, swaps);
  assert.notEqual(readlinkSync(join(root, 'current')), current);
  assert.equal(handoff.drillB2RuntimeStatus(parent, 0, boot, swaps), 'ready');
  assert.deepEqual(snapshot(), before);

  const receiver = fileURLToPath(new URL('./workstation-credentials.mjs', import.meta.url));
  phase = 'reader-command';
  const result = spawnSync(
    '/usr/bin/unshare',
    [
      '--mount',
      '--propagation',
      'private',
      '/bin/sh',
      '-c',
      'set -eu; ulimit -c 0; mount -t tmpfs -o mode=0755 tmpfs /run; /usr/bin/node "$1" drill-b2-receive; /usr/bin/node "$1" drill-b2-status; test "$(find /run -mindepth 1 -maxdepth 1 -type d | wc -l)" = 1; test "$(find -L /run/kf-workstation-drill-b2-credentials/current -mindepth 1 -maxdepth 1 -type f | wc -l)" = 3',
      'kf-public-drill-b2-proof',
      receiver,
    ],
    {
      input: bytes,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 16384,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    },
  );
  assert.equal(result.status, 0);
  assert.equal(
    result.stdout,
    'kf-workstation-drill-b2-credentials-v1 ready\nkf-workstation-drill-b2-credentials-v1 ready\n',
  );
  assert.equal(result.stderr, '');
  phase = 'uploader-refusal';
  const refused = spawnSync(
    '/usr/bin/unshare',
    [
      '--mount',
      '--propagation',
      'private',
      '/bin/sh',
      '-c',
      'set -eu; ulimit -c 0; mount -t tmpfs -o mode=0755 tmpfs /run; if /usr/bin/node "$1" drill-b2-receive; then exit 2; fi; test "$(find /run -mindepth 1 -maxdepth 1 | wc -l)" = 0',
      'kf-public-drill-b2-refusal-proof',
      receiver,
    ],
    {
      input: priorBytes[2],
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 16384,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    },
  );
  assert.equal(refused.status, 0);
  assert.equal(refused.stdout, '');
  assert.equal(
    refused.stderr,
    'workstation credential handoff refused; inspect the host locally\n',
  );
  process.stdout.write(
    'public B2 drill-reader isolation, custody and private-namespace commands PASS\n',
  );
  process.stdout.write(
    'Scope: no real encrypted-store/SSH delivery, provider read-only permission, installed consumers or recovery qualification.\n',
  );
} catch (error) {
  // All values are public fixtures, but still expose no token contents or stack.
  process.stderr.write(
    `public B2 drill-reader proof failed at ${phase}: ${error.code || error.name}\n`,
  );
  process.exitCode = 1;
} finally {
  buffers.forEach((buffer) => buffer.fill(0));
  if (parent) rmSync(parent, { recursive: true, force: true });
}
