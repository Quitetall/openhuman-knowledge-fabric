import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts/deploy/workstation-credentials.mjs');
const URL = JSON.stringify(pathToFileURL(SCRIPT).href);
const ENV = `{
  KF_B2_S3_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
  KF_B2_BUCKET_NAME: 'public-fixture-bucket',
  KF_B2_APPLICATION_KEY_ID: 'public-key-id-123456',
  KF_B2_APPLICATION_KEY: 'public-application-key-123456',
  KF_MIGRATOR_DATABASE_URL: 'never-export-database',
  KF_RETRIEVAL_INDEX_KEY_HEX: '12'.repeat(32),
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

// Public fixture values only. This proves custody/framing, not provider access or backup readiness.
const RUNTIME = `
import { mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, chmodSync, symlinkSync, unlinkSync, existsSync, readdirSync, statfsSync, writeFileSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const parent = mkdtempSync('/dev/shm/kf-b2-handoff-proof-');
const uid = process.getuid();
const boot = '00000000-0000-0000-0000-000000000001';
const swaps = 'Filename\\tType\\tSize\\tUsed\\tPriority\\n';
const env = ${ENV};
const bytes = handoff.encodeB2Bundle(env);
const root = join(parent, 'kf-workstation-b2-credentials');
`;

describe('separate workstation B2 credential handoff', () => {
  it('transmits only four fixed B2 settings and normalizes the endpoint', () => {
    const output = evaluate(`process.stdout.write(handoff.encodeB2Bundle(${ENV}));`);
    expect(output).toBe(
      'kf-workstation-b2-credentials-v1\nhttps://s3.us-west-004.backblazeb2.com\npublic-fixture-bucket\npublic-key-id-123456\npublic-application-key-123456\n',
    );
    expect(output).not.toContain('never-export');
    expect(output).not.toContain('12'.repeat(32));
    evaluate(`
import assert from 'node:assert/strict';
const env = ${ENV};
assert.deepEqual(handoff.encodeB2Bundle({ ...env, KF_B2_S3_ENDPOINT: env.KF_B2_S3_ENDPOINT+'/' }), handoff.encodeB2Bundle(env));
assert.deepEqual(handoff.decodeB2Bundle(handoff.encodeB2Bundle(env)), [env.KF_B2_S3_ENDPOINT, env.KF_B2_BUCKET_NAME, env.KF_B2_APPLICATION_KEY_ID, env.KF_B2_APPLICATION_KEY]);
`);
  });

  it('refuses missing fields, invalid framing and cross-realm payloads', () => {
    evaluate(`
import assert from 'node:assert/strict';
const env = ${ENV};
const bytes = handoff.encodeB2Bundle(env);
for (const name of ['KF_B2_S3_ENDPOINT', 'KF_B2_BUCKET_NAME', 'KF_B2_APPLICATION_KEY_ID', 'KF_B2_APPLICATION_KEY']) {
  assert.throws(() => handoff.encodeB2Bundle({ ...env, [name]: undefined }));
}
for (const decoder of [handoff.decodeBundle, handoff.decodeMigrationBundle]) assert.throws(() => decoder(bytes));
for (const protocol of ['kf-workstation-credentials-v2', 'kf-workstation-migration-credentials-v1']) {
  assert.throws(() => handoff.decodeB2Bundle(Buffer.from(bytes.toString().replace('kf-workstation-b2-credentials-v1', protocol))));
}
assert.throws(() => handoff.decodeB2Bundle(Buffer.concat([bytes, Buffer.from('extra\\n')])));
assert.throws(() => handoff.decodeB2Bundle(bytes.subarray(0, bytes.length-1)));
assert.throws(() => handoff.decodeB2Bundle(Buffer.alloc(16385)));
`);
  });

  it('refuses ambiguous endpoints and matches the transport credential alphabets and bounds', () => {
    evaluate(`
import assert from 'node:assert/strict';
const env = ${ENV};
for (const value of ['', 'http://s3.us-west-004.backblazeb2.com', 'https://user:pass@s3.us-west-004.backblazeb2.com',
 'https://s3.us-west-004.backblazeb2.com.evil.test', 'https://s3.us-west-004.backblazeb2.com:443',
 env.KF_B2_S3_ENDPOINT+'/path', env.KF_B2_S3_ENDPOINT+'?token=x', env.KF_B2_S3_ENDPOINT+'#x',
 env.KF_B2_S3_ENDPOINT+'\\n', 'https://s3.us-west-004.backblazeb2.com//', 'https://s3.fake.backblazeb2.com']) {
 assert.throws(() => handoff.encodeB2Bundle({ ...env, KF_B2_S3_ENDPOINT: value }));
}
for (const value of ['', 'short', 'A'.repeat(6), '-bucket', 'bucket-', 'a'.repeat(64), 'bucket/name', 'bucket\\nname']) {
 assert.throws(() => handoff.encodeB2Bundle({ ...env, KF_B2_BUCKET_NAME: value }));
}
for (const name of ['KF_B2_APPLICATION_KEY_ID', 'KF_B2_APPLICATION_KEY']) {
 for (const value of ['', 'a'.repeat(15), 'a'.repeat(513), 'public-key-12345\\n', 'public-key-12345\\r', 'public-key-12345 ', 'public-key-12345"', 'public-key-12345\\\\', 'public-key-12345é']) {
  assert.throws(() => handoff.encodeB2Bundle({ ...env, [name]: value }));
 }
 for (const value of ['a'.repeat(16), 'a'.repeat(512), '._/+~=-'.repeat(4)]) {
  assert.equal(handoff.decodeB2Bundle(handoff.encodeB2Bundle({ ...env, [name]: value })).includes(value), true);
 }
}
`);
  });

  it('creates exactly four private credentials and a boot binding in its own tmpfs generation', () => {
    evaluate(`${RUNTIME}
try {
 assert.equal(handoff.b2RuntimeStatus(parent, uid, boot, swaps), 'missing');
 assert.equal(handoff.receiveB2Bundle(bytes, parent, uid, boot, swaps), 'ready');
 assert.equal(existsSync(join(parent, 'kf-workstation-credentials')), false);
 assert.equal(existsSync(join(parent, 'kf-workstation-migration-credentials')), false);
 const generation = join(root, readlinkSync(join(root, 'current')));
 assert.deepEqual(readdirSync(generation).sort(), ['b2-bucket', 'b2-endpoint', 'b2-key', 'b2-key-id', 'boot-id']);
 for (const path of [root, generation]) assert.equal(statSync(path).mode & 0o777, 0o700);
 for (const name of readdirSync(generation)) assert.equal(statSync(join(generation, name)).mode & 0o777, 0o400);
 assert.equal(readFileSync(join(generation, 'b2-key'), 'utf8'), env.KF_B2_APPLICATION_KEY);
 assert.throws(() => handoff.b2RuntimeStatus(parent, uid, '00000000-0000-0000-0000-000000000002', swaps));
} finally { bytes.fill(0); rmSync(parent, { recursive:true, force:true }); }
`);
  });

  it('keeps both other realms unchanged across accepted B2 rotation and refused updates', () => {
    evaluate(`${RUNTIME}
try {
 const startup = handoff.encodeBundle({ KF_ALERT_NTFY_URL:'https://ntfy.sh/public-fixture', KF_ALERT_HEARTBEAT_URL:'https://hc-ping.com/public-fixture', KF_RETRIEVAL_INDEX_KEY_HEX:'12'.repeat(32) });
 const migration = handoff.encodeMigrationBundle({ KF_MIGRATOR_DATABASE_URL:'postgres://kf_migrator:production-public@127.0.0.1:5432/kf', KF_REHEARSAL_DATABASE_URL:'postgres://kf_rehearsal:rehearsal-public@127.0.0.1:5433/kf_rehearsal', KF_REHEARSAL_RECEIPT_KEY_HEX:'34'.repeat(32) });
 handoff.receiveBundle(startup, parent, uid, boot, swaps);
 handoff.receiveMigrationBundle(migration, parent, uid, boot, swaps);
 const otherRoots = ['kf-workstation-credentials', 'kf-workstation-migration-credentials'].map(name => join(parent, name));
 const otherBefore = otherRoots.map(path => readlinkSync(join(path, 'current')));
 handoff.receiveB2Bundle(bytes, parent, uid, boot, swaps);
 const before = readlinkSync(join(root, 'current'));
 for (const other of [startup, migration, Buffer.from('bad')]) assert.throws(() => handoff.receiveB2Bundle(other, parent, uid, boot, swaps));
 assert.equal(readlinkSync(join(root, 'current')), before);
 for (const receiver of [handoff.receiveBundle, handoff.receiveMigrationBundle]) assert.throws(() => receiver(bytes, parent, uid, boot, swaps));
 const rotated = handoff.encodeB2Bundle({ ...env, KF_B2_APPLICATION_KEY:'public-rotated-key-123456' });
 handoff.receiveB2Bundle(rotated, parent, uid, boot, swaps);
 assert.notEqual(readlinkSync(join(root, 'current')), before);
 assert.deepEqual(otherRoots.map(path => readlinkSync(join(path, 'current'))), otherBefore);
 assert.equal(handoff.runtimeStatus(parent, uid, boot, swaps), 'ready');
 assert.equal(handoff.migrationRuntimeStatus(parent, uid, boot, swaps), 'ready');
 assert.equal(handoff.b2RuntimeStatus(parent, uid, boot, swaps), 'ready');
} finally { bytes.fill(0); rmSync(parent, { recursive:true, force:true }); }
`);
  });

  it('refuses disk storage, swap, wrong ownership and escaping runtime links', () => {
    evaluate(`${RUNTIME}
try {
 assert.throws(() => handoff.receiveB2Bundle(bytes, parent, uid, boot, swaps+'/swap file 1 0 -2\\n'));
 assert.throws(() => handoff.receiveB2Bundle(bytes, parent, uid+1, boot, swaps));
 assert.equal(existsSync(root), false);
 const diskParent = [${JSON.stringify(ROOT)}, '/var/tmp'].find(path => statfsSync(path).type !== 0x01021994);
 assert.notEqual(diskParent, undefined);
 const disk = mkdtempSync(join(diskParent, '.kf-b2-handoff-proof-'));
 try { assert.throws(() => handoff.receiveB2Bundle(bytes, disk, uid, boot, swaps)); }
 finally { rmSync(disk, { recursive:true, force:true }); }
 symlinkSync(parent, root);
 assert.throws(() => handoff.receiveB2Bundle(bytes, parent, uid, boot, swaps));
 unlinkSync(root);
 handoff.receiveB2Bundle(bytes, parent, uid, boot, swaps);
 unlinkSync(join(root, 'current'));
 symlinkSync('../outside', join(root, 'current'));
 assert.throws(() => handoff.receiveB2Bundle(bytes, parent, uid, boot, swaps));
} finally { bytes.fill(0); rmSync(parent, { recursive:true, force:true }); }
`);
  });

  it('refuses missing, widened, hard-linked, symlinked or drifted credential files', () => {
    evaluate(`${RUNTIME}
try {
 handoff.receiveB2Bundle(bytes, parent, uid, boot, swaps);
 const generation = join(root, readlinkSync(join(root, 'current')));
 const path = join(generation, 'b2-key');
 chmodSync(path, 0o440);
 assert.throws(() => handoff.b2RuntimeStatus(parent, uid, boot, swaps));
 chmodSync(path, 0o400);
 linkSync(path, join(parent, 'hard-link'));
 assert.throws(() => handoff.b2RuntimeStatus(parent, uid, boot, swaps));
 unlinkSync(join(parent, 'hard-link'));
 unlinkSync(path);
 assert.equal(handoff.b2RuntimeStatus(parent, uid, boot, swaps), 'missing');
 symlinkSync(join(generation, 'b2-key-id'), path);
 assert.throws(() => handoff.b2RuntimeStatus(parent, uid, boot, swaps));
 unlinkSync(path);
 writeFileSync(path, 'invalid', {mode:0o400});
 assert.throws(() => handoff.b2RuntimeStatus(parent, uid, boot, swaps));
} finally { bytes.fill(0); rmSync(parent, { recursive:true, force:true }); }
`);
  });

  it('logs no supplied payload on refused commands and accepts no arbitrary realm name', () => {
    for (const action of ['b2-receive', 'b2-status', 'b2-send', 'b2-sync', 'arbitrary-receive']) {
      const result = spawnSync(process.execPath, [SCRIPT, action, 'forbidden'], {
        input: 'do-not-log-this-password',
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(
        'workstation credential handoff refused; inspect the host locally\n',
      );
    }
  });

  it('defines its own recovery timer without activating a backup, drill or migration', () => {
    const service = readFileSync(
      join(ROOT, 'deploy/workstation/kf-host-b2-credentials.service.in'),
      'utf8',
    );
    const timer = readFileSync(
      join(ROOT, 'deploy/workstation/kf-host-b2-credentials.timer.in'),
      'utf8',
    );
    expect(service).toContain('ExecStart=/usr/bin/node @SENDER@ b2-sync @CONFIG@');
    expect(service).toContain('LimitCORE=0');
    expect(service).toMatch(/^MemorySwapMax=0$/m);
    expect(service).not.toMatch(/backup-offsite|restore-drill|migrate-release/);
    expect(timer).toContain('Unit=kf-host-b2-credentials.service');
    expect(timer).toContain('OnUnitActiveSec=30s');
    expect(timer).not.toContain('After=kf-host-1.service');
  });
});
