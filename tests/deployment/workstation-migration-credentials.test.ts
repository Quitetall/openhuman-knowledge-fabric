import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts/deploy/workstation-credentials.mjs');
const URL = JSON.stringify(pathToFileURL(SCRIPT).href);
const ENV = `{
  KF_MIGRATOR_DATABASE_URL: 'postgres://kf_migrator_login:public-production@127.0.0.1:5432/kf?sslmode=disable',
  KF_REHEARSAL_DATABASE_URL: 'postgresql://kf_rehearsal_migrator:public-rehearsal@127.0.0.1:5433/kf_rehearsal_fixture',
  KF_REHEARSAL_RECEIPT_KEY_HEX: '34'.repeat(32),
  KF_ALERT_NTFY_URL: 'https://ntfy.sh/not-in-this-realm',
  KF_RETRIEVAL_INDEX_KEY_HEX: '56'.repeat(32),
  UNRELATED_SECRET: 'never-export-this'
}`;

function evaluate(body: string): string {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import * as handoff from ${URL};\n${body}`],
    { encoding: 'utf8', timeout: 10_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

// Public fixture values only. These tests prove framing/custody, not database authorization.
const RUNTIME = `
import { mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, chmodSync, symlinkSync, unlinkSync, existsSync, readdirSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const parent = mkdtempSync('/dev/shm/kf-migration-handoff-proof-');
const uid = process.getuid();
const boot = '00000000-0000-0000-0000-000000000001';
const swaps = 'Filename\\tType\\tSize\\tUsed\\tPriority\\n';
const env = ${ENV};
const bytes = handoff.encodeMigrationBundle(env);
const root = join(parent, 'kf-workstation-migration-credentials');
`;

describe('separate workstation migration credential handoff', () => {
  it('frames exactly two database connections and one raw-text receipt key', () => {
    const output = evaluate(`process.stdout.write(handoff.encodeMigrationBundle(${ENV}));`);
    expect(output).toBe(
      `kf-workstation-migration-credentials-v1\npostgres://kf_migrator_login:public-production@127.0.0.1:5432/kf?sslmode=disable\npostgresql://kf_rehearsal_migrator:public-rehearsal@127.0.0.1:5433/kf_rehearsal_fixture\n${'34'.repeat(32)}\n`,
    );
    expect(output).not.toContain('never-export-this');
    expect(output).not.toContain('not-in-this-realm');
    expect(output).not.toContain('56'.repeat(32));
  });

  it('refuses cross-realm framing, extras, malformed keys and missing values', () => {
    evaluate(`
import assert from 'node:assert/strict';
const env = ${ENV};
const bytes = handoff.encodeMigrationBundle(env);
assert.throws(() => handoff.decodeBundle(bytes));
assert.throws(() => handoff.decodeMigrationBundle(Buffer.from(bytes.toString().replace('kf-workstation-migration-credentials-v1', 'kf-workstation-credentials-v2'))));
assert.throws(() => handoff.decodeMigrationBundle(Buffer.concat([bytes, Buffer.from('extra\\n')])));
assert.throws(() => handoff.decodeMigrationBundle(Buffer.alloc(16385)));
for (const name of ['KF_MIGRATOR_DATABASE_URL', 'KF_REHEARSAL_DATABASE_URL', 'KF_REHEARSAL_RECEIPT_KEY_HEX']) {
  assert.throws(() => handoff.encodeMigrationBundle({ ...env, [name]: undefined }));
}
for (const key of ['', '34'.repeat(31), 'AB'.repeat(32), '34'.repeat(32)+'\\n']) {
  assert.throws(() => handoff.encodeMigrationBundle({ ...env, KF_REHEARSAL_RECEIPT_KEY_HEX: key }));
}
`);
  });

  it('refuses remote, ambiguous, encoded, redirected and reserved database targets', () => {
    evaluate(`
import assert from 'node:assert/strict';
const env = ${ENV};
assert.equal(typeof handoff.encodeMigrationBundle, 'function');
const base = env.KF_MIGRATOR_DATABASE_URL;
for (const value of [
  base.replace('postgres:', 'https:'), base.replace('127.0.0.1', 'localhost'),
  base.replace(':5432', ':5433'), base.replace('/kf?', '/postgres?'),
  base.replace('/kf?', '/template0?'), base.replace('/kf?', '/template1?'),
  base.replace('public-production', 'encoded%40password'), base.replace('public-production', ''),
  base+'#fragment', base+'&host=elsewhere', base+'&sslmode=disable',
  base.replace('sslmode=disable', 'options=-csearch_path=x'), base+'\\n',
  base.replace('/kf?', '/not/a/database?'), base.replace('kf_migrator_login', 'user%2Fname'),
  base.replace('public-production', 'x'.repeat(8193)),
]) assert.throws(() => handoff.encodeMigrationBundle({ ...env, KF_MIGRATOR_DATABASE_URL: value }));
assert.throws(() => handoff.encodeMigrationBundle({ ...env, KF_REHEARSAL_DATABASE_URL: base }));
assert.throws(() => handoff.encodeMigrationBundle({ ...env, KF_REHEARSAL_DATABASE_URL: env.KF_REHEARSAL_DATABASE_URL.replace('kf_rehearsal_migrator', 'kf_migrator_login') }));
assert.throws(() => handoff.encodeMigrationBundle({ ...env, KF_REHEARSAL_DATABASE_URL: env.KF_REHEARSAL_DATABASE_URL.replace('public-rehearsal', 'public-production') }));
`);
  });

  it('publishes only its private boot-bound realm and preserves the receipt encoding exactly', () => {
    evaluate(`${RUNTIME}
try {
  assert.equal(handoff.migrationRuntimeStatus(parent, uid, boot, swaps), 'missing');
  assert.equal(handoff.receiveMigrationBundle(bytes, parent, uid, boot, swaps), 'ready');
  assert.equal(existsSync(join(parent, 'kf-workstation-credentials')), false);
  const generation = join(root, readlinkSync(join(root, 'current')));
  assert.deepEqual(readdirSync(generation).sort(), ['boot-id', 'database-url', 'rehearsal-database-url', 'rehearsal-receipt-key']);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(generation).mode & 0o777, 0o700);
  for (const name of readdirSync(generation)) assert.equal(statSync(join(generation, name)).mode & 0o777, 0o400);
  assert.equal(readFileSync(join(generation, 'database-url'), 'utf8'), env.KF_MIGRATOR_DATABASE_URL);
  const key = readFileSync(join(generation, 'rehearsal-receipt-key'));
  assert.equal(key.length, 64);
  assert.equal(key.toString(), env.KF_REHEARSAL_RECEIPT_KEY_HEX);
  assert.throws(() => handoff.migrationRuntimeStatus(parent, uid, '00000000-0000-0000-0000-000000000002', swaps));
} finally { rmSync(parent, { recursive: true, force: true }); }
`);
  });

  it('does not touch an existing startup generation on migration delivery or refusal', () => {
    evaluate(`${RUNTIME}
try {
  const startup = handoff.encodeBundle({ KF_ALERT_NTFY_URL:'https://ntfy.sh/public-fixture', KF_ALERT_HEARTBEAT_URL:'https://hc-ping.com/public-fixture', KF_RETRIEVAL_INDEX_KEY_HEX:'12'.repeat(32) });
  handoff.receiveBundle(startup, parent, uid, boot, swaps);
  const startupRoot = join(parent, 'kf-workstation-credentials');
  const startupBefore = readlinkSync(join(startupRoot, 'current'));
  handoff.receiveMigrationBundle(bytes, parent, uid, boot, swaps);
  const before = readlinkSync(join(root, 'current'));
  assert.throws(() => handoff.receiveMigrationBundle(startup, parent, uid, boot, swaps));
  assert.equal(readlinkSync(join(root, 'current')), before);
  assert.equal(readlinkSync(join(startupRoot, 'current')), startupBefore);
  assert.equal(handoff.runtimeStatus(parent, uid, boot, swaps), 'ready');
  assert.equal(handoff.migrationRuntimeStatus(parent, uid, boot, swaps), 'ready');
} finally { rmSync(parent, { recursive: true, force: true }); }
`);
  });

  it('refuses widened credentials, missing keys and post-delivery target drift', () => {
    evaluate(`${RUNTIME}
try {
  handoff.receiveMigrationBundle(bytes, parent, uid, boot, swaps);
  const generation = join(root, readlinkSync(join(root, 'current')));
  const keyPath = join(generation, 'rehearsal-receipt-key');
  chmodSync(keyPath, 0o440);
  assert.throws(() => handoff.migrationRuntimeStatus(parent, uid, boot, swaps));
  chmodSync(keyPath, 0o400);
  unlinkSync(keyPath);
  assert.equal(handoff.migrationRuntimeStatus(parent, uid, boot, swaps), 'missing');
  writeFileSync(keyPath, env.KF_REHEARSAL_RECEIPT_KEY_HEX, {mode:0o400});
  const connection = join(generation, 'rehearsal-database-url');
  chmodSync(connection, 0o600);
  writeFileSync(connection, env.KF_REHEARSAL_DATABASE_URL.replace(':5433', ':5432'));
  chmodSync(connection, 0o400);
  assert.throws(() => handoff.migrationRuntimeStatus(parent, uid, boot, swaps));
} finally { rmSync(parent, { recursive: true, force: true }); }
`);
  });

  it('refuses swap, wrong ownership, disk storage and escaping runtime links', () => {
    evaluate(`${RUNTIME}
try {
  assert.throws(() => handoff.receiveMigrationBundle(bytes, parent, uid, boot, swaps+'/swap file 1 0 -2\\n'));
  assert.throws(() => handoff.receiveMigrationBundle(bytes, parent, uid+1, boot, swaps));
  assert.equal(existsSync(root), false);
  const diskParent = [${JSON.stringify(ROOT)}, '/var/tmp'].find(path => statfsSync(path).type !== 0x01021994);
  assert.notEqual(diskParent, undefined);
  const disk = mkdtempSync(join(diskParent, '.kf-migration-handoff-proof-'));
  try { assert.throws(() => handoff.receiveMigrationBundle(bytes, disk, uid, boot, swaps)); }
  finally { rmSync(disk, { recursive:true, force:true }); }
  symlinkSync(parent, root);
  assert.throws(() => handoff.receiveMigrationBundle(bytes, parent, uid, boot, swaps));
  unlinkSync(root);
  handoff.receiveMigrationBundle(bytes, parent, uid, boot, swaps);
  unlinkSync(join(root, 'current'));
  symlinkSync('../outside', join(root, 'current'));
  assert.throws(() => handoff.receiveMigrationBundle(bytes, parent, uid, boot, swaps));
} finally { rmSync(parent, { recursive: true, force: true }); }
`);
  });

  it('logs no supplied payload on a refused migration command', () => {
    const result = spawnSync(process.execPath, [SCRIPT, 'migration-receive', 'forbidden'], {
      input: 'do-not-log-this-password',
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'workstation credential handoff refused; inspect the host locally\n',
    );
  });

  it('recovers the separate realm without invoking a migration or changing the startup timer', () => {
    const service = readFileSync(
      join(ROOT, 'deploy/workstation/kf-host-migration-credentials.service.in'),
      'utf8',
    );
    const timer = readFileSync(
      join(ROOT, 'deploy/workstation/kf-host-migration-credentials.timer.in'),
      'utf8',
    );
    expect(service).toContain('ExecStart=/usr/bin/node @SENDER@ migration-sync @CONFIG@');
    expect(service).toContain('LimitCORE=0');
    expect(service).not.toContain('migrate-release');
    expect(timer).toContain('Unit=kf-host-migration-credentials.service');
    expect(timer).toContain('OnUnitActiveSec=30s');
    expect(timer).not.toContain('After=kf-host-1.service');
    expect(
      readFileSync(join(ROOT, 'deploy/workstation/kf-host-credentials.service.in'), 'utf8'),
    ).toContain('ExecStart=/usr/bin/node @SENDER@ sync @CONFIG@');
  });
});
