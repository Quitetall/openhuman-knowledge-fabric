import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts/deploy/workstation-credentials.mjs');
const URL = JSON.stringify(pathToFileURL(SCRIPT).href);

// Public ephemeral keys and opaque armor fixtures, not real custody or GPG validity.
const FIXTURE = `
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
const pem = generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8', format:'pem'});
const armor = '-----BEGIN PGP PRIVATE KEY BLOCK-----\\n\\ncHVibGljLWZpeHR1cmU=\\n-----END PGP PRIVATE KEY BLOCK-----\\n';
const env = {
 KF_BACKUP_DATABASE_URL:'postgres://backup_fixture:public-backup@127.0.0.1:5432/kf',
 KF_OFFSITE_DATABASE_URL:'postgres://offsite_fixture:public-offsite@127.0.0.1:5432/kf',
 KF_DRILL_DATABASE_URL:'postgres://drill_fixture:public-drill@127.0.0.1:5432/kf',
 KF_PRESERVATION_SIGNING_KEY_BASE64:Buffer.from(pem).toString('base64'),
 KF_BACKUP_RECOVERY_PRIVATE_KEY_BASE64:Buffer.from(armor).toString('base64'),
 KF_DRILL_S3_SECRET_ACCESS_KEY:'public-read-only-object-token',
 KF_REHEARSAL_RECEIPT_KEY_HEX:'34'.repeat(32),
 KF_RETRIEVAL_INDEX_KEY_HEX:'56'.repeat(32),
 KF_B2_APPLICATION_KEY:'do-not-export-b2',
 UNRELATED_SECRET:'do-not-export-unrelated'
};
const roles = ['Backup','Offsite','Drill'];
const fields = [[env.KF_BACKUP_DATABASE_URL,pem], [env.KF_OFFSITE_DATABASE_URL], [env.KF_DRILL_DATABASE_URL,armor,env.KF_DRILL_S3_SECRET_ACCESS_KEY]];
`;

const RUNTIME = `
import { mkdtempSync, readFileSync, readlinkSync, readdirSync, statSync, chmodSync, linkSync, unlinkSync, symlinkSync, writeFileSync, rmSync, existsSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
const parent = mkdtempSync('/dev/shm/kf-preservation-handoff-proof-');
const uid = process.getuid();
const boot = '00000000-0000-0000-0000-000000000001';
const swaps = 'Filename\\tType\\tSize\\tUsed\\tPriority\\n';
const roots = roles.map(role => join(parent, 'kf-workstation-'+role.toLowerCase()+'-credentials'));
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

describe('purpose-separated workstation preservation delivery', () => {
  it('frames only each role’s fixed inputs and preserves decoded key bytes', () => {
    evaluate(`
roles.forEach((role,i) => {
 const bytes = handoff['encode'+role+'Bundle'](env);
 const lines = bytes.toString().split('\\n');
 assert.equal(lines[0], 'kf-workstation-'+role.toLowerCase()+'-credentials-v1');
 assert.equal(lines.length, fields[i].length+2);
 assert.deepEqual(handoff['decode'+role+'Bundle'](bytes), fields[i]);
 assert.deepEqual(lines.slice(1,-1).map(line => Buffer.from(line,'base64').toString()), fields[i]);
 for (const value of ['do-not-export','34'.repeat(32),'56'.repeat(32)]) assert.equal(bytes.includes(value), false);
 assert.equal(bytes.includes(Buffer.from('do-not-export-unrelated').toString('base64')), false);
});
`);
  });

  it('refuses missing fields, role confusion, extra framing and noncanonical base64', () => {
    evaluate(`
const names = [['KF_BACKUP_DATABASE_URL','KF_PRESERVATION_SIGNING_KEY_BASE64'],['KF_OFFSITE_DATABASE_URL'],['KF_DRILL_DATABASE_URL','KF_BACKUP_RECOVERY_PRIVATE_KEY_BASE64','KF_DRILL_S3_SECRET_ACCESS_KEY']];
roles.forEach((role,i) => {
 const encode = handoff['encode'+role+'Bundle'], decode = handoff['decode'+role+'Bundle'];
 const bytes = encode(env);
 names[i].forEach(name => assert.throws(() => encode({...env,[name]:undefined})));
 for (const other of roles.filter(other => other !== role)) assert.throws(() => handoff['decode'+other+'Bundle'](bytes));
 for (const old of [handoff.decodeBundle,handoff.decodeMigrationBundle,handoff.decodeB2Bundle]) assert.throws(() => old(bytes));
 for (const bad of [Buffer.concat([bytes,Buffer.from('extra\\n')]),bytes.subarray(0,bytes.length-1),Buffer.alloc(112641)]) assert.throws(() => decode(bad));
 const lines = bytes.toString().split('\\n');
 for (const value of ['',lines[1]+'=',lines[1]+' ', '_bad_', '%%%%']) {
  const altered = [...lines]; altered[1] = value; assert.throws(() => decode(Buffer.from(altered.join('\\n'))));
 }
});
for (const name of ['KF_PRESERVATION_SIGNING_KEY_BASE64','KF_BACKUP_RECOVERY_PRIVATE_KEY_BASE64']) {
 const encode = name.includes('SIGNING') ? handoff.encodeBackupBundle : handoff.encodeDrillBundle;
 for (const bad of ['',env[name]+'\\n',env[name]+'=',env[name]+' ',Buffer.from('not a private key').toString('base64')]) assert.throws(() => encode({...env,[name]:bad}));
}
`);
  });

  it('refuses redirected database strings and wrong signing-key algorithms', () => {
    evaluate(`
for (const role of roles) {
 const name = 'KF_'+role.toUpperCase()+'_DATABASE_URL';
 for (const bad of [env[name].replace('127.0.0.1','localhost'),env[name].replace(':5432',':5433'),env[name]+'?host=elsewhere',env[name]+'#x',env[name].replace('/kf','/postgres'),env[name].replace('public-','encoded%40')]) assert.throws(() => handoff['encode'+role+'Bundle']({...env,[name]:bad}));
}
const wrong = generateKeyPairSync('x25519').privateKey.export({type:'pkcs8',format:'pem'});
assert.throws(() => handoff.encodeBackupBundle({...env,KF_PRESERVATION_SIGNING_KEY_BASE64:Buffer.from(wrong).toString('base64')}));
assert.throws(() => handoff.encodeDrillBundle({...env,KF_DRILL_S3_SECRET_ACCESS_KEY:'token\\n'}));
`);
  });

  it('allows the recovery bound without widening any existing realm or file bound', () => {
    evaluate(`${RUNTIME}
try {
 const prefix = '-----BEGIN PGP PRIVATE KEY BLOCK-----\\n', suffix = '\\n-----END PGP PRIVATE KEY BLOCK-----\\n';
 const large = prefix+'A'.repeat(65536-prefix.length-suffix.length)+suffix;
 const next = {...env,KF_BACKUP_RECOVERY_PRIVATE_KEY_BASE64:Buffer.from(large).toString('base64')};
 const bytes = handoff.encodeDrillBundle(next);
 assert.ok(bytes.length > 16384 && bytes.length <= 112640);
 assert.equal(handoff.receiveDrillBundle(bytes,parent,uid,boot,swaps),'ready');
 assert.equal(handoff.drillRuntimeStatus(parent,uid,boot,swaps),'ready');
 assert.throws(() => handoff.encodeDrillBundle({...next,KF_BACKUP_RECOVERY_PRIVATE_KEY_BASE64:Buffer.from(large+'A').toString('base64')}));
 const file = join(roots[2],readlinkSync(join(roots[2],'current')),'backup-decryption-key');
 chmodSync(file,0o600); writeFileSync(file,large+'A'); chmodSync(file,0o400);
 assert.throws(() => handoff.drillRuntimeStatus(parent,uid,boot,swaps));
 for (const decode of [handoff.decodeBundle,handoff.decodeMigrationBundle,handoff.decodeB2Bundle,handoff.decodeBackupBundle,handoff.decodeOffsiteBundle]) assert.throws(() => decode(bytes));
} finally {rmSync(parent,{recursive:true,force:true});}
`);
  });

  it('publishes exactly the credential set permitted for each consumer identity', () => {
    evaluate(`${RUNTIME}
try {
 const expected = [['database-url','preservation-signing-key'],['database-url'],['database-url','backup-decryption-key','s3-secret-access-key']];
 roles.forEach((role,i) => {
  assert.equal(handoff[role.toLowerCase()+'RuntimeStatus'](parent,uid,boot,swaps),'missing');
  assert.equal(handoff['receive'+role+'Bundle'](handoff['encode'+role+'Bundle'](env),parent,uid,boot,swaps),'ready');
  const generation = join(roots[i],readlinkSync(join(roots[i],'current')));
  assert.deepEqual(readdirSync(generation).sort(),[...expected[i],'boot-id'].sort());
  for (const dir of [roots[i],generation]) assert.equal(statSync(dir).mode & 0o777,0o700);
  expected[i].forEach((name,j) => {assert.equal(statSync(join(generation,name)).mode & 0o777,0o400); assert.equal(readFileSync(join(generation,name),'utf8'),fields[i][j]);});
 });
} finally {rmSync(parent,{recursive:true,force:true});}
`);
  });

  it('keeps all other generations unchanged during a rotation or refused update', () => {
    evaluate(`${RUNTIME}
try {
 const old = [handoff.encodeBundle({KF_ALERT_NTFY_URL:'https://ntfy.sh/public',KF_ALERT_HEARTBEAT_URL:'https://hc-ping.com/public',KF_RETRIEVAL_INDEX_KEY_HEX:'12'.repeat(32)}),handoff.encodeMigrationBundle({KF_MIGRATOR_DATABASE_URL:'postgres://migrator:public-prod@127.0.0.1:5432/kf',KF_REHEARSAL_DATABASE_URL:'postgres://rehearsal:public-test@127.0.0.1:5433/kf_rehearsal',KF_REHEARSAL_RECEIPT_KEY_HEX:'34'.repeat(32)}),handoff.encodeB2Bundle({KF_B2_S3_ENDPOINT:'https://s3.us-west-004.backblazeb2.com',KF_B2_BUCKET_NAME:'public-fixture',KF_B2_APPLICATION_KEY_ID:'public-id-1234567',KF_B2_APPLICATION_KEY:'public-key-123456'})];
 [handoff.receiveBundle,handoff.receiveMigrationBundle,handoff.receiveB2Bundle].forEach((receive,i) => receive(old[i],parent,uid,boot,swaps));
 const oldRoots = ['kf-workstation-credentials','kf-workstation-migration-credentials','kf-workstation-b2-credentials'].map(name => join(parent,name));
 const oldBefore = oldRoots.map(path => readlinkSync(join(path,'current')));
 roles.forEach(role => handoff['receive'+role+'Bundle'](handoff['encode'+role+'Bundle'](env),parent,uid,boot,swaps));
 assert.deepEqual(oldRoots.map(path => readlinkSync(join(path,'current'))),oldBefore);
 const allRoots = ['kf-workstation-credentials','kf-workstation-migration-credentials','kf-workstation-b2-credentials',...roots.map(path => path.split('/').at(-1))].map(name => join(parent,name));
 roles.forEach((role,i) => {
  const before = allRoots.map(path => readlinkSync(join(path,'current')));
  for (const bad of [...old,Buffer.from('bad')]) assert.throws(() => handoff['receive'+role+'Bundle'](bad,parent,uid,boot,swaps));
  assert.deepEqual(allRoots.map(path => readlinkSync(join(path,'current'))),before);
  const next = {...env,['KF_'+role.toUpperCase()+'_DATABASE_URL']:env['KF_'+role.toUpperCase()+'_DATABASE_URL'].replace('public-','rotated-')};
  handoff['receive'+role+'Bundle'](handoff['encode'+role+'Bundle'](next),parent,uid,boot,swaps);
  const after = allRoots.map(path => readlinkSync(join(path,'current')));
  after.forEach((value,j) => j===i+3 ? assert.notEqual(value,before[j]) : assert.equal(value,before[j]));
 });
} finally {rmSync(parent,{recursive:true,force:true});}
`);
  });

  it('refuses widened, linked, missing, drifted and wrong-boot credentials', () => {
    evaluate(`${RUNTIME}
try {
 roles.forEach((role,i) => {
  handoff['receive'+role+'Bundle'](handoff['encode'+role+'Bundle'](env),parent,uid,boot,swaps);
  const status = () => handoff[role.toLowerCase()+'RuntimeStatus'](parent,uid,boot,swaps);
  const file = join(roots[i],readlinkSync(join(roots[i],'current')),'database-url');
  chmodSync(file,0o440); assert.throws(status); chmodSync(file,0o400);
  linkSync(file,join(parent,'linked')); assert.throws(status); unlinkSync(join(parent,'linked'));
  unlinkSync(file); assert.equal(status(),'missing');
  symlinkSync('/proc/version',file); assert.throws(status); unlinkSync(file);
  writeFileSync(file,'invalid',{mode:0o400}); assert.throws(status);
  assert.throws(() => handoff[role.toLowerCase()+'RuntimeStatus'](parent,uid,'00000000-0000-0000-0000-000000000002',swaps));
 });
} finally {rmSync(parent,{recursive:true,force:true});}
`);
  });

  it('refuses swap, wrong ownership, disk storage and escaping generations before publication', () => {
    evaluate(`${RUNTIME}
try {
 roles.forEach((role,i) => {
  const receive = handoff['receive'+role+'Bundle'], bytes = handoff['encode'+role+'Bundle'](env);
  assert.throws(() => receive(bytes,parent,uid+1,boot,swaps));
  assert.throws(() => receive(bytes,parent,uid,boot,swaps+'/swap file 1 0 -2\\n'));
  assert.equal(existsSync(roots[i]),false);
  const diskBase = [${JSON.stringify(ROOT)},'/var/tmp'].find(path => statfsSync(path).type!==0x01021994);
  assert.ok(diskBase); const disk = mkdtempSync(join(diskBase,'.kf-preservation-proof-'));
  try {assert.throws(() => receive(bytes,disk,uid,boot,swaps));} finally {rmSync(disk,{recursive:true,force:true});}
  symlinkSync(parent,roots[i]); assert.throws(() => receive(bytes,parent,uid,boot,swaps)); unlinkSync(roots[i]);
  receive(bytes,parent,uid,boot,swaps);
  unlinkSync(join(roots[i],'current')); symlinkSync('../outside',join(roots[i],'current'));
  assert.throws(() => receive(bytes,parent,uid,boot,swaps));
 });
} finally {rmSync(parent,{recursive:true,force:true});}
`);
  });

  it('logs no supplied secrets and exposes no arbitrary consumer selector', () => {
    for (const role of ['backup', 'offsite', 'drill', 'arbitrary']) {
      for (const verb of ['receive', 'status', 'send', 'sync']) {
        const result = spawnSync(process.execPath, [SCRIPT, `${role}-${verb}`, 'forbidden'], {
          input: 'never-print-this-payload',
          encoding: 'utf8',
          timeout: 10_000,
        });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe(
          'workstation credential handoff refused; inspect the host locally\n',
        );
      }
    }
  });

  it('defines separate custody timers that never invoke a backup or recovery', () => {
    for (const role of ['backup', 'offsite', 'drill']) {
      const service = readFileSync(
        join(ROOT, `deploy/workstation/kf-host-${role}-credentials.service.in`),
        'utf8',
      );
      const timer = readFileSync(
        join(ROOT, `deploy/workstation/kf-host-${role}-credentials.timer.in`),
        'utf8',
      );
      expect(service).toContain(`ExecStart=/usr/bin/node @SENDER@ ${role}-sync @CONFIG@`);
      expect(service).toContain('LimitCORE=0');
      expect(service).toMatch(/^MemorySwapMax=0$/m);
      expect(service).not.toMatch(
        /^Exec[^=]*=.*(?:backup\.sh|backup-offsite\.sh|restore-drill\.sh|migrate-release\.sh)/m,
      );
      expect(service).not.toMatch(
        /^(?:Wants|Requires)=.*kf-(?:backup|backup-offsite|restore-drill)\.service/m,
      );
      expect(timer).toContain(`Unit=kf-host-${role}-credentials.service`);
      expect(timer).toContain('OnUnitActiveSec=30s');
      expect(timer).not.toContain('After=kf-host-1.service');
    }
  });
});
