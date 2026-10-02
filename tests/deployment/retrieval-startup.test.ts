import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const configModule = join(import.meta.dirname, '../../scripts/retrieval/config.mjs');
const startupModule = join(import.meta.dirname, '../../scripts/retrieval/startup.mjs');
const config = {
  format: 'kf-retrieval-startup-v1',
  releaseDirectory: '/opt/kf-releases/public-fixture',
  releaseManifestSha256: '12'.repeat(32),
  enginePath: '/opt/public-engine/lamu',
  engineSha256: '34'.repeat(32),
  pythonRuntimeDirectory: '/opt/public-runtime',
  pythonRuntimeManifestSha256: '56'.repeat(32),
  modelDirectory: '/opt/public-model',
  modelIdentity: 'public/model@revision/cpu-recipe-v1',
  embeddingPort: 8021,
  allowedPeerUids: [994, 993],
};

function parse(text: string, body = 'process.stdout.write(JSON.stringify(parseConfig(text)))') {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {parseConfig, engineArguments, recipePins} from ${JSON.stringify(configModule)};
     const text = process.argv[1]; ${body}`,
      text,
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
}

it('parses a flat deterministic non-secret startup contract', () => {
  const result = parse(JSON.stringify(config));
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(config);
});

it('keeps the documented contract fields equal to the accepted fields in both directions', () => {
  const document = readFileSync(
    join(import.meta.dirname, '../../docs/deployment/retrieval-startup.md'),
    'utf8',
  );
  const fields = Array.from(
    document.matchAll(/^\|\s*`([A-Za-z][A-Za-z0-9]*)`\s*\|/gm),
    (match) => match[1],
  );
  expect(fields.sort()).toEqual(Object.keys(config).sort());
});

it.each([
  ['extra key', { ...config, keyFile: '/tmp/not-a-production-key' }],
  ['uppercase digest', { ...config, engineSha256: 'AB'.repeat(32) }],
  ['relative path', { ...config, enginePath: 'lamu' }],
  ['root path', { ...config, modelDirectory: '/' }],
  ['path traversal', { ...config, releaseDirectory: '/opt/public/../release' }],
  ['root peer', { ...config, allowedPeerUids: [0] }],
  ['duplicate peer', { ...config, allowedPeerUids: [993, 993] }],
  ['fractional peer', { ...config, allowedPeerUids: [1.5] }],
  ['overflow port', { ...config, embeddingPort: 65536 }],
  ['arbitrary arguments', { ...config, modelIdentity: 'public/model --key-file elsewhere' }],
  ['wrong version', { ...config, format: 'different' }],
])('refuses %s rather than guessing a startup configuration', (_name, value) => {
  expect(parse(JSON.stringify(value)).status).not.toBe(0);
});

it('refuses literal and escape-equivalent duplicate JSON keys', () => {
  for (const name of ['engineSha256', 'engineSha\\u0032\\u0035\\u0036']) {
    const text = JSON.stringify(config).replace(/}$/, `,"${name}":"${config.engineSha256}"}`);
    const result = parse(text);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('startup_config_duplicate_key');
  }
});

it('selects the KF broker exclusively and keeps peer grants explicit', () => {
  const result = parse(
    JSON.stringify(config),
    'process.stdout.write(JSON.stringify(engineArguments(parseConfig(text))))',
  );
  expect(result.status, result.stderr).toBe(0);
  const args: string[] = JSON.parse(result.stdout);
  expect(args).toContain('--key-release-socket');
  expect(args).not.toContain('--key-file');
  expect(args).toContain(config.releaseManifestSha256);
  expect(args.slice(-4)).toEqual(['--allow-uid', '994', '--allow-uid', '993']);
  expect(args).toContain('/var/lib/lamu-retrieval/index');
});

it('requires one digest for each startup recipe file, not merely a pinned manifest file', () => {
  const paths = [
    'scripts/retrieval/config.mjs',
    'scripts/retrieval/startup.mjs',
    'scripts/embedding/runtime-inventory.mjs',
    'scripts/embedding/verify-runtime.mjs',
    'scripts/embedding/launch-runtime.mjs',
    'scripts/embedding/model.py',
    'scripts/embedding/transport.py',
    'scripts/embedding/serve.py',
  ];
  const manifest = paths.map((path) => `${'ab'.repeat(32)}  ${path}`).join('\n') + '\n';
  const body = 'process.stdout.write(JSON.stringify(recipePins(text)))';
  const result = parse(manifest, body);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(
    paths.map((path) => ({ path, sha256: 'ab'.repeat(32) })),
  );
  for (const wrong of [
    manifest.replace(/^.*\n/, ''),
    manifest + manifest.split('\n')[0] + '\n',
    manifest.replace(/^ab/, 'AB'),
    manifest.replace('  scripts/', ' scripts/'),
  ]) {
    expect(parse(wrong, body).status).not.toBe(0);
  }
});

it.each([0, -1, 60_001, 1.5])(
  'refuses an invalid readiness deadline before connecting: %s',
  (deadline) => {
    const code = `import {providerReady} from ${JSON.stringify(startupModule)};
    try { await providerReady({embeddingPort:1,modelIdentity:'public-model'},${deadline}); }
    catch(error) { process.stdout.write(error.message); }`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      timeout: 1000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('startup_readiness_deadline_invalid');
  },
);

it.each(['correct', 'wrong', 'oversized', 'redirect'])(
  'bounds actual local health readiness: %s',
  (mode) => {
    const code = `import {createServer} from 'node:http';
    import {providerReady} from ${JSON.stringify(startupModule)};
    const mode=process.argv[1];
    const server=createServer((_q,r)=>{
      if(mode==='redirect'){r.writeHead(302,{Location:'http://127.0.0.1:1'});r.end();return;}
      r.writeHead(200,{'Content-Type':'application/json'});
      r.end(mode==='oversized'?'x'.repeat(5000):JSON.stringify({status:'ok',model:mode==='correct'?'public-model':'wrong-model'}));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try{await providerReady({embeddingPort:server.address().port,modelIdentity:'public-model'},250);
      process.stdout.write('ready');}catch{process.stdout.write('refused');}
    finally{await new Promise(resolve=>server.close(resolve));}`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, mode], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(mode === 'correct' ? 'ready' : 'refused');
  },
);

it('declares distinct bounded identities and the existing recovery-holder name', () => {
  const root = join(import.meta.dirname, '../../deploy/systemd');
  const provider = readFileSync(join(root, 'kf-embedding.service'), 'utf8');
  const engine = readFileSync(join(root, 'lamu-retrieval.service'), 'utf8');
  expect(provider).toContain('User=kf-embedding');
  expect(engine).toContain('User=kf-retrieval');
  expect(engine).toContain('Wants=kf-embedding.service');
  expect(engine).toContain('Requires=kf-retrieval-key.socket');
  expect(engine).toContain('JoinsNamespaceOf=kf-embedding.service');
  expect(engine).toContain(
    'ConditionPathExists=/run/kf-workstation-credentials/current/retrieval-index-key',
  );
  const activation = readFileSync(join(root, 'kf-retrieval-credentials.path'), 'utf8');
  expect(activation).toContain('PathChanged=/run/kf-workstation-credentials');
  expect(activation).not.toContain('PathExists=');
  expect(activation).toContain('Unit=lamu-retrieval.service');
  for (const text of [provider, engine]) {
    for (const directive of [
      'MemorySwapMax=0',
      'LimitCORE=0',
      'KillMode=control-group',
      'ProtectSystem=strict',
      'PrivateNetwork=true',
      'IPAddressDeny=any',
      'IPAddressAllow=localhost',
      'OnFailure=kf-alert@%n.service',
      'StartLimitBurst=5',
      'SystemCallFilter=@system-service',
      'UnsetEnvironment=NODE_OPTIONS NODE_PATH PYTHONPATH PYTHONHOME LAMU_API_TOKEN',
    ])
      expect(text).toContain(directive);
    expect(text).not.toContain('EnvironmentFile=');
    expect(text).not.toContain('--key-file');
  }
});
