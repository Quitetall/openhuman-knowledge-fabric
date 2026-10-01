import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const PROTOCOL = 'kf-retrieval-key-release-v1';
const uid = process.getuid!();
let parent: string;
let credentials: string;
let release: string;
let policy: string;
let manifest: string;
const KEY = '12'.repeat(32); // Public fault fixture, not a provisioned encryption key.

beforeAll(() => {
  parent = mkdtempSync(join(tmpdir(), 'kf-key-release-'));
  credentials = mkdtempSync('/dev/shm/kf-key-release-');
  release = join(parent, 'release');
  policy = join(parent, 'policy.json');
  for (const path of [
    'tools',
    'scripts/deploy',
    'scripts/lib',
    'database/migrations',
    'generated/sql-registry',
  ])
    mkdirSync(join(release, path), { recursive: true, mode: 0o755 });
  for (const path of [
    'scripts/deploy/migrate-release.sh',
    'scripts/lib/secret.sh',
    'scripts/deploy/retrieval-key-release.mjs',
  ])
    copyFileSync(join(ROOT, path), join(release, path));
  const compiled = spawnSync(
    'cc',
    [
      '-std=c11',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      join(ROOT, 'scripts/deploy/peer-credentials.c'),
      '-o',
      join(release, 'tools/kf-peer-credentials'),
    ],
    { encoding: 'utf8' },
  );
  expect(compiled.status, compiled.stderr).toBe(0);
  const resolved = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'import { resolveBinary } from "./node_modules/dbmate/dist/resolveBinary.js"; process.stdout.write(resolveBinary())',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  expect(resolved.status, resolved.stderr).toBe(0);
  copyFileSync(resolved.stdout, join(release, 'tools/dbmate'));
  chmodSync(join(release, 'tools/dbmate'), 0o755);
  const version = spawnSync(join(release, 'tools/dbmate'), ['--version'], { encoding: 'utf8' });
  expect(version.status, version.stderr).toBe(0);
  writeFileSync(join(release, 'BUILD-METADATA'), `dbmate=${version.stdout.trim()}\n`);
  writeFileSync(
    join(release, 'database/migrations/20260101000000_probe.sql'),
    '-- migrate:up\nselect 1;\n-- migrate:down\nselect 1;\n',
  );
  writeFileSync(join(release, 'generated/sql-registry/001-ontology-seed.sql'), 'select 1;\n');
  writeFileSync(join(release, 'data.txt'), 'sealed fixture\n');
  const files: string[] = [];
  const directories: string[] = [];
  const walk = (prefix: string) => {
    for (const entry of readdirSync(join(release, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        directories.push(path);
        walk(path);
      } else files.push(path);
    }
  };
  walk('');
  writeFileSync(join(release, 'DIRECTORIES'), `${directories.sort().join('\n')}\n`);
  writeFileSync(join(release, 'SYMLINKS'), '');
  files.push('DIRECTORIES', 'SYMLINKS');
  const sums = files
    .sort()
    .map(
      (path) =>
        `${createHash('sha256')
          .update(readFileSync(join(release, path)))
          .digest('hex')}  ${path}\n`,
    )
    .join('');
  writeFileSync(join(release, 'SHA256SUMS'), sums);
  manifest = createHash('sha256').update(sums).digest('hex');
  writeFileSync(join(credentials, 'index-key'), KEY, { mode: 0o400 });
  configure(uid);
});

afterAll(() => {
  if (parent) rmSync(parent, { recursive: true, force: true });
  if (credentials) rmSync(credentials, { recursive: true, force: true });
});

function configure(allowedUid: number) {
  writeFileSync(
    policy,
    JSON.stringify({ allowedUid, releaseDirectory: release, releaseManifestSha256: manifest }),
    { mode: 0o644 },
  );
}

/** Pass an actual connected AF_UNIX descriptor just as socket activation does. */
async function exchange(
  request: Buffer | string,
  swapTable = 'Filename Type Size Used Priority\n',
): Promise<{ bytes: Buffer; status: number | null; stderr: string }> {
  const path = join(parent, 'broker.sock');
  const children: ReturnType<typeof spawn>[] = [];
  const server = createServer({ allowHalfOpen: true });
  const result = new Promise<{ status: number | null; stderr: string }>((done, reject) => {
    server.once('connection', (connection) => {
      connection.pause();
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { releaseConnection } from ${JSON.stringify(pathToFileURL(join(release, 'scripts/deploy/retrieval-key-release.mjs')).href)};
         try { await releaseConnection({ policyPath:${JSON.stringify(policy)}, credentialsDirectory:${JSON.stringify(credentials)}, ownerUid:${uid}, swapTable:${JSON.stringify(swapTable)} }); }
         catch { console.warn('retrieval key release refused'); process.exitCode=1; }`,
        ],
        { stdio: [connection, connection, 'pipe'], env: { PATH: '/usr/bin:/bin' } },
      );
      children.push(child);
      let stderr = '';
      child.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once('error', reject);
      child.once('close', (status) => {
        connection.destroy();
        done({ status, stderr });
      });
    });
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(path, done);
  });
  try {
    const bytes = await new Promise<Buffer>((done, reject) => {
      const client = createConnection(path);
      const chunks: Buffer[] = [];
      client.setTimeout(45_000, () => {
        client.destroy();
        reject(new Error('broker test timeout'));
      });
      client.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE') reject(error);
      });
      client.on('data', (chunk: Buffer) => chunks.push(chunk));
      client.on('close', () => done(Buffer.concat(chunks)));
      client.once('connect', () => client.end(request));
    });
    return { bytes, ...(await result) };
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    await new Promise<void>((done) => server.close(() => done()));
  }
}

const request = () => `${PROTOCOL}\n${manifest}\n`;

it('releases exactly 32 key bytes to the admitted kernel peer for the verified release', async () => {
  expect(Buffer.byteLength(request())).toBe(93);
  const answer = await exchange(request());
  expect(answer.status, answer.stderr).toBe(0);
  expect(answer.bytes).toEqual(
    Buffer.concat([Buffer.from(`${PROTOCOL}\n`), Buffer.from(KEY, 'hex')]),
  );
  expect(answer.stderr).toBe('');
});

it('keeps the documented framing, release packaging and credential declaration aligned', () => {
  const guide = readFileSync(join(ROOT, 'docs/deployment/retrieval-key-release.md'), 'utf8');
  expect(guide).toContain(PROTOCOL);
  expect(guide).toContain('at most 93 bytes');
  const recipe = readFileSync(join(ROOT, 'scripts/deploy/build-release.sh'), 'utf8');
  expect(recipe).toContain('scripts/deploy/peer-credentials.c');
  expect(recipe).toContain('-o "$release_root/tools/kf-peer-credentials"');
  const service = readFileSync(join(ROOT, 'deploy/systemd/kf-retrieval-key@.service'), 'utf8');
  expect(service).toContain('StandardInput=socket');
  expect(service).toContain('StandardOutput=socket');
  expect(service).toContain(
    'LoadCredential=index-key:/run/kf-workstation-credentials/current/retrieval-index-key',
  );
  expect(service).toContain('User=kf-retrieval-key');
  expect(service).toContain('LimitCORE=0');
  expect(service).toContain('MemorySwapMax=0');
});

it('refuses a different peer UID without returning key bytes', async () => {
  configure(uid + 1);
  try {
    const answer = await exchange(request());
    expect(answer.status).toBe(1);
    expect(answer.bytes.length).toBe(0);
    expect(answer.stderr).toBe('retrieval key release refused\n');
  } finally {
    configure(uid);
  }
});

it('refuses stale release requests and extra request framing', async () => {
  for (const payload of [
    `${PROTOCOL}\n${'0'.repeat(64)}\n`,
    `${request()}extra\n`,
    'unsupported\n',
  ]) {
    const answer = await exchange(payload);
    expect(answer.status).toBe(1);
    expect(answer.bytes.length).toBe(0);
    expect(answer.stderr).not.toContain(KEY);
  }
});

it('refuses changed sealed release bytes, including executable verifier inputs', async () => {
  for (const path of [
    'data.txt',
    'scripts/deploy/migrate-release.sh',
    'scripts/lib/secret.sh',
    'tools/kf-peer-credentials',
  ]) {
    const location = join(release, path);
    const original = readFileSync(location);
    writeFileSync(location, Buffer.concat([original, Buffer.from('\nchanged\n')]));
    try {
      const answer = await exchange(request());
      expect(answer.status).toBe(1);
      expect(answer.bytes.length).toBe(0);
      expect(answer.stderr).not.toContain(KEY);
    } finally {
      writeFileSync(location, original);
    }
  }
});

it('refuses a widened, symlinked or malformed credential without exposing its contents', async () => {
  const path = join(credentials, 'index-key');
  chmodSync(path, 0o440);
  try {
    expect((await exchange(request())).status).toBe(1);
  } finally {
    chmodSync(path, 0o400);
  }
  rmSync(path);
  symlinkSync(join(release, 'data.txt'), path);
  try {
    expect((await exchange(request())).bytes.length).toBe(0);
  } finally {
    rmSync(path);
    writeFileSync(path, KEY, { mode: 0o400 });
  }
  rmSync(path);
  writeFileSync(path, Buffer.alloc(64, 0xe1), { mode: 0o400 });
  try {
    const answer = await exchange(request());
    expect(answer.status).toBe(1);
    expect(answer.bytes.length).toBe(0);
    expect(answer.stderr).toBe('retrieval key release refused\n');
  } finally {
    rmSync(path);
    writeFileSync(path, KEY, { mode: 0o400 });
  }
});

it('cannot authenticate stdin that is not a connected Unix socket', () => {
  const fd = openSync(join(release, 'data.txt'), 'r');
  try {
    const result = spawnSync(join(release, 'tools/kf-peer-credentials'), [], {
      stdio: [fd, 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  } finally {
    closeSync(fd);
  }
});

it('refuses active swap even for an admitted peer and intact release', async () => {
  const answer = await exchange(
    request(),
    'Filename Type Size Used Priority\n/dev/synthetic partition 1024 0 -2\n',
  );
  expect(answer.status).toBe(1);
  expect(answer.bytes.length).toBe(0);
});

it('gets no key when the broker listener is stopped', async () => {
  const path = join(parent, 'stopped.sock');
  const server = createServer();
  await new Promise<void>((done) => server.listen(path, done));
  await new Promise<void>((done) => server.close(() => done()));
  await expect(
    new Promise((done, reject) => {
      const client = createConnection(path);
      client.once('error', reject);
      client.once('connect', () => {
        client.destroy();
        done('unexpected connection');
      });
    }),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});
