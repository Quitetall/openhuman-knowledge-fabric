// Root-only native mount/dispatcher proof. Public fixtures, no network or installed secrets.
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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [custody, ...extra] = process.argv.slice(2);
const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
let executable;
let inputs;
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: '/',
    env,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 65_536,
  });
  if (result.error || result.status !== 0) {
    // These children receive only constants below; never installed endpoints or keys.
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error('public native alert proof failed');
  }
  return result.stdout;
}
try {
  if (process.platform !== 'linux' || process.getuid() !== 0 || !custody || extra.length)
    throw new Error('run as root with one freshly compiled custody helper path');
  if (
    statfsSync('/run').type !== 0x01021994 ||
    readFileSync('/proc/swaps', 'utf8').trim().split('\n').length !== 1
  )
    throw new Error('public proof requires unswapped tmpfs');
  run('/usr/bin/id', ['kf-retrieval']);
  process.umask(0o022);
  executable = mkdtempSync('/opt/kf-alert-credential-fixture-');
  chmodSync(executable, 0o755);
  inputs = mkdtempSync('/run/kf-alert-credential-fixture-');
  chmodSync(inputs, 0o700);
  const runId = inputs.split('/').at(-1);
  for (const dir of ['scripts/lib', 'tools', 'tests/fixtures', 'bin'])
    mkdirSync(join(executable, dir), { recursive: true, mode: 0o755 });
  for (const file of [
    'scripts/alert-dispatch.sh',
    'scripts/lib/secret.sh',
    'tests/fixtures/systemd-alert-credentials.sh',
  ]) {
    copyFileSync(join(ROOT, file), join(executable, file));
    chmodSync(join(executable, file), 0o644);
    process.stdout.write(
      `source sha256 ${createHash('sha256')
        .update(readFileSync(join(ROOT, file)))
        .digest('hex')} ${file}\n`,
    );
  }
  copyFileSync(custody, join(executable, 'tools/kf-credential-custody'));
  chmodSync(join(executable, 'tools/kf-credential-custody'), 0o755);
  process.stdout.write(
    `helper sha256 ${createHash('sha256').update(readFileSync(custody)).digest('hex')}\n`,
  );
  writeFileSync(
    join(executable, 'bin/curl'),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "$*" != *https://* ]] || exit 80
IFS= read -r config || [[ -n "$config" ]]
[[ -z "$(cat)" ]] || exit 81
payload=''
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == --data ]]; then shift; payload="$1"; fi
  shift
done
case "$config" in
  'url = "https://ntfy.invalid/public-fixture"')
    [[ "$payload" == 'Service needs attention. Check the service locally.' ]] || exit 82
    printf '%s' failure > "$RUNTIME_DIRECTORY/curl-called"
    printf '%s' '{"event":"message","message":"Service needs attention. Check the service locally."}' ;;
  'url = "https://healthchecks.invalid/public-fixture"')
    [[ -z "$payload" ]] || exit 83
    printf '%s' heartbeat > "$RUNTIME_DIRECTORY/curl-called"
    printf '%s' OK ;;
  *) exit 84 ;;
esac
`,
    { mode: 0o755, flag: 'wx' },
  );
  const values = {
    'ntfy-url': 'https://ntfy.invalid/public-fixture',
    'heartbeat-url': 'https://healthchecks.invalid/public-fixture',
    empty: '',
    oversized: 'p'.repeat(4098),
    'invalid-url': 'http://public.invalid',
    'unknown-name': 'https://ntfy.invalid/public-fixture',
  };
  for (const [name, value] of Object.entries(values))
    writeFileSync(join(inputs, name), value, { mode: 0o400, flag: 'wx' });
  const dropins = [
    ['alert-workstation-credentials.conf', 'failure'],
    ['alert-heartbeat-workstation-credentials.conf', 'heartbeat'],
    ['alert-ntfy-healthchecks.conf', 'failure'],
    ['alert-heartbeat-ntfy-healthchecks.conf', 'heartbeat'],
  ];
  for (const [file, event] of dropins) {
    const conf = readFileSync(join(ROOT, 'deploy/systemd', file), 'utf8');
    process.stdout.write(
      `drop-in sha256 ${createHash('sha256').update(conf).digest('hex')} ${file}\n`,
    );
    const lines = conf.split('\n');
    const declaredRuntime = lines.find((l) => l.startsWith('RuntimeDirectory='))?.slice(17);
    const expectedRuntime = event === 'failure' ? 'kf-alert-%i' : 'kf-alert-heartbeat';
    if (
      declaredRuntime !== expectedRuntime ||
      !lines.includes(`Environment=TMPDIR=/run/${expectedRuntime}`)
    )
      throw new Error('declared alert runtime and TMPDIR do not match');
    for (const plant of [
      'valid',
      'ordinary-custody',
      'missing-tmpdir',
      'inherited-pgpass',
      'empty',
      'oversized',
      'invalid-url',
      'unknown-name',
    ]) {
      const instance = `${runId}-${event}-${file.split('.')[0]}-${plant}`;
      const unit = `${instance}.service`;
      // Relocate the fixed heartbeat runtime to avoid any installed service. Preserve
      // the declared directory/TMPDIR relationship. --setenv escapes specifiers, so
      // resolve only the drop-in's %d and %i against this actual transient unit.
      const runtime = event === 'failure' ? `kf-alert-${instance}` : `${instance}-heartbeat`;
      const settings = lines
        .filter((l) => l.startsWith('Environment='))
        .map((l) =>
          l
            .slice(12)
            .replaceAll('%d', `/run/credentials/${unit}`)
            .replaceAll('%i', instance)
            .replace(
              `TMPDIR=/run/${expectedRuntime.replaceAll('%i', instance)}`,
              `TMPDIR=/run/${runtime}`,
            ),
        );
      if (plant === 'ordinary-custody')
        settings.splice(settings.indexOf('KF_SECRET_CUSTODY=systemd'), 1);
      if (plant === 'missing-tmpdir')
        settings.splice(settings.indexOf(`TMPDIR=/run/${runtime}`), 1);
      if (plant === 'unknown-name')
        settings.push(
          `${event === 'failure' ? 'KF_ALERT_WEBHOOK_URL_FILE' : 'KF_ALERT_HEARTBEAT_URL_FILE'}=/run/credentials/${unit}/unknown-name`,
        );
      const selected = event === 'failure' ? 'ntfy-url' : 'heartbeat-url';
      const credentials = ['ntfy-url', 'heartbeat-url', 'unknown-name'].map((name) => {
        const source =
          name === selected && ['empty', 'oversized', 'invalid-url'].includes(plant) ? plant : name;
        return `--property=LoadCredential=${name}:${join(inputs, source)}`;
      });
      const properties = [
        'RuntimeDirectoryMode=',
        'MemorySwapMax=',
        'LimitCORE=',
        'ProcSubset=',
      ].map((prefix) => {
        const line = lines.find((l) => l.startsWith(prefix));
        if (!line) throw new Error('required native alert property is missing');
        return `--property=${line}`;
      });
      const output = run('/usr/bin/systemd-run', [
        '--quiet',
        '--wait',
        '--pipe',
        '--collect',
        `--unit=${unit}`,
        '--property=User=kf-retrieval',
        '--property=Group=kf-retrieval',
        `--property=RuntimeDirectory=${runtime}`,
        ...properties,
        '--property=NoNewPrivileges=true',
        '--property=PrivateTmp=true',
        '--property=PrivateNetwork=true',
        '--property=PrivateDevices=true',
        '--property=ProtectSystem=strict',
        '--property=ProtectHome=true',
        '--property=ProtectProc=invisible',
        '--property=RestrictAddressFamilies=AF_UNIX',
        '--property=SystemCallFilter=@system-service',
        '--property=CapabilityBoundingSet=',
        '--property=AmbientCapabilities=',
        '--property=TimeoutStartSec=45s',
        '--property=UMask=0077',
        ...credentials,
        `--setenv=PATH=${executable}/bin:/usr/bin:/bin`,
        ...settings.map((s) => `--setenv=${s}`),
        '/usr/bin/bash',
        join(executable, 'tests/fixtures/systemd-alert-credentials.sh'),
        executable,
        event,
        plant,
      ]);
      if (
        !output.includes(`PASS: native alert ${event} ${plant};`) ||
        existsSync(`/run/${runtime}`)
      )
        throw new Error('public native alert verdict or runtime cleanup missing');
      process.stdout.write(output);
    }
  }
  process.stdout.write(
    'Scope: native endpoint custody/dispatcher only. Public LoadCredential fixtures even for encrypted drop-ins; no encryption unlock, timer guard, provider delivery, phone receipt, installed alert identity or commissioning proof.\n',
  );
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  // Public failure plants remain inspectable; completed units remove their owned runtime.
  if (executable) process.stdout.write(`public executable fixture: ${executable}\n`);
  if (inputs) process.stdout.write(`public volatile fixture: ${inputs}\n`);
}
