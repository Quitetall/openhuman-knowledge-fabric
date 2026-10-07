/**
 * A throwaway S3-compatible endpoint, with versioning and object lock, for the off-site copy and
 * the durable store tests (ADR 0039).
 *
 * It is the working object store the stack runs, SeaweedFS, started exactly as docker-compose.yml
 * starts it (tests/database/preservation-object-store.ts reads the image digest and arguments
 * from there), with its buckets made by deploy/object-store/init-buckets.sh, which refuses to
 * finish unless each reads back versioning Enabled. Until 2026-10 this ran MinIO images built
 * from source. The tests above it speak S3 only, and need of the endpoint exactly three things:
 * versioned buckets, a bucket with object lock, and a bucket without versioning.
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

import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PreservationObjectStore } from '../database/preservation-object-store.js';

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
  // Versioned through init-buckets.sh, which reads each one back as Enabled.
  const fixture = new PreservationObjectStore(
    [BUCKETS.plain, BUCKETS.working, BUCKETS.durable],
    [],
    REGION,
  );
  const proxies: Server[] = [];
  try {
    const { id, endpoint: loopbackEndpoint } = await fixture.start();
    const remoteEndpoint = await fixture.containerEndpoint(id);
    const { accessKeyId, secretAccessKey } = fixture.credentials(remoteEndpoint);
    // The store tampered with directly, as somebody holding its keys would, not through the code
    // under test: signed requests from inside the store's network.
    const s3 = async (
      what: string,
      expected: number,
      ...args: Parameters<PreservationObjectStore['request']> extends [string, ...infer Rest]
        ? Rest
        : never
    ): Promise<void> => {
      const answer = await fixture.request(id, ...args);
      if (answer.status !== expected) {
        throw new Error(`${what}: HTTP ${String(answer.status)} ${answer.body.slice(0, 300)}`);
      }
    };
    // Object lock is a property of a bucket at creation, and turns versioning on with it.
    await s3(`create ${BUCKETS.locked}`, 200, 'PUT', BUCKETS.locked, undefined, {
      'x-amz-bucket-object-lock-enabled': 'true',
    });
    await s3(`create ${BUCKETS.unversioned}`, 200, 'PUT', BUCKETS.unversioned);

    return {
      remoteEndpoint,
      loopbackEndpoint,
      accessKeyId,
      secretAccessKey,
      credentialFiles(directory) {
        const keyId = join(directory, `key-id-${randomUUID()}`);
        const secret = join(directory, `application-key-${randomUUID()}`);
        writeFileSync(keyId, `${accessKeyId}\n`, { mode: 0o600 });
        writeFileSync(secret, `${secretAccessKey}\n`, { mode: 0o600 });
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
        await s3(`overwrite ${bucket}/${key}`, 200, 'PUT', `${bucket}/${key}`, body);
      },
      async deleteVersion(bucket, key, versionId) {
        await fixture.deleteVersion(id, bucket, key, versionId);
      },
      async deleteMarker(bucket, key) {
        await s3(`delete marker on ${bucket}/${key}`, 204, 'DELETE', `${bucket}/${key}`);
      },
      async stop() {
        for (const server of proxies) server.close();
        await fixture.stop();
      },
    };
  } catch (error: unknown) {
    await fixture.stop().catch(() => undefined);
    throw error;
  }
}
