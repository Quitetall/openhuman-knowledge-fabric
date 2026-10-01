import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts/deploy/workstation-credentials.mjs');
const URL = JSON.stringify(pathToFileURL(SCRIPT).href);

function evaluate(body: string): string {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import * as handoff from ${URL};\n${body}`],
    { encoding: 'utf8', timeout: 10_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

const ENV = `{
  KF_ALERT_NTFY_URL: 'https://ntfy.sh/public-test-fixture',
  KF_ALERT_HEARTBEAT_URL: 'https://hc-ping.com/00000000-0000-0000-0000-000000000000',
  KF_RETRIEVAL_INDEX_KEY_HEX: '12'.repeat(32),
  UNRELATED_SECRET: 'never-export-this'
}`;

// Public test values only; filesystem writes stay in a private, uniquely named tmpfs directory.
const RUNTIME = `
import { mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, chmodSync, symlinkSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const parent = mkdtempSync('/dev/shm/kf-credential-proof-');
const uid = process.getuid();
const boot = '00000000-0000-0000-0000-000000000001';
const swaps = 'Filename\\tType\\tSize\\tUsed\\tPriority\\n';
const bytes = handoff.encodeBundle(${ENV});
const root = join(parent, 'kf-workstation-credentials');
`;

describe('workstation credential handoff', () => {
  it('transmits exactly the three named credentials, never unrelated store entries', () => {
    const output = evaluate(`process.stdout.write(handoff.encodeBundle(${ENV}));`);
    expect(output).toBe(
      `kf-workstation-credentials-v2\nhttps://ntfy.sh/public-test-fixture\nhttps://hc-ping.com/00000000-0000-0000-0000-000000000000\n${'12'.repeat(32)}\n`,
    );
    expect(output).not.toContain('never-export-this');
  });

  it('refuses absent or malformed retrieval keys rather than sending an alerts-only bundle', () => {
    evaluate(`
import assert from 'node:assert/strict';
const env = ${ENV};
for (const key of [undefined, '', '12'.repeat(31), '12'.repeat(33), 'AB'.repeat(32), 'xx'.repeat(32), '12'.repeat(32)+'\\n']) {
  assert.throws(() => handoff.encodeBundle({ ...env, KF_RETRIEVAL_INDEX_KEY_HEX: key }));
}
assert.throws(() => handoff.decodeBundle(Buffer.from('kf-workstation-alert-credentials-v1\\n'+env.KF_ALERT_NTFY_URL+'\\n'+env.KF_ALERT_HEARTBEAT_URL+'\\n')));
`);
  });

  it('strips decrypted keys from the SSH child environment', () => {
    expect(
      evaluate(
        `process.stdout.write(JSON.stringify(handoff.transportEnvironment({ HOME:'/safe/home', KF_ALERT_NTFY_URL:'private', UNRELATED_SECRET:'private', SSH_AUTH_SOCK:'private' })));`,
      ),
    ).toBe('{"HOME":"/safe/home","PATH":"/usr/local/bin:/usr/bin:/bin","LANG":"C.UTF-8"}');
  });

  it('refuses missing values, extra framing, injection and non-base heartbeat endpoints', () => {
    evaluate(`
import assert from 'node:assert/strict';
const env = ${ENV};
for (const value of [undefined, '', 'http://example.test/topic', 'https://user:pass@example.test/topic', 'https://example.test/topic?token=x', 'https://example.test/topic#x', 'https://example.test/\\nsecret', 'https://example.test/\\\\secret', 'https://example.test/\\0secret']) {
  assert.throws(() => handoff.encodeBundle({ ...env, KF_ALERT_NTFY_URL: value }));
}
for (const suffix of ['/fail', '/start', '/log', '/500']) {
  assert.throws(() => handoff.encodeBundle({ ...env, KF_ALERT_HEARTBEAT_URL: env.KF_ALERT_HEARTBEAT_URL + suffix }));
}
const bytes = handoff.encodeBundle(env);
assert.throws(() => handoff.decodeBundle(Buffer.concat([bytes, Buffer.from('extra\\n')])));
assert.throws(() => handoff.decodeBundle(Buffer.alloc(16385)));
`);
  });

  it('publishes an atomic private generation in tmpfs and binds it to the guest boot', () => {
    evaluate(`${RUNTIME}
try {
  assert.equal(handoff.runtimeStatus(parent, uid, boot, swaps), 'missing');
  assert.equal(handoff.receiveBundle(bytes, parent, uid, boot, swaps), 'ready');
  assert.equal(statSync(root).mode & 0o777, 0o700);
  const generation = join(root, readlinkSync(join(root, 'current')));
  assert.equal(statSync(generation).mode & 0o777, 0o700);
  for (const name of ['alert-ntfy-url', 'alert-heartbeat-url', 'retrieval-index-key', 'boot-id']) {
    assert.equal(statSync(join(generation, name)).mode & 0o777, 0o400);
  }
  assert.equal(readFileSync(join(generation, 'alert-ntfy-url'), 'utf8'), 'https://ntfy.sh/public-test-fixture');
  assert.equal(readFileSync(join(generation, 'retrieval-index-key'), 'utf8'), '12'.repeat(32));
  assert.throws(() => handoff.runtimeStatus(parent, uid, '00000000-0000-0000-0000-000000000002', swaps));
} finally { rmSync(parent, { recursive: true, force: true }); }
`);
  });

  it('preserves a working generation when a new payload is refused', () => {
    evaluate(`${RUNTIME}
try {
  handoff.receiveBundle(bytes, parent, uid, boot, swaps);
  const before = readlinkSync(join(root, 'current'));
  assert.throws(() => handoff.receiveBundle(Buffer.from('bad'), parent, uid, boot, swaps));
  assert.equal(readlinkSync(join(root, 'current')), before);
  assert.equal(handoff.runtimeStatus(parent, uid, boot, swaps), 'ready');
} finally { rmSync(parent, { recursive: true, force: true }); }
`);
  });

  it('requires the retrieval key in readiness and preserves it on refused updates', () => {
    evaluate(`${RUNTIME}
try {
  handoff.receiveBundle(bytes, parent, uid, boot, swaps);
  const before = readlinkSync(join(root, 'current'));
  const keyPath = join(root, before, 'retrieval-index-key');
  const env = ${ENV};
  assert.throws(() => handoff.receiveBundle(Buffer.from('kf-workstation-credentials-v2\\n'+env.KF_ALERT_NTFY_URL+'\\n'+env.KF_ALERT_HEARTBEAT_URL+'\\ninvalid-key\\n'), parent, uid, boot, swaps));
  assert.equal(readlinkSync(join(root, 'current')), before);
  assert.equal(readFileSync(keyPath, 'utf8'), '12'.repeat(32));
  chmodSync(keyPath, 0o440);
  assert.throws(() => handoff.runtimeStatus(parent, uid, boot, swaps));
  unlinkSync(keyPath);
  assert.equal(handoff.runtimeStatus(parent, uid, boot, swaps), 'missing');
} finally { rmSync(parent, { recursive: true, force: true }); }
`);
  });

  it('refuses active swap, wrong ownership and disk-backed destinations before writing', () => {
    evaluate(`${RUNTIME}
try {
  assert.throws(() => handoff.receiveBundle(bytes, parent, uid, boot, swaps + '/swap file 1 0 -2\\n'));
  assert.throws(() => handoff.receiveBundle(bytes, parent, uid + 1, boot, swaps));
  assert.equal(existsSync(root), false);
  const disk = mkdtempSync(join(${JSON.stringify(ROOT)}, '.credential-proof-'));
  try { assert.throws(() => handoff.receiveBundle(bytes, disk, uid, boot, swaps)); }
  finally { rmSync(disk, { recursive: true, force: true }); }
} finally { rmSync(parent, { recursive: true, force: true }); }
`);
  });

  it('refuses a symlinked runtime root, escaping generation and widened file access', () => {
    evaluate(`${RUNTIME}
try {
  symlinkSync(parent, root);
  assert.throws(() => handoff.receiveBundle(bytes, parent, uid, boot, swaps));
  unlinkSync(root);
  handoff.receiveBundle(bytes, parent, uid, boot, swaps);
  const current = join(root, 'current');
  const generation = join(root, readlinkSync(current));
  chmodSync(join(generation, 'alert-ntfy-url'), 0o644);
  assert.throws(() => handoff.runtimeStatus(parent, uid, boot, swaps));
  unlinkSync(current);
  symlinkSync('../outside', current);
  assert.throws(() => handoff.receiveBundle(bytes, parent, uid, boot, swaps));
} finally { rmSync(parent, { recursive: true, force: true }); }
`);
  });

  it('never logs supplied credentials when its command interface refuses input', () => {
    const result = spawnSync(process.execPath, [SCRIPT, 'receive', 'forbidden-argument'], {
      input: 'do-not-log-this-secret',
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'workstation credential handoff refused; inspect the host locally\n',
    );
  });

  it('requires pinned SSH, receiver byte identity and a bounded reboot recovery timer', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toContain('StrictHostKeyChecking=yes');
    expect(script).toMatch(/'-F',\s*'\/dev\/null'/);
    expect(script).toContain('ForwardAgent=no');
    expect(script).toContain('/usr/bin/sha256sum');
    expect(script).not.toContain('StrictHostKeyChecking=no');
    const timer = readFileSync(
      join(ROOT, 'deploy/workstation/kf-host-credentials.timer.in'),
      'utf8',
    );
    expect(timer).toContain('OnUnitActiveSec=30s');
    expect(timer).toContain('PartOf=kf-host-1.service');
    // Timers default to Before=timers.target, which precedes a normal service's basic.target.
    // Waiting for QEMU belongs on the triggered service, not the timer's startup transaction.
    expect(timer).not.toContain('After=kf-host-1.service');
    const service = readFileSync(
      join(ROOT, 'deploy/workstation/kf-host-credentials.service.in'),
      'utf8',
    );
    expect(service).toContain('After=kf-host-1.service');
    const heartbeat = readFileSync(
      join(ROOT, 'deploy/systemd/alert-heartbeat-workstation-credentials.conf'),
      'utf8',
    );
    expect(heartbeat).toContain(
      'LoadCredential=heartbeat-url:/run/kf-workstation-credentials/current/alert-heartbeat-url',
    );
    expect(heartbeat).toContain(
      'ExecStartPre=/opt/kf/scripts/timer-liveness.sh kf-readiness.timer',
    );
    expect(heartbeat).not.toContain('SetCredential=');
  });
});
