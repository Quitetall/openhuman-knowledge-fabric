// Root-only, isolated VM proof. Uses a public fixture key, never the installed key or index.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [probe, helper, custody, dbmate, ...extra] = process.argv.slice(2);
const ENV = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
let parent;
let executableParent;
let socketUnit;
let serviceUnit;
let step = 'preflight';

function run(command, args, extraEnv = {}) {
  return spawnSync(command, args, {
    env: { ...ENV, ...extraEnv },
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 65_536,
  });
}

function requireSuccess(result) {
  if (result.status !== 0 || result.error) throw new Error('isolated broker proof failed');
  return result.stdout;
}

function policy(path, release, pin, allowedUid) {
  writeFileSync(
    path,
    JSON.stringify({ allowedUid, releaseDirectory: release, releaseManifestSha256: pin }),
    { mode: 0o644 },
  );
}

function seal(release) {
  const files = [];
  const directories = [];
  function walk(prefix) {
    for (const entry of readdirSync(join(release, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        directories.push(path);
        walk(path);
      } else files.push(path);
    }
  }
  walk('');
  writeFileSync(join(release, 'DIRECTORIES'), `${directories.sort().join('\n')}\n`);
  writeFileSync(join(release, 'SYMLINKS'), '');
  files.push('DIRECTORIES', 'SYMLINKS');
  const sums = files
    .sort()
    .map(
      (path) =>
        `${createHash('sha256')
          .update(readFileSync(join(release, path)))
          .digest('hex')}  ${path}\n`,
    )
    .join('');
  writeFileSync(join(release, 'SHA256SUMS'), sums);
  return createHash('sha256').update(sums).digest('hex');
}

try {
  if (
    process.getuid() !== 0 ||
    process.platform !== 'linux' ||
    extra.length ||
    !probe ||
    !helper ||
    !custody ||
    !dbmate
  ) {
    throw new Error('run as root with public fixture probe, helper and dbmate paths');
  }
  if (
    statfsSync('/run').type !== 0x01021994 ||
    readFileSync('/proc/swaps', 'utf8').trim().split('\n').length !== 1
  ) {
    throw new Error('proof requires unswapped tmpfs');
  }
  const engineUid = Number(requireSuccess(run('/usr/bin/id', ['-u', 'kfadmin'])).trim());
  if (!Number.isSafeInteger(engineUid) || engineUid <= 0)
    throw new Error('fixture engine identity is invalid');
  requireSuccess(run('/usr/bin/id', ['nobody']));
  process.umask(0o022); // Non-secret fixture inputs must be readable by the isolated broker.
  step = 'fixture-construction';
  parent = mkdtempSync('/run/kf-key-release-fixture-');
  chmodSync(parent, 0o755);
  // /run is correctly noexec on the commissioned-host image. Only public
  // executables/release inputs live in /opt; key material stays in tmpfs.
  executableParent = mkdtempSync('/opt/kf-key-release-fixture-');
  chmodSync(executableParent, 0o755);
  const name = parent.split('/').at(-1);
  socketUnit = `${name}.socket`;
  serviceUnit = `${name}@.service`;
  const release = join(executableParent, 'release');
  for (const path of [
    'tools',
    'scripts/deploy',
    'scripts/lib',
    'database/migrations',
    'generated/sql-registry',
  ]) {
    mkdirSync(join(release, path), { recursive: true, mode: 0o755 });
  }
  for (const path of [
    'scripts/deploy/retrieval-key-release.mjs',
    'scripts/deploy/migrate-release.sh',
    'scripts/lib/secret.sh',
  ]) {
    copyFileSync(join(ROOT, path), join(release, path));
    chmodSync(join(release, path), 0o644);
  }
  for (const [source, target] of [
    [helper, 'tools/kf-peer-credentials'],
    [custody, 'tools/kf-credential-custody'],
    [dbmate, 'tools/dbmate'],
  ]) {
    copyFileSync(source, join(release, target));
    chmodSync(join(release, target), 0o755);
  }
  step = 'packaged-dbmate';
  const version = requireSuccess(run(join(release, 'tools/dbmate'), ['--version'])).trim();
  writeFileSync(join(release, 'BUILD-METADATA'), `dbmate=${version}\n`);
  writeFileSync(
    join(release, 'database/migrations/20260101000000_probe.sql'),
    '-- migrate:up\nselect 1;\n-- migrate:down\nselect 1;\n',
  );
  writeFileSync(join(release, 'generated/sql-registry/001-ontology-seed.sql'), 'select 1;\n');
  const data = join(release, 'data.txt');
  writeFileSync(data, 'sealed public fixture\n');
  const pin = seal(release);
  const policyPath = join(parent, 'policy.json');
  policy(policyPath, release, pin, engineUid);
  // This constant is a public fault fixture, not an encryption credential.
  const publicKeyPath = join(parent, 'public-fixture-key');
  writeFileSync(publicKeyPath, '12'.repeat(32), { mode: 0o400 });
  const client = join(executableParent, 'public-fixture-probe');
  copyFileSync(probe, client);
  chmodSync(client, 0o755);
  const socketPath = join(parent, 'release.sock');
  const socketText = readFileSync(join(ROOT, 'deploy/systemd/kf-retrieval-key.socket'), 'utf8')
    .replace('SocketGroup=kf-retrieval-key', 'SocketGroup=kfadmin')
    .replace('ListenStream=/run/kf-retrieval-key/release.sock', `ListenStream=${socketPath}`);
  const serviceText = readFileSync(join(ROOT, 'deploy/systemd/kf-retrieval-key@.service'), 'utf8')
    .replace(/^OnFailure=.*\n/m, '') // This isolated proof must not send production alerts.
    .replace('User=kf-retrieval-key', 'User=nobody')
    .replace('Group=kf-retrieval-key', 'Group=nogroup')
    .replace(
      'LoadCredential=index-key:/run/kf-workstation-credentials/current/retrieval-index-key',
      `LoadCredential=index-key:${publicKeyPath}`,
    )
    .replace(
      'ExecStart=/usr/bin/node /opt/kf/scripts/deploy/retrieval-key-release.mjs /etc/kf/retrieval-key-release.json',
      `ExecStart=/usr/bin/node ${release}/scripts/deploy/retrieval-key-release.mjs ${policyPath}`,
    );
  writeFileSync(join('/run/systemd/system', socketUnit), socketText, { flag: 'wx', mode: 0o644 });
  writeFileSync(join('/run/systemd/system', serviceUnit), serviceText, { flag: 'wx', mode: 0o644 });
  step = 'service-manager-startup';
  requireSuccess(run('/usr/bin/systemctl', ['daemon-reload']));
  requireSuccess(run('/usr/bin/systemctl', ['start', socketUnit]));
  const fixtureEnv = {
    LAMU_KF_KEY_FIXTURE_SOCKET: socketPath,
    LAMU_KF_KEY_FIXTURE_RELEASE_SHA256: pin,
  };
  function check(expectedSuccess, label) {
    step = label;
    const result = run(
      '/usr/sbin/runuser',
      [
        '-u',
        'kfadmin',
        '--',
        '/usr/bin/env',
        ...Object.entries(fixtureEnv).map(([key, value]) => `${key}=${value}`),
        client,
        '--ignored',
        '--exact',
        'production_client_receives_the_public_fixture_key',
      ],
      {},
    );
    const testRan =
      result.stdout.includes('running 1 test') &&
      result.stdout.includes('test production_client_receives_the_public_fixture_key ...');
    const expectedVerdict = expectedSuccess
      ? result.stdout.includes('... ok')
      : result.stdout.includes('... FAILED');
    if (
      result.error ||
      !testRan ||
      !expectedVerdict ||
      (expectedSuccess ? result.status !== 0 : result.status === 0 || result.status === null)
    ) {
      // Public-fixture client only, with a clean environment and boolean key
      // assertion. No broker response bytes or production journal are copied.
      process.stderr.write(`fixture probe exit=${result.status} signal=${result.signal}\n`);
      process.stderr.write(result.stdout.slice(0, 4096));
      process.stderr.write(result.stderr.slice(0, 2048));
      throw new Error(`isolated broker proof failed: ${label}`);
    }
    process.stdout.write(`${label}: PASS\n`);
  }
  check(true, 'root-listener/unprivileged-broker/engine-client');
  policy(policyPath, release, pin, 0);
  check(false, 'wrong engine UID refused');
  policy(policyPath, release, pin, engineUid);
  writeFileSync(data, 'drifted public fixture\n');
  check(false, 'altered sealed release refused');
  writeFileSync(data, 'sealed public fixture\n');
  requireSuccess(run('/usr/bin/systemctl', ['stop', socketUnit]));
  check(false, 'stopped broker refused');
  process.stdout.write(
    'Scope: public fixture only; no live key, database, index, promotion or commissioning.\n',
  );
} catch {
  process.stderr.write(`isolated retrieval-key broker proof failed at ${step}\n`);
  process.exitCode = 1;
} finally {
  if (socketUnit) run('/usr/bin/systemctl', ['stop', socketUnit]);
  if (parent) {
    const name = parent.split('/').at(-1);
    const instances = run('/usr/bin/systemctl', [
      'list-units',
      '--all',
      '--plain',
      '--no-legend',
      `${name}@*.service`,
    ]);
    if (instances.status === 0) {
      for (const line of instances.stdout.trim().split('\n')) {
        const unit = line.trim().split(/\s+/)[0];
        if (unit.startsWith(`${name}@`) && unit.endsWith('.service'))
          run('/usr/bin/systemctl', ['stop', unit]);
      }
    }
    for (const unit of [socketUnit, serviceUnit]) {
      if (unit) rmSync(join('/run/systemd/system', unit), { force: true });
    }
    run('/usr/bin/systemctl', ['daemon-reload']);
    // Only the exact directory this process created, never /run or installed stores.
    if (parent.startsWith('/run/kf-key-release-fixture-'))
      rmSync(parent, { recursive: true, force: true });
  }
  if (executableParent?.startsWith('/opt/kf-key-release-fixture-'))
    rmSync(executableParent, { recursive: true, force: true });
}
