// Isolated root-only PID 1 proof using public fixture values. No DB connection or real key.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  chownSync,
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
let executableParent;
let volatileParent;

function run(command, args) {
  const result = spawnSync(command, args, {
    env,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 65_536,
  });
  if (result.status !== 0 || result.error) {
    // Every process in this driver receives public fixtures only, never installed secrets.
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error('isolated migration credential proof failed');
  }
  return result.stdout;
}

try {
  if (process.platform !== 'linux' || process.getuid() !== 0 || !custody || extra.length)
    throw new Error('run as root with one compiled custody helper path');
  if (
    statfsSync('/run').type !== 0x01021994 ||
    readFileSync('/proc/swaps', 'utf8').trim().split('\n').length !== 1
  )
    throw new Error('public proof requires unswapped tmpfs');
  const uid = Number(run('/usr/bin/id', ['-u', 'kf-retrieval']).trim());
  if (!Number.isSafeInteger(uid) || uid <= 0)
    throw new Error('existing isolated service identity is unavailable');
  process.umask(0o022);
  executableParent = mkdtempSync('/opt/kf-migration-credential-fixture-');
  chmodSync(executableParent, 0o755);
  volatileParent = mkdtempSync('/run/kf-migration-credential-fixture-');
  chmodSync(volatileParent, 0o700);
  for (const path of ['scripts/lib', 'tools', 'tests/fixtures'])
    mkdirSync(join(executableParent, path), { recursive: true, mode: 0o755 });
  for (const path of ['scripts/lib/secret.sh', 'tests/fixtures/systemd-migration-credentials.sh']) {
    copyFileSync(join(ROOT, path), join(executableParent, path));
    chmodSync(join(executableParent, path), 0o644);
  }
  const helper = join(executableParent, 'tools/kf-credential-custody');
  copyFileSync(custody, helper);
  chmodSync(helper, 0o755);
  const inputs = {
    'database-url': 'postgres://fixture:public-fixture-password@127.0.0.1:5433/public_probe',
    'rehearsal-database-url':
      'postgres://fixture:public-fixture-password@127.0.0.1:5434/public_probe',
    'rehearsal-receipt-key': 'ab'.repeat(32),
    'index-key': '12'.repeat(32),
    'unknown-name': 'public unknown name',
    'oversized-url': 'p'.repeat(8193),
    'short-key': 'p'.repeat(31),
  };
  for (const [name, value] of Object.entries(inputs))
    writeFileSync(join(volatileParent, name), value, { mode: 0o400, flag: 'wx' });

  const runId = volatileParent.split('/').at(-1);
  function prove(plant, alteredInput, helperPlant) {
    const unit = `${runId}-${plant}${helperPlant ? `-${helperPlant}` : ''}`;
    const runtime = `${unit}-passwords`;
    const credentials = [
      'database-url',
      'rehearsal-database-url',
      'rehearsal-receipt-key',
      'index-key',
      'unknown-name',
    ].map((name) => {
      const source =
        name === 'database-url' && alteredInput === 'oversized-url'
          ? alteredInput
          : name === 'rehearsal-receipt-key' && alteredInput === 'short-key'
            ? alteredInput
            : name;
      return `--property=LoadCredential=${name}:${join(volatileParent, source)}`;
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
      '--property=RuntimeDirectoryMode=0700',
      '--property=NoNewPrivileges=true',
      '--property=PrivateTmp=true',
      '--property=PrivateNetwork=true',
      '--property=PrivateDevices=true',
      '--property=ProtectSystem=strict',
      '--property=ProtectHome=true',
      '--property=ProtectProc=invisible',
      '--property=ProcSubset=all',
      '--property=RestrictAddressFamilies=AF_UNIX',
      '--property=SystemCallFilter=@system-service',
      '--property=CapabilityBoundingSet=',
      '--property=AmbientCapabilities=',
      '--property=LimitCORE=0',
      '--property=MemorySwapMax=0',
      '--property=TimeoutStartSec=45s',
      '--property=UMask=0077',
      '--setenv=KF_SECRET_CUSTODY=systemd',
      `--setenv=TMPDIR=/run/${runtime}`,
      ...credentials,
      '/usr/bin/bash',
      join(executableParent, 'tests/fixtures/systemd-migration-credentials.sh'),
      executableParent,
      plant,
    ]);
    if (!output.includes('PASS') || existsSync(join('/run', runtime)))
      throw new Error('public proof missing verdict or runtime cleanup');
    process.stdout.write(output);
  }
  prove('valid');
  prove('oversized-url', 'oversized-url');
  prove('short-key', 'short-key');
  prove('unknown-name');
  chownSync(helper, uid, 0);
  prove('unsafe-helper', undefined, 'owner');
  chownSync(helper, 0, 0);
  chmodSync(helper, 0o777);
  prove('unsafe-helper', undefined, 'writable');
  chmodSync(helper, 0o755);
  prove('valid');
  process.stdout.write(
    'Scope: public native custody and password lifecycle only; no database, real key, receipt, promotion or commissioning.\n',
  );
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  // Keep the exact public fixture and failure plants inspectable; units are transient and
  // their owned password directories vanish after each completed run.
  if (executableParent) process.stdout.write(`public executable fixture: ${executableParent}\n`);
  if (volatileParent) process.stdout.write(`public volatile fixture: ${volatileParent}\n`);
}
