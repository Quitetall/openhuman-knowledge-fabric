import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
const ROOT = join(import.meta.dirname, '../..');
const MODULE = pathToFileURL(
  join(ROOT, 'scripts/deploy/internal/native-consumer-verdict.mjs'),
).href;
const OBSERVER = pathToFileURL(
  join(ROOT, 'scripts/deploy/internal/native-consumer-observation.mjs'),
).href;
function evaluate(body: string) {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
import assert from 'node:assert/strict';
import { nativeConsumerVerdict } from ${JSON.stringify(MODULE)};
const good={version:1,role:'api',pid:123,invocation:'12'.repeat(16),state:'active',substate:'running',uid:1101,gid:1101,expectedUid:1101,expectedGid:1101,aliases:['kf-api'],localIdentity:true,stable:true,noNewPrivileges:1,capEffective:'0',capPermitted:'0',capAmbient:'0',swapInventoryEmpty:true,memorySwapMax:'0',coreSoft:'0',coreHard:'0',custody:'satisfied'};
${body}
`,
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe('');
}
describe('current native main-process inspection verdict', () => {
  it('accepts complete current metadata but states the narrow scope', () => {
    evaluate(
      `const r=nativeConsumerVerdict('api',good);assert.equal(r.status,'satisfied');assert.match(r.detail,/not.*use.*restart.*reboot/);`,
    );
  });
  it('accepts a running oneshot, never a completed inactive job by assumption', () => {
    evaluate(
      `assert.equal(nativeConsumerVerdict('api',{...good,state:'activating',substate:'start'}).status,'satisfied');for(const patch of [{pid:0},{state:'inactive',substate:'dead'},{invocation:''}])assert.notEqual(nativeConsumerVerdict('api',{...good,...patch}).status,'satisfied');`,
    );
  });
  it.each([
    ['wrong UID', { uid: 1102 }],
    ['root UID', { uid: 0, expectedUid: 0 }],
    ['wrong GID', { gid: 1102 }],
    ['UID alias', { aliases: ['kf-api', 'outsider'] }],
    ['swappable', { memorySwapMax: 'max' }],
    ['host swap', { swapInventoryEmpty: false }],
    ['soft core', { coreSoft: '1024' }],
    ['hard core', { coreHard: 'unlimited' }],
    ['effective capability', { capEffective: '1' }],
    ['permitted capability', { capPermitted: '1' }],
    ['ambient capability', { capAmbient: '1' }],
    ['new privileges', { noNewPrivileges: 0 }],
    ['custody refusal', { custody: 'unsatisfied' }],
  ])('refuses %s', (_label, patch) => {
    evaluate(
      `assert.equal(nativeConsumerVerdict('api',{...good,...${JSON.stringify(patch)}}).status,'unsatisfied');`,
    );
  });
  it.each([
    { role: 'worker' },
    { version: 2 },
    { pid: -1 },
    { invocation: 'bogus' },
    { localIdentity: false },
    { stable: false },
    { custody: 'unverifiable' },
    { capEffective: 'not-hex' },
    { noNewPrivileges: null },
  ])('cannot pass incomplete or unsupported observations %j', (patch) => {
    evaluate(
      `assert.equal(nativeConsumerVerdict('api',{...good,...${JSON.stringify(patch)}}).status,'unverifiable');`,
    );
  });
  it('does not disclose arbitrary observation fields or error text', () => {
    evaluate(
      `const r=nativeConsumerVerdict('api',{...good,diagnostic:'PUBLIC_DO_NOT_ECHO'});assert.equal(r.status,'unverifiable');assert(!JSON.stringify(r).includes('PUBLIC_DO_NOT_ECHO'));assert(!JSON.stringify(nativeConsumerVerdict('PUBLIC_DO_NOT_ECHO',good)).includes('PUBLIC_DO_NOT_ECHO'));`,
    );
  });
  it('does not accept a coerced invocation identity', () => {
    evaluate(
      `assert.equal(nativeConsumerVerdict('api',{...good,invocation:[good.invocation]}).status,'unverifiable');`,
    );
  });
  it('ordinary CLI callers cannot select a PID, namespace, helper or diagnostic output', () => {
    for (const args of [['--pid', '1'], ['--helper', 'PUBLIC_DO_NOT_ECHO'], ['unknown'], ['api']]) {
      const result = spawnSync(
        process.execPath,
        [join(ROOT, 'scripts/deploy/inspect-native-consumers.mjs'), ...args],
        { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10000 },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('PUBLIC_DO_NOT_ECHO');
      expect(result.stderr).not.toContain('PUBLIC_DO_NOT_ECHO');
    }
  });
});

describe('native observer uses strict metadata parsers before privileged inspection', () => {
  function parse(body: string) {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import {nativeUnitMetadata,nativeLocalIdentity,nativeProcessMetadata,observeNativeConsumer} from ${JSON.stringify(OBSERVER)};
      const unit='Id=public.service\\nActiveState=active\\nSubState=running\\nMainPID=123\\nInvocationID='+ '12'.repeat(16)+'\\nUser=kf-api\\nGroup=\\nDynamicUser=no\\n';
      const local={nss:'passwd: files\\ngroup: files\\n',passwd:'root:x:0:0::/:/bin/sh\\nkf-api:x:1101:1101::/:/bin/false\\n',groups:'root:x:0:\\nkf-api:x:1101:\\nkf-attest:x:1102:\\n'};
      const facts={status:'Uid:\\t1101\\t1101\\t1101\\t1101\\nGid:\\t1101\\t1101\\t1101\\t1101\\nNoNewPrivs:\\t1\\nCapEff:\\t0000000000000000\\nCapPrm:\\t0000000000000000\\nCapAmb:\\t0000000000000000\\n',cgroup:'0::/system.slice/public.service\\n',limits:'Max core file size         0                    0                    bytes\\n',stat:'123 (public ) name) S '+Array(18).fill('0').join(' ')+' 777 '+Array(30).fill('0').join(' ')+'\\n'};
      ${body}
    `,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
  }
  it('parses current unit, numeric local identity, process limits and start identity', () => {
    parse(
      `assert.equal(nativeUnitMetadata(unit).MainPID,'123');assert.deepEqual(nativeLocalIdentity('api','',local),{expectedUid:1101,expectedGid:1101,aliases:['kf-api']});assert.equal(nativeLocalIdentity('attestor','kf-attest',{...local,passwd:local.passwd+'kf-attestor:x:1103:1103::/:/bin/false\\n'}).expectedGid,1102);assert.throws(()=>nativeLocalIdentity('api','kf-attest',local));const f=nativeProcessMetadata(123,facts);assert.equal(f.start,'777');assert.equal(f.uid,1101);assert.equal(f.group,'/system.slice/public.service');`,
    );
  });
  it.each(['duplicate property', 'missing property', 'unknown property'])('refuses %s', (plant) => {
    const change =
      plant === 'duplicate property'
        ? `unit+'User=kf-api\\n'`
        : plant === 'missing property'
          ? `unit.replace('Group=\\n','')`
          : `unit+'PUBLIC_DO_NOT_ECHO=value\\n'`;
    parse(
      `assert.throws(()=>nativeUnitMetadata(${change}),/^Error: native observation unavailable$/);`,
    );
  });
  it.each([
    `nss:'passwd: files systemd\\ngroup: files\\n'`,
    `nss:'passwd: files\\npasswd: files\\ngroup: files\\n'`,
    `passwd:local.passwd+'kf-api:x:1101:1101::/:/bin/false\\n'`,
    `passwd:local.passwd.replace('1101:1101','01101:1101')`,
    `groups:'kf-api:x:invalid:\\n'`,
  ])('cannot assert a complete local identity for malformed or external NSS %s', (change) => {
    parse(`assert.throws(()=>nativeLocalIdentity('api','kf-api',{...local,${change}}));`);
  });
  it('retains a UID alias for the verdict to refuse instead of hiding it', () => {
    parse(
      `assert.deepEqual(nativeLocalIdentity('api','',{...local,passwd:local.passwd+'outsider:x:1101:1101::/:/bin/false\\n'}).aliases,['kf-api','outsider']);`,
    );
  });
  it.each([
    `status:facts.status+'Uid: 1101 1101 1101 1101\\n'`,
    `status:facts.status.replace('1101\\t1101\\t1101\\t1101','1101\\t1102\\t1101\\t1101')`,
    `status:facts.status.replace('NoNewPrivs:\\t1\\n','')`,
    `cgroup:'0::/system.slice/../public.service\\n'`,
    `cgroup:'1:memory:/public.service\\n'`,
    `cgroup:'0::/a\\n0::/b\\n'`,
    `limits:'unavailable'`,
    `stat:facts.stat.replace('777','invalid')`,
    `stat:facts.stat.replace('123 (','124 (')`,
    `stat:facts.stat.replaceAll(')','')`,
  ])('refuses incomplete/racy process metadata %s', (change) => {
    parse(`assert.throws(()=>nativeProcessMetadata(123,{...facts,${change}}));`);
  });
  it('does not enable arbitrary ordinary callers through its library-only unit selector', () => {
    parse(
      `assert.equal(await observeNativeConsumer('api','/not-a-protected-release','public-fixture.service'),null);`,
    );
  });
});
