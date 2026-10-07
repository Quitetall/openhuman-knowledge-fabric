/**
 * A throwaway S3-compatible endpoint, with versioning and object lock, for the off-site copy and
 * the durable store tests (ADR 0039).
 *
 * It runs the locally built MinIO fixture image the preservation tests already use
 * (tests/fixtures/minio-image/build.sh), because that is the S3 test double this repository has
 * today. ADR 0039 replaces MinIO with SeaweedFS; when that lands, this file is the one place to
 * point at the new image — the tests above it speak S3 only, and need of the endpoint exactly
 * three things: versioned buckets, a bucket with object lock, and a bucket without.
 *
 * Two addresses are offered, because "is this endpoint this host?" is a property under test:
 *   `remoteEndpoint`   the container's own address on its Docker network — not an address of any
 *                      interface of this host, so the copier records the copy `remote-object`;
 *   `loopbackEndpoint` the same server through a port published on 127.0.0.1.
 *
 * And a corrupting proxy, which forwards every request unchanged (the SigV4 signature covers the
 * Host header it was sent to, and the proxy keeps it) and flips one byte of every object body
 * served by GetObject: a destination that answers with bytes other than the ones it was given.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const IMAGE = 'kf-fixture/minio:RELEASE.2025-09-07T16-13-09Z';
const CLIENT = 'kf-fixture/mc:RELEASE.2025-08-13T08-35-41Z';
const BUILD = 'tests/fixtures/minio-image/build.sh';
// Public fixture credentials, used only inside this throwaway container.
const ACCESS = 'kf-offsite-fixture';
const SECRET = 'kf-offsite-disposable-not-a-secret';
export const REGION = 'us-west-004';

/** Buckets every endpoint starts with. */
export const BUCKETS = {
  /** Versioned, with object lock: the shape of the B2 backup bucket ADR 0039 asks for. */
  locked: 'kf-backups-locked',
  /** Versioned, no object lock. */
  plain: 'kf-backups-plain',
  /** Never versioned. */
  unversioned: 'kf-backups-unversioned',
  /** Versioned working and durable artifact stores. */
  working: 'kf-artifacts',
  durable: 'kf-artifacts-durable',
} as const;

async function docker(...args: string[]): Promise<string> {
  return (await exec('docker', args, { timeout: 120_000, maxBuffer: 1024 * 1024 })).stdout.trim();
}

export interface S3Endpoint {
  readonly remoteEndpoint: string;
  readonly loopbackEndpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Write the access key id and secret into two 0600 files under `directory`. */
  credentialFiles(directory: string): { keyId: string; secret: string };
  /** A proxy to the remote endpoint that corrupts every GetObject body it serves. */
  corruptingProxy(): Promise<{ endpoint: string; close(): Promise<void> }>;
  /** Put a new version of `key` over whatever is there. */
  overwrite(bucket: string, key: string, body: string): Promise<void>;
  /** Permanently remove one version. */
  deleteVersion(bucket: string, key: string, versionId: string): Promise<void>;
  /** Hide the key behind a delete marker, removing no version. */
  deleteMarker(bucket: string, key: string): Promise<void>;
  stop(): Promise<void>;
}

export async function startS3Endpoint(): Promise<S3Endpoint> {
  for (const image of [IMAGE, CLIENT]) {
    await docker('image', 'inspect', '--format', '{{.Id}}', image).catch(() => {
      throw new Error(`fixture image ${image} is not built on this host; run ${BUILD}`);
    });
  }
  const id = await docker(
    'run',
    '--detach',
    '--rm',
    '--name',
    `kf-offsite-${randomUUID()}`,
    '--publish',
    '127.0.0.1::9000',
    '--env',
    `MINIO_ROOT_USER=${ACCESS}`,
    '--env',
    `MINIO_ROOT_PASSWORD=${SECRET}`,
    '--env',
    `MINIO_REGION=${REGION}`,
    IMAGE,
    'server',
    '/data',
  );
  const proxies: Server[] = [];
  try {
    const address = await docker(
      'inspect',
      '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      id,
    );
    const remoteEndpoint = `http://${address}:9000`;
    const loopbackEndpoint = `http://${await docker('port', id, '9000/tcp')}`;
    const deadline = Date.now() + 45_000;
    for (;;) {
      try {
        const response = await fetch(`${remoteEndpoint}/minio/health/live`, {
          signal: AbortSignal.timeout(1000),
        });
        await response.body?.cancel();
        if (response.ok) break;
      } catch {
        /* not listening yet */
      }
      if (Date.now() >= deadline) throw new Error('fixture S3 endpoint did not become ready');
      await sleep(200);
    }
    // The store's own client, inside the container's network namespace: the test tampers with
    // the store directly, as somebody holding its keys would, and not through the code under test.
    const mc = async (...args: string[]): Promise<string> =>
      docker(
        'run',
        '--rm',
        '--network',
        `container:${id}`,
        '--env',
        `MC_HOST_fixture=http://${ACCESS}:${SECRET}@127.0.0.1:9000`,
        CLIENT,
        ...args,
      );
    await mc('mb', '--region', REGION, '--with-lock', `fixture/${BUCKETS.locked}`);
    for (const bucket of [BUCKETS.plain, BUCKETS.working, BUCKETS.durable]) {
      await mc('mb', '--region', REGION, `fixture/${bucket}`);
      await mc('version', 'enable', `fixture/${bucket}`);
    }
    await mc('mb', '--region', REGION, `fixture/${BUCKETS.unversioned}`);

    return {
      remoteEndpoint,
      loopbackEndpoint,
      accessKeyId: ACCESS,
      secretAccessKey: SECRET,
      credentialFiles(directory) {
        const keyId = join(directory, `key-id-${randomUUID()}`);
        const secret = join(directory, `application-key-${randomUUID()}`);
        writeFileSync(keyId, `${ACCESS}\n`, { mode: 0o600 });
        writeFileSync(secret, `${SECRET}\n`, { mode: 0o600 });
        chmodSync(keyId, 0o600);
        chmodSync(secret, 0o600);
        return { keyId, secret };
      },
      async corruptingProxy() {
        const target = new URL(remoteEndpoint);
        const server = createServer((incoming, outgoing) => {
          const isGetObject =
            incoming.method === 'GET' && (incoming.url ?? '').includes('x-id=GetObject');
          const upstream = request(
            {
              host: target.hostname,
              port: target.port,
              method: incoming.method,
              path: incoming.url,
              headers: incoming.headers,
            },
            (response) => {
              outgoing.writeHead(response.statusCode ?? 502, response.headers);
              if (!isGetObject || (response.statusCode ?? 500) >= 300) {
                response.pipe(outgoing);
                return;
              }
              let first = true;
              response.on('data', (chunk: Buffer) => {
                if (first && chunk.length > 0) {
                  chunk[0] = chunk[0]! ^ 0xff;
                  first = false;
                }
                outgoing.write(chunk);
              });
              response.on('end', () => outgoing.end());
            },
          );
          upstream.on('error', () => outgoing.destroy());
          incoming.pipe(upstream);
        });
        proxies.push(server);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address() as AddressInfo;
        return {
          endpoint: `http://127.0.0.1:${String(port)}`,
          close: () => new Promise<void>((resolve) => server.close(() => resolve())),
        };
      },
      async overwrite(bucket, key, body) {
        // The client image has no shell, so the new body goes in as a mounted file.
        const directory = mkdtempSync(join(tmpdir(), 'kf-s3-overwrite-'));
        const file = join(directory, 'body');
        writeFileSync(file, body, { mode: 0o644 });
        try {
          await docker(
            'run',
            '--rm',
            '--network',
            `container:${id}`,
            '--volume',
            `${file}:/body:ro`,
            '--env',
            `MC_HOST_fixture=http://${ACCESS}:${SECRET}@127.0.0.1:9000`,
            CLIENT,
            'cp',
            '--quiet',
            '/body',
            `fixture/${bucket}/${key}`,
          );
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
      async deleteVersion(bucket, key, versionId) {
        await mc('rm', '--version-id', versionId, `fixture/${bucket}/${key}`);
      },
      async deleteMarker(bucket, key) {
        await mc('rm', `fixture/${bucket}/${key}`);
      },
      async stop() {
        for (const server of proxies) server.close();
        await docker('rm', '--force', id);
      },
    };
  } catch (error: unknown) {
    await docker('rm', '--force', id).catch(() => undefined);
    throw error;
  }
}
