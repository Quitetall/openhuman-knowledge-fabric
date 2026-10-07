/**
 * deploy/object-store/init-buckets.sh checks its own work.
 *
 * "PUT ?versioning answered 200" is not "versioning is on". ADR 0039 rejected Garage because its
 * GetBucketVersioning answers "not enabled" whatever it was told; a script that only wrote would
 * have reported success against it. These run the script against a stand-in S3 endpoint that
 * accepts every write and answers the read-back from a table, so each refusal is the script's.
 */
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const SCRIPT = resolve(import.meta.dirname, '../../deploy/object-store/init-buckets.sh');
const SECRET = 'init-test-secret-value';
const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Stand {
  readonly endpoint: string;
  readonly requests: string[];
}

/** An S3 endpoint that takes every write and answers GetBucketVersioning with `status(bucket)`. */
async function stand(
  status: (bucket: string) => string | undefined,
  refuse = false,
): Promise<Stand> {
  const requests: string[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    const url = request.url ?? '/';
    requests.push(`${request.method ?? ''} ${url}`);
    request.resume();
    if (refuse) {
      response.writeHead(403, { 'content-type': 'application/xml' });
      response.end('<Error><Code>AccessDenied</Code></Error>');
      return;
    }
    const bucket = url.split('?')[0]?.replaceAll('/', '') ?? '';
    response.writeHead(200, { 'content-type': 'application/xml' });
    if (request.method === 'GET' && url.endsWith('?versioning')) {
      const answer = status(bucket);
      response.end(
        `<VersioningConfiguration>${answer === undefined ? '' : `<Status>${answer}</Status>`}</VersioningConfiguration>`,
      );
      return;
    }
    response.end(request.method === 'GET' ? '<ListAllMyBucketsResult/>' : '');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { endpoint: `http://127.0.0.1:${address.port}`, requests };
}

async function run(
  endpoint: string,
  buckets = 'kf-artifacts kf-exports',
): Promise<{ code: number; output: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'kf-init-buckets-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'secret'), SECRET, { mode: 0o600 });
  try {
    const { stdout, stderr } = await exec('sh', [SCRIPT], {
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        KF_OBJECTS_ENDPOINT: endpoint,
        KF_OBJECTS_ACCESS_KEY_ID: 'init-test',
        KF_OBJECTS_SECRET_ACCESS_KEY_FILE: join(dir, 'secret'),
        KF_OBJECTS_BUCKETS: buckets,
        KF_OBJECTS_WAIT_SECONDS: '5',
      },
      timeout: 30_000,
    });
    return { code: 0, output: stdout + stderr };
  } catch (error: unknown) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, output: (failed.stdout ?? '') + (failed.stderr ?? '') };
  }
}

describe('init-buckets.sh', () => {
  it('creates each bucket, enables versioning, and passes when every bucket reads Enabled', async () => {
    const s3 = await stand(() => 'Enabled');
    const result = await run(s3.endpoint);

    expect(result).toMatchObject({ code: 0 });
    expect(result.output).toContain(
      'buckets ready with versioning enabled: kf-artifacts kf-exports',
    );
    expect(s3.requests).toEqual([
      'GET /',
      'PUT /kf-artifacts',
      'PUT /kf-artifacts?versioning',
      'PUT /kf-exports',
      'PUT /kf-exports?versioning',
      'GET /kf-artifacts?versioning',
      'GET /kf-exports?versioning',
    ]);
    expect(result.output).not.toContain(SECRET);
  });

  it('fails, naming the bucket, against a store that accepts versioning and never applies it', async () => {
    // Garage's GetBucketVersioning: an empty configuration, whatever was written.
    const s3 = await stand(() => undefined);
    const result = await run(s3.endpoint);

    expect(result.code).toBe(1);
    expect(result.output).toContain('bucket kf-artifacts does not have versioning Enabled');
  });

  it('fails on a bucket that reads Suspended, even when the others are Enabled', async () => {
    const s3 = await stand((bucket) => (bucket === 'kf-exports' ? 'Suspended' : 'Enabled'));
    const result = await run(s3.endpoint);

    expect(result.code).toBe(1);
    expect(result.output).toContain('bucket kf-exports does not have versioning Enabled');
    expect(result.output).not.toContain('kf-artifacts does not');
  });

  it('stops at the first refusal of its credentials instead of waiting', async () => {
    const s3 = await stand(() => 'Enabled', true);
    const result = await run(s3.endpoint);

    expect(result.code).toBe(1);
    expect(result.output).toContain('refused ListBuckets for init-test');
    expect(s3.requests).toEqual(['GET /']);
    expect(result.output).not.toContain(SECRET);
  });
});
