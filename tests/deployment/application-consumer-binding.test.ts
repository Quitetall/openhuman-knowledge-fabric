// Pure routing and ordinary-process refusals are not native startup or commissioning.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  publicConfigurationCatalog,
  publicConfigurationVerdict,
} from '../../packages/operations/src/internal/commissioning/public-configuration.js';

const ROOT = join(import.meta.dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/deploy/application-consumer.mjs');
const MODULE = join(ROOT, 'scripts/deploy/internal/application-consumer-plan.mjs');
const roles = ['api', 'worker', 'attestor', 'checkpoint', 'storage', 'readiness'];
const FIXTURE = `
import assert from 'node:assert/strict';
import { applicationConsumerPlan } from ${JSON.stringify(pathToFileURL(MODULE).href)};
const roles=${JSON.stringify(roles)}, root='/opt/kf-public-fixture';
const env={KF_SECRET_CUSTODY:'systemd',CREDENTIALS_DIRECTORY:'/run/credentials/kf-public.service',
OIDC_ISSUER:'https://identity.example/realm',OIDC_AUDIENCE:'kf',OIDC_JWKS_URI:'https://identity.example/keys',
S3_ENDPOINT:'http://127.0.0.1:9000',S3_REGION:'us-east-1',S3_ACCESS_KEY_ID:'public-working',S3_BUCKET_ARTIFACTS:'public-working',
S3_DURABLE_ENDPOINT:'https://durable.example',S3_DURABLE_REGION:'us-east-1',S3_DURABLE_ACCESS_KEY_ID:'public-durable',S3_DURABLE_BUCKET:'public-durable',
CHECKPOINT_SIGNING_KEY_ID:'public-key',CHECKPOINT_PUBLIC_KEY_DIR:'/etc/kf/public-keys',CHECKPOINT_S3_ENDPOINT:'https://anchor.example',CHECKPOINT_S3_REGION:'us-east-1',CHECKPOINT_S3_ACCESS_KEY_ID:'public-anchor',CHECKPOINT_S3_BUCKET:'public-anchor',
KF_STORAGE_ACTOR:'00000000-0000-0000-0000-000000000001',KF_STORAGE_ROLE:'00000000-0000-0000-0000-000000000002',KF_STORAGE_ORGANIZATION:'00000000-0000-0000-0000-000000000003',KF_STORAGE_CLASSIFICATION:'restricted',
DATABASE_URL:'never-forward-inline',DATABASE_URL_FILE:'/legacy/db',CHECKPOINT_SIGNING_KEY_PATH:'/legacy/key',NODE_OPTIONS:'never-forward-loader',LD_PRELOAD:'never-forward-loader',TMPDIR:'/legacy/tmp',UNRELATED_SECRET:'never-forward-secret',KF_TIMER_UNIT_DIR:'/legacy/timers',KF_NOW_EPOCH:'1'};
const runtime=role=>role==='attestor'?'/run/kf-attestor:/run/kf-attestor-work':'/run/kf-'+role+'-work';
`;
function evaluate(body: string): void {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', FIXTURE + body], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe('');
}

describe('closed native application consumer binding', () => {
  it('shares the closed public field catalog and value rules with commissioning', async () => {
    const catalog = await publicConfigurationCatalog(join(ROOT, 'deploy/systemd'));
    const values = [
      'https://public.example',
      'http://127.0.0.1:9000',
      'https://user:password@public.example',
      'https://public.example?token=public',
      'https://public.example#public',
      'http://public.example',
      '/public/../wrong',
      '/public/compiler',
      'public-value',
    ];
    for (const [role, fields] of Object.entries(catalog)) {
      const baseline = Object.fromEntries(
        fields.required.map((name) => [
          name,
          name.endsWith('_ENDPOINT') || name === 'OIDC_ISSUER' || name === 'OIDC_JWKS_URI'
            ? 'https://public.example'
            : name.endsWith('_KEY_DIR')
              ? '/public/keys'
              : 'public-value',
        ]),
      );
      const cases = fields.public.map((name) => {
        const outcomes = values.map((value) => {
          const text = Object.entries({ ...baseline, [name]: value })
            .map(([key, item]) => `${key}=${item}`)
            .join('\n');
          return (
            publicConfigurationVerdict(
              { text, uid: 0, mode: 0o644, size: Buffer.byteLength(text), nlink: 1, regular: true },
              role as keyof typeof catalog,
              catalog,
            ).status === 'satisfied'
          );
        });
        return { name, outcomes };
      });
      evaluate(`
const baseline=${JSON.stringify(baseline)}, role=${JSON.stringify(role)}, cases=${JSON.stringify(cases)}, values=${JSON.stringify(values)};
cases.forEach(({name,outcomes})=>values.forEach((value,i)=>{let accepted=true;try{applicationConsumerPlan(role,root,{...env,...baseline,[name]:value,RUNTIME_DIRECTORY:runtime(role)})}catch{accepted=false}assert.equal(accepted,outcomes[i]);}));
`);
    }
    evaluate(`
import fields from ${JSON.stringify(pathToFileURL(join(ROOT, 'deploy/systemd/application-public-fields.json')).href)} with {type:'json'};
roles.forEach(role=>{const spec=fields[role], base=Object.fromEntries(spec.public.map(name=>[name,name.endsWith('_ENDPOINT')||name.endsWith('_URL')||name.endsWith('_ORIGIN')||name==='OIDC_ISSUER'||name==='OIDC_JWKS_URI'?'https://public.example':name.endsWith('_KEY_DIR')||name.endsWith('_PATH')||name.endsWith('_SOCKET')?'/public/path':'public-value']));
 const own={...base,KF_SECRET_CUSTODY:'systemd',CREDENTIALS_DIRECTORY:env.CREDENTIALS_DIRECTORY,RUNTIME_DIRECTORY:runtime(role)};
 let plan;assert.doesNotThrow(()=>{plan=applicationConsumerPlan(role,root,own)},role);spec.public.forEach(name=>assert.equal(plan.env[name],base[name]));
 spec.required.forEach(name=>assert.throws(()=>applicationConsumerPlan(role,root,{...own,[name]:undefined})));
});
`);
  });
  it('selects only fixed programs, role paths and a cleared child environment', () => {
    evaluate(`
const entries=['apps/api/dist/server.js','apps/worker/dist/main.js','apps/attestor/dist/main.js','apps/checkpoint/dist/main.js','apps/kf-storage/dist/main.js','packages/operations/dist/cli.js'];
const flags=[[],[],[],['--run'],['--replicate','--verify','--older-than-days','30','--collect-orphans','--grace-hours','168'],[]];
roles.forEach((role,i)=>{
 const plan=applicationConsumerPlan(role,root,{...env,RUNTIME_DIRECTORY:runtime(role)});
 assert.equal(plan.cwd,root);assert.equal(plan.env.KF_SECRET_CUSTODY,'systemd');assert.equal(plan.env.NODE_ENV,'production');assert.equal(plan.env.TMPDIR,'/run/kf-'+role+'-work');
 const command=plan.commands.at(-1);assert.equal(command.executable,'/usr/bin/node');assert.deepEqual(command.args,[root+'/'+entries[i],...flags[i]]);
 for(const value of Object.values(plan.env)) assert(!value.includes('never-forward')&&!value.startsWith('/legacy/'));
 for(const name of ['NODE_OPTIONS','LD_PRELOAD','UNRELATED_SECRET','DATABASE_URL','KF_TIMER_UNIT_DIR','KF_NOW_EPOCH']) assert.equal(plan.env[name],undefined);
 assert.equal(plan.env[role==='worker'?'WORKER_DATABASE_URL_FILE':'DATABASE_URL_FILE'],env.CREDENTIALS_DIRECTORY+'/database-url');
 if(role==='api'){assert.equal(plan.env.KF_DEPLOYMENT_PROFILE,'dogfood');assert.equal(plan.env.HOST,'127.0.0.1');assert.equal(plan.env.KF_PROJECTIONS_ARTIFACT,root+'/generated/projections/knowledge-fabric.projections.json');assert.equal(plan.env.KF_READINESS_TOKEN_FILE,env.CREDENTIALS_DIRECTORY+'/readiness-token');}
 if(role==='checkpoint')assert.equal(plan.env.CHECKPOINT_SIGNING_KEY_PATH,env.CREDENTIALS_DIRECTORY+'/checkpoint-signing-key');
 assert.equal(plan.commands.length,role==='readiness'?2:1);
 if(role==='readiness')assert.deepEqual(plan.commands[0],{executable:'/usr/bin/bash',args:[root+'/scripts/timer-liveness.sh']});
});
`);
  });

  it('runs the determinism re-run as the worker, with its own program and work directory (SAS §100.35)', () => {
    evaluate(`
import { applicationConsumerAccount } from ${JSON.stringify(pathToFileURL(MODULE).href)};
assert.equal(applicationConsumerAccount('compiler-determinism'),'worker');
roles.forEach(role=>assert.equal(applicationConsumerAccount(role),role));
assert.throws(()=>applicationConsumerAccount('unknown'));
const extra={LIMINAL_COMPILER_PATH:root+'/vendor/liminal/liminal-document-compiler',WORKER_CONCURRENCY:'8'};
const plan=applicationConsumerPlan('compiler-determinism',root,{...env,...extra,RUNTIME_DIRECTORY:'/run/kf-compiler-determinism-work'});
const worker=applicationConsumerPlan('worker',root,{...env,...extra,RUNTIME_DIRECTORY:runtime('worker')});
assert.deepEqual(plan.commands,[{executable:'/usr/bin/node',args:[root+'/apps/worker/dist/determinism-cli.js','--limit','5']}]);
assert.equal(plan.env.TMPDIR,'/run/kf-compiler-determinism-work');
const{TMPDIR:_a,...own}=plan.env,{TMPDIR:_b,...theirs}=worker.env;assert.deepEqual(own,theirs);
assert.throws(()=>applicationConsumerPlan('compiler-determinism',root,{...env,RUNTIME_DIRECTORY:runtime('worker')}));
`);
    const drop = readFileSync(
      join(ROOT, 'deploy/systemd/application-compiler-determinism-workstation-credentials.conf'),
      'utf8',
    );
    const worker = readFileSync(
      join(ROOT, 'deploy/systemd/application-worker-workstation-credentials.conf'),
      'utf8',
    );
    const lines = (text: string, key: string): string[] =>
      text.split('\n').filter((line) => line.startsWith(`${key}=`));
    // The same credentials and public file as the worker, so commissioning sees an even share.
    for (const key of [
      'LoadCredential',
      'LoadCredentialEncrypted',
      'EnvironmentFile',
      'UnsetEnvironment',
    ]) {
      expect(lines(drop, key), key).toEqual(lines(worker, key));
    }
    expect(drop).toContain(
      'ExecStart=/usr/bin/node /opt/kf/scripts/deploy/application-consumer.mjs compiler-determinism',
    );
    expect(drop).toContain('RuntimeDirectory=kf-compiler-determinism-work');
    expect(drop).toContain('verify-liminal-runtime.sh /opt/kf');
  });

  it('refuses unknown roles, aliased roots, nonnative custody and wrong runtime sets', () => {
    evaluate(`
for(const role of ['unknown','backup','constructor','__proto__'])assert.throws(()=>applicationConsumerPlan(role,root,env));
roles.forEach(role=>{
 const own={...env,RUNTIME_DIRECTORY:runtime(role)};
 for(const invalid of ['/','relative','/opt/../opt/fixture','/opt/fixture/'])assert.throws(()=>applicationConsumerPlan(role,invalid,own));
 for(const changed of [{KF_SECRET_CUSTODY:undefined},{KF_SECRET_CUSTODY:'ordinary'},{CREDENTIALS_DIRECTORY:'/run/../run/credentials/a'},{CREDENTIALS_DIRECTORY:undefined},{RUNTIME_DIRECTORY:'/run/other'},{RUNTIME_DIRECTORY:runtime(role)+':/run/extra'}])assert.throws(()=>applicationConsumerPlan(role,root,{...own,...changed}));
});
`);
  });

  it('admits existing optional public features but never secret or executable overrides', () => {
    evaluate(`
const extra={KF_RETRIEVAL_SOCKET:'/run/kf-retrieval/retrieval.sock',KF_WEB_ORIGIN:'https://web.example',KF_API_ORIGIN:'https://api.example',KF_EFFECTIVE_AT_BACKDATE_DAYS:'90',KF_EFFECTIVE_AT_BACKDATABLE_ACTIONS:'correct_document',KF_SECURE_OBJECT_ERASURE_SIGNER_URL:'https://signer.example/erase',KF_SECURE_OBJECT_ERASURE_SIGNER_TIMEOUT_MS:'5000',KF_PANDOC_MAX_HEAP_MIB:'256',KF_PANDOC_PATH:'/usr/bin/pandoc',WORKER_CONCURRENCY:'8',LIMINAL_COMPILER_PATH:root+'/vendor/liminal/liminal-document-compiler',LIMINAL_CARGO_LOCK_PATH:root+'/vendor/liminal/Cargo.lock',LIMINAL_BWRAP_PATH:'/usr/bin/bwrap',LIMINAL_RUNTIME_FILE_PATHS:'/usr/lib/public.so',LIMINAL_EXECUTABLE_SHA256:'12'.repeat(32),LIMINAL_CARGO_LOCK_SHA256:'34'.repeat(32),LIMINAL_RUNTIME_CLOSURE_SHA256:'56'.repeat(32)};
const api=applicationConsumerPlan('api',root,{...env,...extra,RUNTIME_DIRECTORY:runtime('api')});
for(const name of Object.keys(extra).filter(name=>!name.startsWith('LIMINAL_')&&name!=='WORKER_CONCURRENCY'))assert.equal(api.env[name],extra[name]);
const worker=applicationConsumerPlan('worker',root,{...env,...extra,RUNTIME_DIRECTORY:runtime('worker')});
for(const name of Object.keys(extra).filter(name=>name.startsWith('LIMINAL_')||name==='WORKER_CONCURRENCY'||name==='KF_RETRIEVAL_SOCKET'))assert.equal(worker.env[name],extra[name]);
for(const value of ['https://user:password@identity.example','https://identity.example/?token=secret','https://identity.example/#secret','http://identity.example','public\\nsecret'])assert.throws(()=>applicationConsumerPlan('api',root,{...env,OIDC_ISSUER:value,RUNTIME_DIRECTORY:runtime('api')}));
for(const role of ['api','attestor'])for(const name of ['OIDC_ISSUER','OIDC_AUDIENCE','OIDC_JWKS_URI'])assert.throws(()=>applicationConsumerPlan(role,root,{...env,[name]:undefined,RUNTIME_DIRECTORY:runtime(role)}));
`);
  });

  it('refuses ordinary callers and extra arguments without exposing supplied values', () => {
    for (const args of [
      [],
      ['unknown'],
      ['api', 'never-print-this'],
      ...roles.map((role) => [role]),
      ['compiler-determinism'],
      ['compiler-determinism', '--limit', '100'],
    ]) {
      const result = spawnSync(process.execPath, [SCRIPT, ...args], {
        env: { PATH: '/usr/bin:/bin', DATABASE_URL: 'never-print-this' },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain('never-print-this');
      expect(result.stderr).toMatch(
        /^(?:usage: application-consumer\.mjs api\|worker\|attestor\|checkpoint\|storage\|readiness\|compiler-determinism|native application binding refused)\n$/,
      );
    }
  });

  it('resets legacy inputs without dropping sandbox, socket or readiness protections', () => {
    for (const role of roles) {
      const drop = readFileSync(
        join(ROOT, `deploy/systemd/application-${role}-workstation-credentials.conf`),
        'utf8',
      );
      expect(drop).toMatch(/^Environment=$/m);
      expect(drop).toMatch(/^EnvironmentFile=$/m);
      expect(drop).toContain(`EnvironmentFile=/etc/kf/application-public/${role}.env`);
      expect(drop).toMatch(/^ExecStart=$/m);
      expect(drop).toMatch(/^ExecStartPre=$/m);
      expect(drop).toMatch(/^LoadCredential=$/m);
      expect(drop).toMatch(/^LoadCredentialEncrypted=$/m);
      expect(drop).toContain(
        `ExecStart=/usr/bin/node /opt/kf/scripts/deploy/application-consumer.mjs ${role}`,
      );
      expect(drop).toContain('ProcSubset=all');
      expect(drop).toContain('MemorySwapMax=0');
      expect(drop).toContain('LimitCORE=0');
      expect(drop).toContain('UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH');
      expect(drop).not.toMatch(/^LoadCredential=[^\n]*\/etc\/kf/m);
      if (role === 'api') {
        expect(drop).toContain('knowledge-fabric.projections.json');
        expect(drop).toContain('test -S /run/kf-attestor/attestor.sock');
      }
      if (role === 'worker') {
        expect(drop).toContain('test -x /usr/bin/bwrap');
        expect(drop).toContain('test -x /usr/bin/prlimit');
        expect(drop).toContain('verify-liminal-runtime.sh /opt/kf');
      }
      if (role === 'attestor') {
        expect(drop).toContain('RuntimeDirectory=kf-attestor kf-attestor-work');
        expect(drop).toContain('RuntimeDirectoryMode=0710');
        expect(drop).not.toContain('ExecStartPre=/usr/bin/chmod');
      }
    }
  });
});
