// Root-only isolated PID 1 proof. Fixed callees are public fixtures, not preservation itself.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeDrillB2Bundle, receiveDrillB2Bundle } from './workstation-credentials.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [custody, ...extra] = process.argv.slice(2);
let executable;
let volatile;
const runtimes = [];
function run(command, args) {
  return spawnSync(command, args, {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 65536,
  });
}
try {
  assert.equal(process.getuid(), 0);
  assert.ok(custody && !extra.length);
  assert.equal(statfsSync('/run').type, 0x01021994);
  assert.equal(readFileSync('/proc/swaps', 'utf8').trim().split('\n').length, 1);
  const identity = run('/usr/bin/id', ['-u', 'kf-retrieval']);
  assert.equal(identity.status, 0);
  assert.ok(Number(identity.stdout.trim()) > 0);
  process.umask(0o022);
  executable = mkdtempSync('/opt/kf-preservation-binding-fixture-');
  chmodSync(executable, 0o755);
  volatile = mkdtempSync('/run/kf-preservation-binding-fixture-');
  chmodSync(volatile, 0o700);
  for (const path of [
    'scripts/deploy',
    'scripts/lib',
    'tools',
    'public/trust',
    'public/checkpoints',
  ])
    mkdirSync(join(executable, path), { recursive: true, mode: 0o755 });
  for (const path of [
    'scripts/deploy/preservation-consumer.sh',
    'scripts/lib/secret.sh',
    'scripts/lib/preservation-secrets.sh',
  ]) {
    copyFileSync(join(ROOT, path), join(executable, path));
    chmodSync(join(executable, path), 0o644);
  }
  const helper = join(executable, 'tools/kf-credential-custody');
  copyFileSync(custody, helper);
  chmodSync(helper, 0o755);
  for (const name of ['backup.sh', 'backup-offsite.sh', 'restore-drill.sh'])
    copyFileSync(
      join(ROOT, 'tests/fixtures/systemd-preservation-binding.sh'),
      join(executable, 'scripts', name),
    );
  writeFileSync(join(executable, 'public/recipient.asc'), 'public opaque recipient fixture\n', {
    mode: 0o644,
  });
  const values = {
    'database-url': 'public database fixture',
    'preservation-signing-key': 'public opaque signer',
    'backup-decryption-key': 'public opaque recovery',
    's3-secret-access-key': 'public object token',
    'b2-endpoint': 'https://s3.us-west-004.backblazeb2.com',
    'b2-bucket': 'public-bucket',
    'b2-key-id': 'public-key-id-123456',
    'b2-key': 'public-b2-token-123456',
    'index-key': '12'.repeat(32),
  };
  for (const [name, value] of Object.entries(values))
    writeFileSync(join(volatile, name), value, { mode: 0o400, flag: 'wx' });
  // Exercise the real publisher-to-PID 1 seam inside this owned public fixture.
  const readerBytes = encodeDrillB2Bundle({
    KF_DRILL_B2_APPLICATION_KEY_ID: 'public-drill-reader-id-123456',
    KF_DRILL_B2_APPLICATION_KEY: 'public-drill-reader-token-123456',
  });
  try {
    receiveDrillB2Bundle(
      readerBytes,
      volatile,
      0,
      readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
      readFileSync('/proc/swaps', 'utf8'),
    );
  } finally {
    readerBytes.fill(0);
  }
  const readerCurrent = join(volatile, 'kf-workstation-drill-b2-credentials/current');
  mkdirSync(join(volatile, 'backups'), { mode: 0o755 });
  for (const name of ['20261003T000001Z', '20261003T000002Z'])
    mkdirSync(join(volatile, 'backups', name), { mode: 0o755 });
  const legacy = join(executable, 'public/legacy.env');
  writeFileSync(
    legacy,
    'TMPDIR=/legacy/not-a-runtime\nPGPASSFILE=/legacy/not-a-password-file\nDATABASE_URL=public-inline-must-not-reach-child\nUNRELATED_SECRET=public-extra-must-not-reach-child\nPRESERVATION_SIGNING_KEY_PATH=/legacy/not-a-signer\nKF_DRILL_DECRYPTION_KEY_FILE=/legacy/not-a-recovery-key\nS3_SECRET_ACCESS_KEY_FILE=/legacy/not-an-object-key\nKF_B2_APPLICATION_KEY_FILE=/legacy/not-a-b2-key\n',
    { mode: 0o644 },
  );
  let sequence = 0;
  function prove(role, plant = 'valid', expectedStatus = 0, reason = '') {
    const unit = `${volatile.split('/').at(-1)}-${++sequence}`;
    const runtime = `${unit}-work`;
    runtimes.push(join('/run', runtime));
    let names =
      role === 'backup'
        ? ['database-url', 'preservation-signing-key']
        : role === 'offsite'
          ? ['database-url', 'b2-endpoint', 'b2-bucket', 'b2-key-id', 'b2-key']
          : [
              'database-url',
              'backup-decryption-key',
              's3-secret-access-key',
              'b2-endpoint',
              'b2-bucket',
              'b2-key-id',
              'b2-key',
            ];
    if (plant === 'missing') names = names.slice(1);
    if (plant === 'extra') names.push('index-key');
    const response = run('/usr/bin/systemd-run', [
      '--quiet',
      '--wait',
      '--pipe',
      '--collect',
      `--unit=${unit}`,
      '--property=User=kf-retrieval',
      '--property=Group=kf-retrieval',
      `--property=RuntimeDirectory=${runtime}`,
      `--property=RuntimeDirectoryMode=${plant === 'unsafe-runtime' ? '0755' : '0700'}`,
      '--property=RuntimeDirectoryPreserve=yes',
      `--property=EnvironmentFile=${legacy}`,
      '--property=NoNewPrivileges=true',
      '--property=PrivateTmp=true',
      '--property=PrivateNetwork=true',
      '--property=ProtectSystem=strict',
      '--property=ProtectHome=true',
      '--property=LimitCORE=0',
      '--property=MemorySwapMax=0',
      '--property=TemporaryFileSystem=/srv:ro',
      `--property=BindReadOnlyPaths=${join(volatile, 'backups')}:/srv/kf-backups`,
      '--property=TimeoutStartSec=45s',
      '--property=UMask=0077',
      '--setenv=KF_SECRET_CUSTODY=systemd',
      '--setenv=TMPDIR=/legacy/not-a-runtime',
      '--setenv=PGPASSFILE=/legacy/not-a-password-file',
      '--setenv=DATABASE_URL=public-inline-value-must-not-reach-child',
      '--setenv=UNRELATED_SECRET=public-extra-must-not-reach-child',
      '--setenv=PRESERVATION_SIGNING_KEY_PATH=/legacy/not-a-signer',
      '--setenv=KF_DRILL_DECRYPTION_KEY_FILE=/legacy/not-a-recovery-key',
      '--setenv=S3_SECRET_ACCESS_KEY_FILE=/legacy/not-an-object-key',
      '--setenv=KF_B2_APPLICATION_KEY_FILE=/legacy/not-a-b2-key',
      `--setenv=PRESERVATION_SIGNING_KEY_ID=${plant === 'child-failure' ? 'public-failure' : 'public-fixture'}`,
      `--setenv=PRESERVATION_TRUST_STORE_DIR=${join(executable, 'public/trust')}`,
      `--setenv=CHECKPOINT_PUBLIC_KEY_DIR=${join(executable, 'public/checkpoints')}`,
      `--setenv=KF_BACKUP_RECIPIENT_FILE=${join(executable, 'public/recipient.asc')}`,
      `--setenv=KF_OFFSITE_DESTINATION=${plant === 'redirect' ? 'elsewhere' : 'b2'}`,
      '--setenv=KF_OFFSITE_LABEL=public label with spaces',
      '--setenv=KF_DRILL_OFFSITE_SOURCE=b2',
      '--setenv=KF_DRILL_OFFSITE_LABEL=public-fixture',
      ...names.map((name) => {
        const source =
          role === 'drill' && plant !== 'reader-uploader' && ['b2-key-id', 'b2-key'].includes(name)
            ? join(readerCurrent, name)
            : join(volatile, name);
        return `--property=LoadCredential=${name}:${source}`;
      }),
      '/usr/bin/bash',
      join(executable, 'scripts/deploy/preservation-consumer.sh'),
      role,
    ]);
    assert.equal(response.status, expectedStatus, response.stdout + response.stderr);
    assert.equal(response.error, undefined);
    const runtimePath = join('/run', runtime);
    assert.equal(existsSync(runtimePath), true);
    assert.deepEqual(
      readdirSync(runtimePath),
      [],
      'owned password and key copies must be removed before PID 1 runtime deletion',
    );
    rmdirSync(runtimePath);
    if (expectedStatus === 0 || expectedStatus === 37)
      assert.equal(response.stdout, `public native binding ${role} PASS\n`);
    else {
      assert.equal(response.stdout, '');
      assert.ok(response.stderr.includes(reason), response.stderr);
    }
    process.stdout.write(`public binding ${role}/${plant} status=${response.status} PASS\n`);
  }
  for (const role of ['backup', 'offsite', 'drill']) {
    prove(role);
    prove(role, 'missing', 1, 'preservation credential set mismatch');
    prove(role, 'extra', 1, 'preservation credential set mismatch');
  }
  prove('offsite', 'redirect', 1, 'selected offsite binding requires B2');
  prove(
    'backup',
    'unsafe-runtime',
    1,
    'systemd custody requires a service-owned private tmpfs TMPDIR',
  );
  prove('backup', 'child-failure', 37);
  prove('drill', 'reader-uploader', 98, 'public callee refused uploader token for drill');
  chmodSync(join(executable, 'scripts/backup.sh'), 0o666);
  prove('backup', 'unsafe-callee', 1, 'preservation public routing is not root-protected');
  chmodSync(join(executable, 'scripts/backup.sh'), 0o644);
  prove('backup');
  process.stdout.write(
    'Scope: public PID 1 custody, fixed invocation and runtime cleanup; no SQL, provider, encryption, production role or recovery qualification.\n',
  );
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  for (const path of runtimes) {
    if (existsSync(path) && readdirSync(path).length === 0) rmdirSync(path);
    else if (existsSync(path)) process.stdout.write(`retained public runtime fixture: ${path}\n`);
  }
  if (volatile) rmSync(volatile, { recursive: true, force: true });
  if (executable) process.stdout.write(`public executable fixture: ${executable}\n`);
}
