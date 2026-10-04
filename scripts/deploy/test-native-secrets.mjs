// Real PID1 mounts and the compiled reader; all inputs are public fixtures, no network.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
const [release, ...extra] = process.argv.slice(2);
const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
function guard(ok) {
  if (!ok) throw new Error('public native secret proof refused');
}
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: '/',
    env,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 65536,
  });
  if (result.error || result.signal || result.status !== 0) {
    // No actual key or credential-bearing endpoint is an input to this driver.
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error('public native secret proof failed');
  }
  return result.stdout;
}
try {
  guard(
    process.platform === 'linux' &&
      process.getuid() === 0 &&
      release &&
      isAbsolute(release) &&
      extra.length === 0,
  );
  guard(
    statfsSync('/run').type === 0x01021994 &&
      readFileSync('/proc/swaps', 'utf8').trim().split('\n').length === 1,
  );
  process.umask(0o022);
  const executable = mkdtempSync('/opt/kf-native-secret-fixture-');
  chmodSync(executable, 0o755);
  const inputs = mkdtempSync('/run/kf-native-secret-fixture-');
  chmodSync(inputs, 0o700);
  const runId = inputs.split('-').at(-1);
  const source = join(release, 'apps/api/node_modules/@kf/operations/dist');
  mkdirSync(join(executable, 'tools'), { mode: 0o755 });
  copyFileSync(
    join(release, 'tools/kf-credential-custody'),
    join(executable, 'tools/kf-credential-custody'),
  );
  chmodSync(join(executable, 'tools/kf-credential-custody'), 0o755);
  process.stdout.write(
    `helper sha256 ${createHash('sha256')
      .update(readFileSync(join(executable, 'tools/kf-credential-custody')))
      .digest('hex')}\n`,
  );
  const layouts = [
    'packages/operations',
    'apps/api/node_modules/.pnpm/public-layout/node_modules/@kf/operations',
  ];
  for (const layout of layouts) {
    const root = join(executable, layout);
    mkdirSync(join(root, 'dist/internal'), { recursive: true, mode: 0o755 });
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n', { mode: 0o644, flag: 'wx' });
    for (const name of ['secrets.js', 'internal/native-secret.js']) {
      copyFileSync(join(source, name), join(root, 'dist', name));
      chmodSync(join(root, 'dist', name), 0o644);
      process.stdout.write(
        `reader sha256 ${createHash('sha256')
          .update(readFileSync(join(root, 'dist', name)))
          .digest('hex')} ${layout}/${name}\n`,
      );
    }
  }
  const cases = [
    {
      id: 'swappable-memory',
      name: 'database-url',
      value: 'public-test',
      alteration: 'swappable',
      reason: 'custody_unavailable',
    },
    {
      id: 'core-enabled',
      name: 'database-url',
      value: 'public-test',
      alteration: 'core-enabled',
      reason: 'custody_unavailable',
    },
    { id: 'database', name: 'database-url', value: 'postgresql://example.invalid/kf_public_test' },
    { id: 's3', name: 's3-secret-access-key', value: 'public-object-fixture' },
    { id: 'durable-s3', name: 's3-durable-secret-access-key', value: 'public-durable-fixture' },
    { id: 'readiness', name: 'readiness-token', value: '12'.repeat(16) },
    { id: 'master-link', name: 'master-record-link-secret', value: '34'.repeat(16) },
    // Placeholder bytes prove custody/read semantics, NOT key validity or signing.
    {
      id: 'checkpoint',
      name: 'checkpoint-signing-key',
      value: 'public-not-a-signing-key',
      direct: true,
    },
    {
      id: 'preservation',
      name: 'preservation-signing-key',
      value: 'public-not-a-signing-key',
      direct: true,
    },
    {
      id: 'trailing-newline',
      name: 'database-url',
      value: 'postgresql://example.invalid/kf_public_test\n',
    },
    {
      id: 'ordinary',
      name: 'database-url',
      value: 'public-test',
      alteration: 'ordinary',
      reason: 'too_permissive',
    },
    {
      id: 'unknown-custody',
      name: 'database-url',
      value: 'public-test',
      alteration: 'unsupported',
      reason: 'custody_unavailable',
    },
    {
      id: 'missing-directory',
      name: 'database-url',
      value: 'public-test',
      alteration: 'missing-directory',
      reason: 'custody_unavailable',
    },
    {
      id: 'alias-directory',
      name: 'database-url',
      value: 'public-test',
      alteration: 'alias-directory',
      reason: 'custody_unavailable',
    },
    {
      id: 'alias-file',
      name: 'database-url',
      value: 'public-test',
      alteration: 'alias-file',
      reason: 'custody_unavailable',
    },
    {
      id: 'outside-file',
      name: 'database-url',
      value: 'public-test',
      alteration: 'outside-file',
      reason: 'custody_unavailable',
    },
    {
      id: 'mode-override',
      name: 'database-url',
      value: 'public-test',
      alteration: 'mode-override',
      reason: 'custody_unavailable',
    },
    {
      id: 'inline',
      name: 'database-url',
      value: 'public-test',
      alteration: 'inline',
      reason: 'custody_unavailable',
    },
    {
      id: 'unknown-name',
      name: 'unknown-public-key',
      value: 'public-test',
      reason: 'custody_unavailable',
    },
    { id: 'empty', name: 'database-url', value: '', reason: 'custody_unavailable' },
    {
      id: 'oversized',
      name: 'database-url',
      value: 'x'.repeat(8193),
      reason: 'custody_unavailable',
    },
    {
      id: 'short-token',
      name: 'readiness-token',
      value: 'x'.repeat(31),
      reason: 'custody_unavailable',
    },
    {
      id: 'oversized-token',
      name: 'master-record-link-secret',
      value: 'x'.repeat(8193),
      reason: 'custody_unavailable',
    },
    {
      id: 'oversized-signing-key',
      name: 'checkpoint-signing-key',
      value: 'x'.repeat(4097),
      reason: 'custody_unavailable',
    },
  ];
  let count = 0;
  for (const [index, layout] of layouts.entries()) {
    const user = index === 0 ? 'kf-api' : 'kf-worker';
    const uid = Number(run('/usr/bin/id', ['-u', user]).trim());
    guard(uid > 0);
    for (const fixture of cases) {
      const unit = `kf-native-secret-${runId}-${index}-${fixture.id}`;
      const input = join(inputs, `${index}-${fixture.id}`);
      writeFileSync(input, fixture.value, { mode: 0o400, flag: 'wx' });
      const code = `
        import assert from 'node:assert/strict';
        import { readFileSync, statSync } from 'node:fs';
        import { loadSecret, readSecretFile, SecretRejected } from ${JSON.stringify(join(executable, layout, 'dist/secrets.js'))};
        const fixture=JSON.parse(process.argv[1]), directory=process.env.CREDENTIALS_DIRECTORY;
        assert.equal(process.getuid(),${uid});
        const group=readFileSync('/proc/self/cgroup','utf8').trim().slice(3);
        assert.equal(readFileSync('/sys/fs/cgroup'+group+'/memory.swap.max','utf8').trim(),fixture.alteration==='swappable'?'max':'0');
        if(fixture.alteration!=='core-enabled') assert.match(readFileSync('/proc/self/limits','utf8'),/Max core file size\\s+0\\s+0\\s+bytes/);
        else assert.match(readFileSync('/proc/self/limits','utf8'),/Max core file size\\s+1048576\\s+1048576\\s+bytes/);
        assert.equal(statSync(directory+'/'+fixture.name).mode&0o777,0o440);
        const env={...process.env,DATABASE_URL_FILE:directory+'/'+fixture.name};
        let options={};
        switch(fixture.alteration){
          case 'ordinary': delete env.KF_SECRET_CUSTODY; break;
          case 'unsupported': env.KF_SECRET_CUSTODY='file'; break;
          case 'missing-directory': delete env.CREDENTIALS_DIRECTORY; break;
          case 'alias-directory': env.CREDENTIALS_DIRECTORY=directory+'/../'+directory.split('/').at(-1); break;
          case 'alias-file': env.DATABASE_URL_FILE=directory+'/../'+directory.split('/').at(-1)+'/'+fixture.name; break;
          case 'outside-file': env.DATABASE_URL_FILE='/etc/kf/public-nonexistent'; break;
          case 'mode-override': options={forbiddenMode:0}; break;
          case 'inline': delete env.DATABASE_URL_FILE; env.DATABASE_URL=fixture.value; options={allowInline:true}; break;
        }
        let value, error;
        try { value=fixture.direct?readSecretFile(env.DATABASE_URL_FILE,'public-key-path'):loadSecret('DATABASE_URL',env,options); }
        catch(caught){error=caught;}
        if(fixture.reason){assert(error instanceof SecretRejected);assert.equal(error.reason,fixture.reason);assert(!error.message.includes(fixture.value)||fixture.value==='');}
        else{assert.equal(error,undefined);assert.equal(value,fixture.value.trimEnd());}
        console.log('PASS: '+fixture.id+' direct native reader');
      `;
      run('/usr/bin/systemd-run', [
        `--unit=${unit}`,
        '--pipe',
        '--wait',
        `--property=User=${user}`,
        `--property=Group=${user}`,
        `--property=MemorySwapMax=${fixture.alteration === 'swappable' ? 'infinity' : '0'}`,
        `--property=LimitCORE=${fixture.alteration === 'core-enabled' ? '1048576' : '0'}`,
        '--property=UMask=0077',
        '--property=NoNewPrivileges=yes',
        '--property=PrivateTmp=yes',
        '--property=ProtectSystem=strict',
        '--property=ProtectHome=yes',
        '--property=PrivateDevices=yes',
        '--property=ProcSubset=all',
        '--property=RestrictAddressFamilies=AF_UNIX',
        '--property=RuntimeMaxSec=20',
        '--setenv=KF_SECRET_CUSTODY=systemd',
        `--property=LoadCredential=${fixture.name}:${input}`,
        '/usr/bin/node',
        '--input-type=module',
        '-e',
        code,
        JSON.stringify(fixture),
      ]);
      const terminal = run('/usr/bin/systemctl', [
        'show',
        unit,
        '-p',
        'MainPID',
        '-p',
        'ActiveState',
        '-p',
        'Result',
        '-p',
        'ExecMainStatus',
      ]);
      guard(
        terminal.includes('MainPID=0\n') &&
          terminal.includes('ActiveState=inactive\n') &&
          terminal.includes('Result=success\n') &&
          terminal.includes('ExecMainStatus=0\n') &&
          !existsSync(`/run/credentials/${unit}.service`),
      );
      count += 1;
      process.stdout.write(
        `PASS: ${user} layout ${index} ${fixture.id}; native mount gone after terminal exit\n`,
      );
    }
  }
  process.stdout.write(
    `PASS: ${count} native cases. Reader files copied byte-for-byte; ordinary permissions unchanged; no service-owned credential projections.\n`,
  );
  process.stdout.write(
    'Scope: direct reader/native custody only; no real key, signing, store unlock, database login, installed service configuration or commissioning proof.\n',
  );
  process.stdout.write(
    `Retained public executable fixture ${executable}; public volatile inputs ${inputs}.\n`,
  );
} catch {
  console.error('Public native secret proof failed; no commissioning or production claim.');
  process.exitCode = 1;
}
