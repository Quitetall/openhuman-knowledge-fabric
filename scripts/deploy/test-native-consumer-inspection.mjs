// Isolated public PID 1 proof. Never installs, restarts or reads production consumers.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { applicationCredentialBindings } from './workstation-credentials.mjs';
import {
  observeNativeConsumer,
  protectedNativePath,
} from './internal/native-consumer-observation.mjs';
import { nativeConsumerVerdict } from './internal/native-consumer-verdict.mjs';

const [release, ...extra] = process.argv.slice(2);
const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
const ownedUnits = new Set();
let phase = 'admission';
let operation = 'none';
function command(program, args) {
  operation = program;
  const result = spawnSync(program, args, {
    env,
    cwd: '/',
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 65536,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}
function checked(program, args) {
  const result = command(program, args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
try {
  assert.equal(process.getuid(), 0);
  assert(release && isAbsolute(release) && extra.length === 0);
  await protectedNativePath(join(release, 'tools/kf-credential-custody'), true);
  assert.match(
    readFileSync('/proc/swaps', 'utf8').trim(),
    /^Filename\s+Type\s+Size\s+Used\s+Priority$/,
  );
  process.umask(0o077);
  const inputs = mkdtempSync('/run/kf-native-inspection-inputs-');
  chmodSync(inputs, 0o700);
  const attempt = inputs.split('-').at(-1);
  process.stdout.write(
    `helper sha256 ${createHash('sha256')
      .update(readFileSync(join(release, 'tools/kf-credential-custody')))
      .digest('hex')}\n`,
  );
  let count = 0;
  async function test(role, alteration, wanted) {
    phase = `${role}-${alteration}`;
    const unit = `kf-inspection-${attempt}-${role}-${alteration}.service`;
    ownedUnits.add(unit);
    const names = applicationCredentialBindings(role).map(([, name]) => name);
    const properties = [
      '--quiet',
      '--no-block',
      `--unit=${unit}`,
      `--property=Type=${alteration === 'oneshot' ? 'oneshot' : 'exec'}`,
      `--property=User=kf-${alteration === 'wrong-uid' ? 'worker' : role}`,
      `--property=Group=${alteration === 'wrong-gid' ? 'kf-worker' : role === 'attestor' ? 'kf-attest' : 'kf-' + role}`,
      `--property=MemorySwapMax=${alteration === 'swap' ? 'infinity' : '0'}`,
      `--property=LimitCORE=${alteration === 'core' ? '1048576' : '0'}`,
      `--property=NoNewPrivileges=${alteration === 'privileges' ? 'no' : 'yes'}`,
      '--property=CapabilityBoundingSet=',
      '--property=AmbientCapabilities=',
      '--property=PrivateTmp=yes',
      '--property=ProtectSystem=strict',
      '--property=ProtectHome=yes',
      '--property=KillMode=control-group',
      '--property=TimeoutStartSec=60',
      '--property=RuntimeMaxSec=60',
    ];
    for (const name of [
      ...names.filter((_, i) => alteration !== 'missing' || i !== 0),
      ...(alteration === 'extra' ? ['unexpected'] : []),
    ]) {
      const file = join(inputs, `${role}-${alteration}-${name}`);
      writeFileSync(file, 'public-' + name + '-' + 'x'.repeat(64), { flag: 'wx', mode: 0o400 });
      properties.push(`--property=LoadCredential=${name}:${file}`);
    }
    checked('/usr/bin/systemd-run', [...properties, '/usr/bin/sleep', '45']);
    let pid = 0;
    for (let i = 0; i < 50; i++) {
      pid = Number(
        checked('/usr/bin/systemctl', ['show', unit, '--property=MainPID', '--value']).trim(),
      );
      // MainPID can initially name PID 1's root setup process. Wait for this
      // fixture's actual exec, not merely a nonzero PID or an activating state.
      try {
        if (pid > 0 && readlinkSync(`/proc/${pid}/exe`) === '/usr/bin/sleep') break;
      } catch {
        /* It may have not exec'd yet. Keep the same unit, never restart it. */
      }
      pid = 0;
      await delay(50);
    }
    assert(pid > 0);
    const observation = await observeNativeConsumer(role, release, unit);
    const result = nativeConsumerVerdict(role, observation);
    if (result.status !== wanted) {
      // The verdict has a closed, metadata-only report contract.
      process.stderr.write(JSON.stringify(result) + '\n');
    }
    assert.equal(result.status, wanted);
    if (wanted === 'satisfied') assert.equal(result.observed.pid, pid);
    assert(!JSON.stringify(result).includes('public-' + names[0]));
    process.stdout.write(`PASS: ${phase}: ${result.status}\n`);
    count++;
    checked('/usr/bin/systemctl', ['stop', unit]);
    assert.equal(
      Number(checked('/usr/bin/systemctl', ['show', unit, '--property=MainPID', '--value']).trim()),
      0,
    );
    ownedUnits.delete(unit);
    assert.equal(
      nativeConsumerVerdict(role, await observeNativeConsumer(role, release, unit)).status,
      'unverifiable',
    );
    process.stdout.write(`PASS: ${phase}: stopped is unverifiable\n`);
    count++;
  }
  for (const role of ['api', 'worker', 'attestor', 'checkpoint', 'storage', 'readiness'])
    await test(role, 'ready', 'satisfied');
  await test('readiness', 'oneshot', 'satisfied');
  for (const change of ['core', 'swap', 'privileges', 'extra', 'missing'])
    await test('api', change, 'unsatisfied');
  await test('api', 'wrong-gid', 'unverifiable');
  await test('api', 'wrong-uid', 'unverifiable');
  process.stdout.write(
    `PASS: ${count} real current-process inspection cases; public sleep programs only, not application use or host commissioning\n`,
  );
} catch (error) {
  // This driver supplies only public placeholders. Assertion locations are
  // useful without echoing observed metadata, credential names or values.
  const location =
    String(error?.stack).match(/test-native-consumer-inspection\.mjs:\d+:\d+/)?.[0] ?? 'unknown';
  process.stderr.write(
    `public native inspection proof failed (${phase}, ${operation}, ${location})\n`,
  );
  process.exitCode = 1;
} finally {
  for (const unit of ownedUnits) {
    try {
      checked('/usr/bin/systemctl', ['stop', unit]);
    } catch {
      process.exitCode = 1;
    }
  }
}
