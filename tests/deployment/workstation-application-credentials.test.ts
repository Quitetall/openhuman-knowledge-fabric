// Public transport/runtime fixtures are not real logins, signing authority or commissioning.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/deploy/workstation-credentials.mjs');
const FIXTURE = `
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import * as handoff from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
const roles=['api','worker','attestor','checkpoint','storage','readiness'];
const names=[['database-url','s3-secret-access-key','s3-durable-secret-access-key','readiness-token','master-record-link-secret'],['database-url','s3-secret-access-key'],['database-url'],['database-url','checkpoint-signing-key','s3-secret-access-key'],['database-url','s3-secret-access-key','s3-durable-secret-access-key'],['database-url']];
const sources=[['DATABASE_URL','S3_SECRET_ACCESS_KEY','S3_DURABLE_SECRET_ACCESS_KEY','READINESS_TOKEN','MASTER_RECORD_LINK_SECRET'],['DATABASE_URL','S3_SECRET_ACCESS_KEY'],['DATABASE_URL'],['DATABASE_URL','SIGNING_KEY_BASE64','S3_SECRET_ACCESS_KEY'],['DATABASE_URL','S3_SECRET_ACCESS_KEY','S3_DURABLE_SECRET_ACCESS_KEY'],['DATABASE_URL']];
const consumers=[['DATABASE_URL_FILE','S3_SECRET_ACCESS_KEY_FILE','S3_DURABLE_SECRET_ACCESS_KEY_FILE','KF_READINESS_TOKEN_FILE','KF_MASTER_RECORD_LINK_SECRET_FILE'],['WORKER_DATABASE_URL_FILE','S3_SECRET_ACCESS_KEY_FILE'],['DATABASE_URL_FILE'],['DATABASE_URL_FILE','CHECKPOINT_SIGNING_KEY_PATH','CHECKPOINT_S3_SECRET_ACCESS_KEY_FILE'],['DATABASE_URL_FILE','S3_SECRET_ACCESS_KEY_FILE','S3_DURABLE_SECRET_ACCESS_KEY_FILE'],['DATABASE_URL_FILE']];
const pem=generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'});
const env={UNRELATED_SECRET:'never-export-this',KF_PRESERVATION_SIGNING_KEY_BASE64:Buffer.from(pem).toString('base64'),KF_REHEARSAL_RECEIPT_KEY_HEX:'34'.repeat(32),KF_B2_APPLICATION_KEY:'never-use-uploader',KF_RETRIEVAL_INDEX_KEY_HEX:'56'.repeat(32)};
const fields=roles.map((role,i)=>sources[i].map((source,j)=>{
 const value=source==='DATABASE_URL'?'postgres://kf_'+role+'_login:public-'+role+'@127.0.0.1:5432/kf':source==='SIGNING_KEY_BASE64'?pem:source.includes('TOKEN')||source.includes('LINK_SECRET')?'12'.repeat(32):'public-'+role+'-'+source;
 env['KF_'+role.toUpperCase()+'_'+source]=source==='SIGNING_KEY_BASE64'?Buffer.from(value).toString('base64'):value;
 return value;
}));
`;
const RUNTIME = `
import { mkdtempSync,readFileSync,readlinkSync,readdirSync,statSync,chmodSync,writeFileSync,unlinkSync,linkSync,symlinkSync,rmSync,existsSync } from 'node:fs';
import { join } from 'node:path';
const parent=mkdtempSync('/dev/shm/kf-application-custody-proof-'), uid=process.getuid();
const boot='00000000-0000-0000-0000-000000000001', swaps='Filename\\tType\\tSize\\tUsed\\tPriority\\n';
const roots=roles.map(role=>join(parent,'kf-workstation-application-'+role+'-credentials'));
`;
function evaluate(body: string): void {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', FIXTURE + body], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe('');
}

describe('closed workstation application credentials', () => {
  it('frames exactly each named role and exposes only fresh consumer bindings', () => {
    evaluate(`
roles.forEach((role,i)=>{
 const bytes=handoff.encodeApplicationBundle(role,env), lines=bytes.toString().split('\\n');
 assert.equal(lines[0],'kf-workstation-application-'+role+'-credentials-v1');
 assert.equal(lines.length,names[i].length+2);
 assert.deepEqual(handoff.decodeApplicationBundle(role,bytes),fields[i]);
 assert.deepEqual(lines.slice(1,-1).map(line=>Buffer.from(line,'base64').toString()),fields[i]);
 const bindings=handoff.applicationCredentialBindings(role);
 assert.deepEqual(bindings.map(pair=>pair[0]),consumers[i]);
 assert.deepEqual(bindings.map(pair=>pair[1]),names[i]);
 bindings[0][1]='forged'; assert.deepEqual(handoff.applicationCredentialBindings(role).map(pair=>pair[1]),names[i]);
 for(const value of ['never-export-this','never-use-uploader','34'.repeat(32),'56'.repeat(32)]) assert.equal(bytes.includes(Buffer.from(value).toString('base64')),false);
});
`);
  });

  it('refuses every missing own input, sibling payload, old realm and malformed frame', () => {
    evaluate(`
const old=handoff.encodeBundle({KF_ALERT_NTFY_URL:'https://ntfy.sh/public',KF_ALERT_HEARTBEAT_URL:'https://hc-ping.com/public',KF_RETRIEVAL_INDEX_KEY_HEX:'12'.repeat(32)});
roles.forEach((role,i)=>{
 const bytes=handoff.encodeApplicationBundle(role,env);
 for(const source of sources[i]) assert.throws(()=>handoff.encodeApplicationBundle(role,{...env,['KF_'+role.toUpperCase()+'_'+source]:undefined}));
 for(const other of roles.filter(other=>other!==role)) assert.throws(()=>handoff.decodeApplicationBundle(other,bytes));
 for(const decode of [handoff.decodeBundle,handoff.decodeMigrationBundle,handoff.decodeB2Bundle,handoff.decodeBackupBundle,handoff.decodeOffsiteBundle,handoff.decodeDrillBundle,handoff.decodeDrillB2Bundle]) assert.throws(()=>decode(bytes));
 for(const bad of [old,bytes.subarray(0,bytes.length-1),Buffer.concat([bytes,Buffer.from('extra\\n')]),Buffer.alloc(100000)]) assert.throws(()=>handoff.decodeApplicationBundle(role,bad));
 const lines=bytes.toString().split('\\n');
 for(const value of ['',lines[1]+'=',lines[1]+' ', '_bad_']) {const changed=[...lines];changed[1]=value;assert.throws(()=>handoff.decodeApplicationBundle(role,Buffer.from(changed.join('\\n'))));}
});
for(const role of ['backup','migration','b2','drill','constructor','__proto__','arbitrary']) assert.throws(()=>handoff.encodeApplicationBundle(role,env));
`);
  });

  it('bounds fields, refuses redirected routes and requires a distinct Ed25519 signer input', () => {
    evaluate(`
roles.forEach((role,i)=>{
 const prefix='KF_'+role.toUpperCase()+'_';
 for(const bad of [fields[i][0].replace('127.0.0.1','localhost'),fields[i][0].replace(':5432',':5433'),fields[i][0]+'?host=elsewhere',fields[i][0]+'#x',fields[i][0].replace(new RegExp('/kf$'),'/postgres')]) assert.throws(()=>handoff.encodeApplicationBundle(role,{...env,[prefix+'DATABASE_URL']:bad}));
 sources[i].forEach((source,j)=>{
  if(j===0||source==='SIGNING_KEY_BASE64') return;
  const minimum=source.includes('TOKEN')||source.includes('LINK_SECRET')?32:1;
  for(const count of [minimum,8192]) assert.equal(handoff.decodeApplicationBundle(role,handoff.encodeApplicationBundle(role,{...env,[prefix+source]:'a'.repeat(count)}))[j].length,count);
  for(const bad of ['', 'a'.repeat(minimum-1),'a'.repeat(8193),'public\\nvalue','public value']) assert.throws(()=>handoff.encodeApplicationBundle(role,{...env,[prefix+source]:bad}));
 });
});
const wrong=generateKeyPairSync('x25519').privateKey.export({type:'pkcs8',format:'pem'});
assert.throws(()=>handoff.encodeApplicationBundle('checkpoint',{...env,KF_CHECKPOINT_SIGNING_KEY_BASE64:Buffer.from(wrong).toString('base64')}));
assert.throws(()=>handoff.encodeApplicationBundle('checkpoint',{...env,KF_CHECKPOINT_SIGNING_KEY_BASE64:undefined}));
`);
  });

  it('publishes exact private sets and rotates one role without moving sibling or old roots', () => {
    evaluate(
      RUNTIME +
        `
try {
 const prior=handoff.encodeBundle({KF_ALERT_NTFY_URL:'https://ntfy.sh/public',KF_ALERT_HEARTBEAT_URL:'https://hc-ping.com/public',KF_RETRIEVAL_INDEX_KEY_HEX:'12'.repeat(32)});
 handoff.receiveBundle(prior,parent,uid,boot,swaps);
 const oldRoot=join(parent,'kf-workstation-credentials'), old=readlinkSync(join(oldRoot,'current'));
 roles.forEach((role,i)=>{
  assert.equal(handoff.applicationRuntimeStatus(role,parent,uid,boot,swaps),'missing');
  const bytes=handoff.encodeApplicationBundle(role,env);
  assert.equal(handoff.receiveApplicationBundle(role,bytes,parent,uid,boot,swaps),'ready');
  const gen=join(roots[i],readlinkSync(join(roots[i],'current')));
  assert.deepEqual(readdirSync(gen).sort(),[...names[i],'boot-id'].sort());
  for(const dir of [roots[i],gen]) assert.equal(statSync(dir).mode&0o777,0o700);
  names[i].forEach((name,j)=>{assert.equal(statSync(join(gen,name)).mode&0o777,0o400);assert.equal(readFileSync(join(gen,name),'utf8'),fields[i][j]);});
 });
 roles.forEach((role,i)=>{
  const before=roots.map(root=>readlinkSync(join(root,'current')));
  assert.throws(()=>handoff.receiveApplicationBundle(role,prior,parent,uid,boot,swaps));
  assert.deepEqual(roots.map(root=>readlinkSync(join(root,'current'))),before);
  handoff.receiveApplicationBundle(role,handoff.encodeApplicationBundle(role,{...env,['KF_'+role.toUpperCase()+'_DATABASE_URL']:fields[i][0].replace('public-','rotated-')}),parent,uid,boot,swaps);
  roots.map(root=>readlinkSync(join(root,'current'))).forEach((value,j)=>j===i?assert.notEqual(value,before[j]):assert.equal(value,before[j]));
 });
 assert.equal(readlinkSync(join(oldRoot,'current')),old);
} finally {rmSync(parent,{recursive:true,force:true});}
`,
    );
  });

  it('refuses extra, linked, missing, widened and wrong-boot data without treating it as ready', () => {
    evaluate(
      RUNTIME +
        `
try {
 roles.forEach((role,i)=>{
  const bytes=handoff.encodeApplicationBundle(role,env);
  assert.throws(()=>handoff.receiveApplicationBundle(role,bytes,parent,uid+1,boot,swaps));
  assert.throws(()=>handoff.receiveApplicationBundle(role,bytes,parent,uid,boot,swaps+'/swap file 1 0 -2\\n'));
  assert.equal(existsSync(roots[i]),false);
  handoff.receiveApplicationBundle(role,bytes,parent,uid,boot,swaps);
  const gen=join(roots[i],readlinkSync(join(roots[i],'current'))), file=join(gen,'database-url');
  const status=()=>handoff.applicationRuntimeStatus(role,parent,uid,boot,swaps);
  chmodSync(file,0o440);assert.throws(status);chmodSync(file,0o400);
  linkSync(file,join(parent,'link'));assert.throws(status);unlinkSync(join(parent,'link'));
  writeFileSync(join(gen,'unexpected'), 'public', {mode:0o400});assert.throws(status);unlinkSync(join(gen,'unexpected'));
  assert.throws(()=>handoff.applicationRuntimeStatus(role,parent,uid,'00000000-0000-0000-0000-000000000002',swaps));
  unlinkSync(file); assert.equal(status(),'missing'); symlinkSync('/proc/version',file);assert.throws(status);
 });
} finally {rmSync(parent,{recursive:true,force:true});}
`,
    );
  });

  it('refuses unsafe CLI selection without leaking supplied data', () => {
    for (const role of [
      'api',
      'worker',
      'attestor',
      'checkpoint',
      'storage',
      'readiness',
      'backup',
    ]) {
      for (const verb of ['receive', 'status', 'send', 'sync']) {
        const result = spawnSync(
          process.execPath,
          [SCRIPT, `application-${role}-${verb}`, 'forbidden'],
          {
            input: 'never-print-this',
            encoding: 'utf8',
            timeout: 10_000,
          },
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe(
          'workstation credential handoff refused; inspect the host locally\n',
        );
      }
    }
  });

  it('provides a template restricted to application selectors, without executing consumers', () => {
    const service = readFileSync(
      join(ROOT, 'deploy/workstation/kf-host-application-credentials@.service.in'),
      'utf8',
    );
    const timer = readFileSync(
      join(ROOT, 'deploy/workstation/kf-host-application-credentials@.timer.in'),
      'utf8',
    );
    expect(service).toContain('ExecStart=/usr/bin/node @SENDER@ application-%i-sync @CONFIG@');
    expect(service).toContain('MemorySwapMax=0');
    expect(service).toContain('LimitCORE=0');
    expect(service).not.toMatch(
      /^Exec[^=]*=.*(?:application-consumer|migrate-release|backup\.sh)/m,
    );
    expect(timer).toContain('Unit=kf-host-application-credentials@%i.service');
    expect(timer).toContain('OnUnitActiveSec=30s');
  });

  it('keeps the documented encrypted input set equal to the admitted role fields', () => {
    evaluate(`
import { readFileSync } from 'node:fs';
const document=readFileSync(${JSON.stringify(join(ROOT, 'docs/deployment/application-credential-delivery.md'))},'utf8');
const rows=document.split('\\n').filter(line=>roles.includes(line.split('|')[1]?.trim()));
assert.equal(rows.length,roles.length);
rows.forEach((row,i)=>{assert.equal(row.split('|')[1].trim(),roles[i]);assert.deepEqual(row.split('|')[3].match(/[a-z0-9]+(?:-[a-z0-9]+)+/g),names[i]);});
const actual=[...new Set(rows.map(line=>line.split('|')[2]).join(' ').match(/KF_(?:API|WORKER|ATTESTOR|CHECKPOINT|STORAGE|READINESS)_[A-Z0-9_]+/g))].sort();
const expected=roles.flatMap((role,i)=>sources[i].map(source=>'KF_'+role.toUpperCase()+'_'+source)).sort();
assert.deepEqual(actual,expected);
`);
  });
});
