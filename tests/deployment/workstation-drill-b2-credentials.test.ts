import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts/deploy/workstation-credentials.mjs');
const URL = JSON.stringify(pathToFileURL(SCRIPT).href);
const FIXTURE = `
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
const env = {
 KF_DRILL_B2_APPLICATION_KEY_ID:'public-reader-id-123456',
 KF_DRILL_B2_APPLICATION_KEY:'public-reader-token-123456',
 KF_B2_APPLICATION_KEY_ID:'public-uploader-id-123456',
 KF_B2_APPLICATION_KEY:'public-uploader-token-123456',
 KF_B2_S3_ENDPOINT:'https://s3.us-west-004.backblazeb2.com',
 KF_B2_BUCKET_NAME:'public-fixture-bucket',
 KF_ALERT_NTFY_URL:'https://ntfy.sh/public-fixture',
 KF_ALERT_HEARTBEAT_URL:'https://hc-ping.com/public-fixture',
 KF_RETRIEVAL_INDEX_KEY_HEX:'12'.repeat(32),
 KF_MIGRATOR_DATABASE_URL:'postgres://migrator:public-prod@127.0.0.1:5432/kf',
 KF_REHEARSAL_DATABASE_URL:'postgres://rehearsal:public-test@127.0.0.1:5433/kf_rehearsal',
 KF_REHEARSAL_RECEIPT_KEY_HEX:'34'.repeat(32),
 KF_BACKUP_DATABASE_URL:'postgres://backup_fixture:public-backup@127.0.0.1:5432/kf',
 KF_OFFSITE_DATABASE_URL:'postgres://offsite_fixture:public-offsite@127.0.0.1:5432/kf',
 KF_DRILL_DATABASE_URL:'postgres://drill_fixture:public-drill@127.0.0.1:5432/kf',
 KF_PRESERVATION_SIGNING_KEY_BASE64:Buffer.from(generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'})).toString('base64'),
 KF_BACKUP_RECOVERY_PRIVATE_KEY_BASE64:Buffer.from('-----BEGIN PGP PRIVATE KEY BLOCK-----\\npublic opaque armor\\n-----END PGP PRIVATE KEY BLOCK-----\\n').toString('base64'),
 KF_DRILL_S3_SECRET_ACCESS_KEY:'public-object-token',
 UNRELATED_SECRET:'public-do-not-export'
};
const profiles = [
 ['', 'runtimeStatus', 'kf-workstation-credentials'],
 ['Migration', 'migrationRuntimeStatus', 'kf-workstation-migration-credentials'],
 ['B2', 'b2RuntimeStatus', 'kf-workstation-b2-credentials'],
 ['Backup', 'backupRuntimeStatus', 'kf-workstation-backup-credentials'],
 ['Offsite', 'offsiteRuntimeStatus', 'kf-workstation-offsite-credentials'],
 ['Drill', 'drillRuntimeStatus', 'kf-workstation-drill-credentials'],
 ['DrillB2', 'drillB2RuntimeStatus', 'kf-workstation-drill-b2-credentials']
];
`;
const RUNTIME = `
import { mkdtempSync, readFileSync, readlinkSync, readdirSync, statSync, chmodSync, linkSync, unlinkSync, symlinkSync, writeFileSync, rmSync, existsSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
const parent = mkdtempSync('/dev/shm/kf-drill-b2-proof-');
const uid = process.getuid();
const boot = '00000000-0000-0000-0000-000000000001';
const swaps = 'Filename\\tType\\tSize\\tUsed\\tPriority\\n';
const root = join(parent,'kf-workstation-drill-b2-credentials');
const bytes = handoff.encodeDrillB2Bundle(env);
`;

function evaluate(body: string): void {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import * as handoff from ${URL};\n${FIXTURE}\n${body}`],
    { encoding: 'utf8', timeout: 10_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe('');
}

// Public fixture custody and framing, not provider read-only capability or recovery.
describe('separate B2 drill-reader delivery', () => {
  it('exports exactly two reader tokens, without any uploader or unrelated input', () => {
    evaluate(`
const bytes = handoff.encodeDrillB2Bundle(env);
assert.equal(bytes.toString(),'kf-workstation-drill-b2-credentials-v1\\npublic-reader-id-123456\\npublic-reader-token-123456\\n');
assert.deepEqual(handoff.decodeDrillB2Bundle(bytes),[env.KF_DRILL_B2_APPLICATION_KEY_ID,env.KF_DRILL_B2_APPLICATION_KEY]);
for (const value of [env.KF_B2_APPLICATION_KEY_ID,env.KF_B2_APPLICATION_KEY,env.KF_B2_S3_ENDPOINT,env.KF_B2_BUCKET_NAME,env['UNRELATED_SECRET']]) assert.equal(bytes.includes(value),false);
`);
  });

  it('refuses missing reader tokens even when valid uploader tokens exist, and vice versa', () => {
    evaluate(`
for (const name of ['KF_DRILL_B2_APPLICATION_KEY_ID','KF_DRILL_B2_APPLICATION_KEY']) assert.throws(() => handoff.encodeDrillB2Bundle({...env,[name]:undefined}));
for (const name of ['KF_B2_APPLICATION_KEY_ID','KF_B2_APPLICATION_KEY']) assert.throws(() => handoff.encodeB2Bundle({...env,[name]:undefined}));
const changed = {...env,KF_B2_APPLICATION_KEY_ID:'different-uploader-id',KF_B2_APPLICATION_KEY:'different-uploader-token'};
assert.deepEqual(handoff.encodeDrillB2Bundle(changed),handoff.encodeDrillB2Bundle(env));
`);
  });

  it('refuses noncanonical framing, invalid bytes, extra fields and every other protocol', () => {
    evaluate(`
const bytes = handoff.encodeDrillB2Bundle(env);
for (const bad of [Buffer.concat([bytes,Buffer.from('extra\\n')]),bytes.subarray(0,bytes.length-1),Buffer.from(bytes.toString().replaceAll('\\n','\\r\\n')),Buffer.alloc(16385),Buffer.from('kf-workstation-drill-b2-credentials-v1\\ninvalid\\n\\n')]) assert.throws(() => handoff.decodeDrillB2Bundle(bad));
const invalid = Buffer.from(bytes); invalid[invalid.indexOf('public-reader-token')] = 0xff;
assert.throws(() => handoff.decodeDrillB2Bundle(invalid));
for (const [role] of profiles.slice(0,-1)) {
 const other = handoff['encode'+role+'Bundle'](env);
 assert.throws(() => handoff.decodeDrillB2Bundle(other));
 assert.throws(() => handoff['decode'+role+'Bundle'](bytes));
}
`);
  });

  it('enforces the existing printable-token alphabet and exact per-field bounds', () => {
    evaluate(`
for (const name of ['KF_DRILL_B2_APPLICATION_KEY_ID','KF_DRILL_B2_APPLICATION_KEY']) {
 for (const bad of ['', 'a'.repeat(15), 'a'.repeat(513),'public-reader-12345\\n','public-reader-12345\\r','public-reader-12345 ','public-reader-12345"','public-reader-12345\\\\','public-reader-12345é']) assert.throws(() => handoff.encodeDrillB2Bundle({...env,[name]:bad}));
 for (const good of ['a'.repeat(16),'a'.repeat(512),'._/+~=-'.repeat(4)]) assert.equal(handoff.decodeDrillB2Bundle(handoff.encodeDrillB2Bundle({...env,[name]:good})).includes(good),true);
}
`);
  });

  it('publishes only private reader files and a boot binding, with a narrow runtime bound', () => {
    evaluate(`${RUNTIME}
try {
 assert.equal(handoff.drillB2RuntimeStatus(parent,uid,boot,swaps),'missing');
 assert.equal(handoff.receiveDrillB2Bundle(bytes,parent,uid,boot,swaps),'ready');
 const generation = join(root,readlinkSync(join(root,'current')));
 assert.deepEqual(readdirSync(generation).sort(),['b2-key','b2-key-id','boot-id']);
 for (const dir of [root,generation]) assert.equal(statSync(dir).mode & 0o777,0o700);
 for (const name of readdirSync(generation)) assert.equal(statSync(join(generation,name)).mode & 0o777,0o400);
 writeFileSync(join(generation,'unexpected'),'public unrelated file',{mode:0o400});
 assert.throws(() => handoff.drillB2RuntimeStatus(parent,uid,boot,swaps));
 unlinkSync(join(generation,'unexpected'));
 assert.equal(readFileSync(join(generation,'b2-key'),'utf8'),env.KF_DRILL_B2_APPLICATION_KEY);
 assert.equal(existsSync(join(parent,'kf-workstation-b2-credentials')),false);
 assert.throws(() => handoff.drillB2RuntimeStatus(parent,uid,'00000000-0000-0000-0000-000000000002',swaps));
 const path = join(generation,'b2-key'); chmodSync(path,0o600); writeFileSync(path,'a'.repeat(513)); chmodSync(path,0o400);
 assert.throws(() => handoff.drillB2RuntimeStatus(parent,uid,boot,swaps));
} finally { bytes.fill(0); rmSync(parent,{recursive:true,force:true}); }
`);
  });

  it('keeps all six prior realms unchanged across reader rotation and refused cross-realm updates', () => {
    evaluate(`${RUNTIME}
try {
 const payloads = profiles.map(([role]) => handoff['encode'+role+'Bundle'](env));
 profiles.forEach(([role],i) => handoff['receive'+role+'Bundle'](payloads[i],parent,uid,boot,swaps));
 const snapshot = () => profiles.slice(0,-1).map(([, , name]) => {
  const dir = join(parent,name), current = readlinkSync(join(dir,'current')), generation = join(dir,current);
  return [current,readdirSync(generation).sort().map(file => [file,readFileSync(join(generation,file),'utf8')])];
 });
 const before = snapshot(), current = readlinkSync(join(root,'current'));
 for (const payload of payloads.slice(0,-1)) assert.throws(() => handoff.receiveDrillB2Bundle(payload,parent,uid,boot,swaps));
 for (const [role] of profiles.slice(0,-1)) assert.throws(() => handoff['receive'+role+'Bundle'](bytes,parent,uid,boot,swaps));
 assert.equal(readlinkSync(join(root,'current')),current);
 handoff.receiveDrillB2Bundle(handoff.encodeDrillB2Bundle({...env,KF_DRILL_B2_APPLICATION_KEY:'public-rotated-reader-token'}),parent,uid,boot,swaps);
 assert.notEqual(readlinkSync(join(root,'current')),current);
 assert.deepEqual(snapshot(),before);
 for (const [,status] of profiles) assert.equal(handoff[status](parent,uid,boot,swaps),'ready');
} finally { bytes.fill(0); rmSync(parent,{recursive:true,force:true}); }
`);
  });

  it('refuses disk, swap, wrong ownership, widened modes and link redirection', () => {
    evaluate(`${RUNTIME}
try {
 assert.throws(() => handoff.receiveDrillB2Bundle(bytes,parent,uid,boot,swaps+'/swap file 1 0 -2\\n'));
 assert.throws(() => handoff.receiveDrillB2Bundle(bytes,parent,uid+1,boot,swaps));
 assert.equal(existsSync(root),false);
 const diskParent = [${JSON.stringify(ROOT)},'/var/tmp'].find(path => statfsSync(path).type !== 0x01021994);
 assert.notEqual(diskParent,undefined);
 const disk = mkdtempSync(join(diskParent,'.kf-drill-b2-proof-'));
 try { assert.throws(() => handoff.receiveDrillB2Bundle(bytes,disk,uid,boot,swaps)); } finally { rmSync(disk,{recursive:true,force:true}); }
 symlinkSync(parent,root); assert.throws(() => handoff.receiveDrillB2Bundle(bytes,parent,uid,boot,swaps)); unlinkSync(root);
 handoff.receiveDrillB2Bundle(bytes,parent,uid,boot,swaps);
 const generation = join(root,readlinkSync(join(root,'current'))), path = join(generation,'b2-key');
 chmodSync(path,0o440); assert.throws(() => handoff.drillB2RuntimeStatus(parent,uid,boot,swaps)); chmodSync(path,0o400);
 linkSync(path,join(parent,'hard-link')); assert.throws(() => handoff.drillB2RuntimeStatus(parent,uid,boot,swaps)); unlinkSync(join(parent,'hard-link'));
 unlinkSync(path); assert.equal(handoff.drillB2RuntimeStatus(parent,uid,boot,swaps),'missing');
 symlinkSync(join(generation,'b2-key-id'),path); assert.throws(() => handoff.drillB2RuntimeStatus(parent,uid,boot,swaps));
 unlinkSync(path); writeFileSync(path,'invalid',{mode:0o400}); assert.throws(() => handoff.drillB2RuntimeStatus(parent,uid,boot,swaps));
 unlinkSync(join(root,'current')); symlinkSync('../outside',join(root,'current')); assert.throws(() => handoff.receiveDrillB2Bundle(bytes,parent,uid,boot,swaps));
} finally { bytes.fill(0); rmSync(parent,{recursive:true,force:true}); }
`);
  });

  it('admits only closed reader commands and never logs a refused payload', () => {
    for (const action of [
      'drill-b2-receive',
      'drill-b2-status',
      'drill-b2-send',
      'drill-b2-sync',
      'reader-receive',
    ]) {
      const result = spawnSync(process.execPath, [SCRIPT, action, 'forbidden', 'extra'], {
        input: 'public-do-not-log-payload',
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

  it('defines a distinct recovery timer invoking only the reader credential sync', () => {
    const service = readFileSync(
      join(ROOT, 'deploy/workstation/kf-host-drill-b2-credentials.service.in'),
      'utf8',
    );
    const timer = readFileSync(
      join(ROOT, 'deploy/workstation/kf-host-drill-b2-credentials.timer.in'),
      'utf8',
    );
    expect(service).toContain('ExecStart=/usr/bin/node @SENDER@ drill-b2-sync @CONFIG@');
    expect(service).toContain('LimitCORE=0');
    expect(service).toContain('UMask=0077');
    expect(service).not.toContain(' b2-sync ');
    expect(timer).toContain('Unit=kf-host-drill-b2-credentials.service');
    for (const text of [service, timer])
      expect(text).not.toMatch(/backup\.sh|restore-drill\.sh|migrate-release\.sh/);
  });
});
