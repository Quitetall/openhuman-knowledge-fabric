// Public fixed-program fixture proof: native custody/launch, not real application commissioning.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationCredentialBindings } from './workstation-credentials.mjs';

const [release, ...extra] = process.argv.slice(2);
const environment = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
const source = dirname(fileURLToPath(import.meta.url));
const roles = ['api', 'worker', 'attestor', 'checkpoint', 'storage', 'readiness'];
let phase = 'admission';
function command(executable, args) {
  return spawnSync(executable, args, {
    cwd: '/',
    env: environment,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 65536,
  });
}
function checked(executable, args) {
  const result = command(executable, args);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  return result.stdout;
}
try {
  assert.equal(process.getuid(), 0);
  assert(release && isAbsolute(release) && extra.length === 0);
  assert.match(
    readFileSync('/proc/swaps', 'utf8').trim(),
    /^Filename\s+Type\s+Size\s+Used\s+Priority$/,
  );
  // Fixed runtime names must be unowned before the proof; never borrow a running consumer's.
  for (const role of roles) assert(!existsSync(`/run/kf-${role}-work`));
  assert(!existsSync('/run/kf-attestor'));
  process.umask(0o022);
  const root = mkdtempSync('/opt/kf-application-consumer-fixture-');
  chmodSync(root, 0o755);
  const inputs = mkdtempSync('/run/kf-application-consumer-inputs-');
  chmodSync(inputs, 0o700);
  const runId = inputs.split('-').at(-1);
  const directory = (path) => mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const copy = (from, to) => {
    directory(to);
    copyFileSync(from, to);
    chmodSync(to, 0o644);
  };
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n', { flag: 'wx', mode: 0o644 });
  for (const name of [
    'application-consumer.mjs',
    'workstation-credentials.mjs',
    'internal/application-consumer-plan.mjs',
  ])
    copy(join(source, name), join(root, 'scripts/deploy', name));
  for (const name of ['secrets.js', 'internal/native-secret.js'])
    copy(
      join(release, 'packages/operations/dist', name),
      join(root, 'packages/operations/dist', name),
    );
  copy(join(release, 'tools/kf-credential-custody'), join(root, 'tools/kf-credential-custody'));
  chmodSync(join(root, 'tools/kf-credential-custody'), 0o755);
  mkdirSync(join(root, 'public-keys'), { mode: 0o755 });
  const entries = [
    'apps/api/dist/server.js',
    'apps/worker/dist/main.js',
    'apps/attestor/dist/main.js',
    'apps/checkpoint/dist/main.js',
    'apps/kf-storage/dist/main.js',
    'packages/operations/dist/cli.js',
  ];
  const publicEnv = {
    KF_SECRET_CUSTODY: 'systemd',
    OIDC_ISSUER: 'https://identity.example/realm',
    OIDC_AUDIENCE: 'kf',
    OIDC_JWKS_URI: 'https://identity.example/keys',
    S3_ENDPOINT: 'http://127.0.0.1:9000',
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY_ID: 'public-working',
    S3_BUCKET_ARTIFACTS: 'public-working',
    S3_DURABLE_ENDPOINT: 'https://durable.example',
    S3_DURABLE_REGION: 'us-east-1',
    S3_DURABLE_ACCESS_KEY_ID: 'public-durable',
    S3_DURABLE_BUCKET: 'public-durable',
    CHECKPOINT_SIGNING_KEY_ID: 'public-key',
    CHECKPOINT_PUBLIC_KEY_DIR: join(root, 'public-keys'),
    CHECKPOINT_S3_ENDPOINT: 'https://anchor.example',
    CHECKPOINT_S3_ACCESS_KEY_ID: 'public-anchor',
    KF_STORAGE_ACTOR: '00000000-0000-0000-0000-000000000001',
    KF_STORAGE_ROLE: '00000000-0000-0000-0000-000000000002',
    KF_STORAGE_ORGANIZATION: '00000000-0000-0000-0000-000000000003',
    KF_STORAGE_CLASSIFICATION: 'restricted',
    DATABASE_URL: 'public-inline-must-not-pass',
    UNRELATED_SECRET: 'public-unrelated-must-not-pass',
    TMPDIR: '/public-wrong-scratch',
    KF_TIMER_UNIT_DIR: '/public-wrong-timers',
    KF_NOW_EPOCH: '1',
  };
  roles.forEach((role, i) => {
    const entry = join(root, entries[i]);
    directory(entry);
    const bindings = applicationCredentialBindings(role);
    // This program occupies the fixed consumer slot ONLY in the named protected fixture.
    const code = `
      import assert from 'node:assert/strict';
      import { readFileSync,statSync } from 'node:fs';
      import { readSecretFile } from ${JSON.stringify(join(root, 'packages/operations/dist/secrets.js'))};
      assert.equal(process.getuid(),${Number(checked('/usr/bin/id', ['-u', `kf-${role}`]).trim())});
      assert.equal(process.env.NODE_ENV,'production');assert.equal(process.env.KF_SECRET_CUSTODY,'systemd');
      assert.equal(process.env.TMPDIR,'/run/kf-${role}-work');assert.equal(statSync(process.env.TMPDIR).mode&0o777,0o700);
      for(const name of ['DATABASE_URL','UNRELATED_SECRET','NODE_OPTIONS','LD_PRELOAD','KF_TIMER_UNIT_DIR','KF_NOW_EPOCH'])assert.equal(process.env[name],undefined);
      const group=readFileSync('/proc/self/cgroup','utf8').trim().slice(3);
      assert.equal(readFileSync('/sys/fs/cgroup'+group+'/memory.swap.max','utf8').trim(),'0');
      assert.match(readFileSync('/proc/self/limits','utf8'),/Max core file size\\s+0\\s+0\\s+bytes/);
      for(const [binding,name] of ${JSON.stringify(bindings)}){
        assert.equal(process.env[binding],process.env.CREDENTIALS_DIRECTORY+'/'+name);
        assert.equal(statSync(process.env[binding]).mode&0o777,0o440);
        assert.equal(readSecretFile(process.env[binding],binding),'public-'+name+'-'+ 'x'.repeat(64));
      }
      ${role === 'attestor' ? "assert.equal(statSync('/run/kf-attestor').mode&0o777,0o710);" : ''}
      console.log('PASS: ${role} fixed consumer native binding');
    `;
    writeFileSync(entry, code, { flag: 'wx', mode: 0o644 });
  });
  directory(join(root, 'scripts/timer-liveness.sh'));
  writeFileSync(
    join(root, 'scripts/timer-liveness.sh'),
    `#!/bin/sh\nset -eu\ntest -z "\${KF_TIMER_UNIT_DIR:-}"\ntest -z "\${KF_NOW_EPOCH:-}"\nif test -f ${root}/readiness-fail; then exit 7; fi\nprintf '%s\\n' 'PASS: timer liveness fixture ran first'\n`,
    { flag: 'wx', mode: 0o644 },
  );
  for (const file of [
    'scripts/deploy/application-consumer.mjs',
    'scripts/deploy/internal/application-consumer-plan.mjs',
    'scripts/deploy/workstation-credentials.mjs',
    'tools/kf-credential-custody',
  ])
    process.stdout.write(
      `${createHash('sha256')
        .update(readFileSync(join(root, file)))
        .digest('hex')} ${file}\n`,
    );
  let count = 0;
  function test(role, alteration) {
    phase = `${role}-${alteration}`;
    const unit = `kf-app-consumer-${runId}-${role}-${alteration}`;
    const fields = applicationCredentialBindings(role).map(([, name]) => name);
    const settings = [
      `--unit=${unit}`,
      '--pipe',
      '--wait',
      '--property=Type=oneshot',
      `--property=User=kf-${alteration === 'wrong-uid' ? 'worker' : role}`,
      `--property=Group=${role === 'attestor' ? 'kf-attest' : 'kf-' + (alteration === 'wrong-uid' ? 'worker' : role)}`,
      `--property=RuntimeDirectory=${role === 'attestor' ? 'kf-attestor kf-attestor-work' : 'kf-' + role + '-work'}`,
      `--property=RuntimeDirectoryMode=${role === 'attestor' ? '0710' : '0700'}`,
      `--property=MemorySwapMax=${alteration === 'swappable' ? 'infinity' : '0'}`,
      `--property=LimitCORE=${alteration === 'core' ? '1048576' : '0'}`,
      '--property=NoNewPrivileges=yes',
      '--property=PrivateTmp=yes',
      '--property=ProtectSystem=strict',
      '--property=ProtectHome=yes',
      '--property=ProcSubset=all',
      '--property=RestrictAddressFamilies=AF_UNIX',
      '--property=TimeoutStartSec=20',
      '--property=UMask=0077',
    ];
    for (const [name, value] of Object.entries(publicEnv))
      settings.push(`--setenv=${name}=${value}`);
    for (const name of [...fields, ...(alteration === 'extra' ? ['unexpected'] : [])]) {
      const file = join(inputs, `${role}-${alteration}-${name}`);
      writeFileSync(file, 'public-' + name + '-' + 'x'.repeat(64), { mode: 0o400, flag: 'wx' });
      settings.push(`--property=LoadCredential=${name}:${file}`);
    }
    if (alteration === 'timer-failure')
      writeFileSync(join(root, 'readiness-fail'), 'public flag\n', { mode: 0o644, flag: 'wx' });
    const result = command('/usr/bin/systemd-run', [
      ...settings,
      '/usr/bin/node',
      join(root, 'scripts/deploy/application-consumer.mjs'),
      role,
    ]);
    assert.equal(result.error, undefined);
    if (alteration === 'ready') {
      assert.equal(result.status, 0);
      assert(result.stdout.includes(`PASS: ${role} fixed consumer native binding`));
      if (role === 'readiness')
        assert(
          result.stdout.indexOf('PASS: timer liveness fixture ran first') <
            result.stdout.indexOf('PASS: readiness fixed consumer native binding'),
        );
    } else {
      assert.notEqual(result.status, 0);
      assert(!result.stdout.includes('fixed consumer native binding'));
      if (alteration !== 'timer-failure')
        assert(result.stderr.includes('native application binding refused'));
    }
    const terminal = checked('/usr/bin/systemctl', [
      'show',
      unit,
      '-p',
      'MainPID',
      '-p',
      'ActiveState',
      '-p',
      'ExecMainStatus',
    ]);
    assert(terminal.includes('MainPID=0\n'));
    assert(terminal.includes(`ActiveState=${alteration === 'ready' ? 'inactive' : 'failed'}\n`));
    if (alteration === 'timer-failure') assert(terminal.includes('ExecMainStatus=7\n'));
    assert(!existsSync(`/run/credentials/${unit}.service`));
    assert(!existsSync(`/run/kf-${role}-work`));
    if (role === 'attestor') assert(!existsSync('/run/kf-attestor'));
    count += 1;
    process.stdout.write(`PASS: ${phase}; terminal process and removed native/runtime mounts\n`);
  }
  for (const role of roles) {
    test(role, 'ready');
    test(role, 'extra');
  }
  for (const alteration of ['wrong-uid', 'swappable', 'core']) test('api', alteration);
  test('readiness', 'timer-failure');
  process.stdout.write(
    `PASS: ${count} public fixed-consumer native cases. Fixture executables ${root}; volatile public inputs ${inputs}.\n`,
  );
  process.stdout.write(
    'Scope: wrapper/native reader and fixed fixture slots only; no real database, object provider, signing, installed service startup, SSH/store unlock or qualification.\n',
  );
} catch (error) {
  process.stderr.write(
    `public application consumer proof failed at ${phase}: ${error.code || error.name}\n`,
  );
  process.exitCode = 1;
}
