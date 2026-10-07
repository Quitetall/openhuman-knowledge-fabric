/**
 * The S3 addressing a store is configured with is the addressing it uses (ADR 0039).
 *
 * Backblaze B2's S3 API is a custom endpoint (`https://s3.<region>.backblazeb2.com`) with its
 * own region, and accepts both path-style and virtual-hosted-style requests. A presigned URL is
 * built from exactly the configuration a request would be, with no network, so it shows which
 * one a store will send: `<endpoint>/<bucket>/<key>` or `<bucket>.<endpoint host>/<key>`, signed
 * for the configured region.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { S3ObjectStore, type S3Config } from './store.js';

const B2: S3Config = {
  endpoint: 'https://s3.us-west-004.backblazeb2.com',
  region: 'us-west-004',
  accessKeyId: 'kf-test-key-id',
  secretAccessKey: 'kf-test-application-key',
  bucket: 'kf-artifacts-durable',
};

async function presigned(config: S3Config): Promise<URL> {
  return new URL(await new S3ObjectStore(config).presignPut('artifacts/a/v1', 'text/plain', 60));
}

describe('S3 addressing for a custom endpoint and region', () => {
  it('sends path-style requests when path style is forced', async () => {
    const url = await presigned({ ...B2, forcePathStyle: true });
    expect(url.host).toBe('s3.us-west-004.backblazeb2.com');
    expect(url.pathname).toBe('/kf-artifacts-durable/artifacts/a/v1');
  });

  it('sends virtual-hosted requests when it is not', async () => {
    const url = await presigned({ ...B2, forcePathStyle: false });
    expect(url.host).toBe('kf-artifacts-durable.s3.us-west-004.backblazeb2.com');
    expect(url.pathname).toBe('/artifacts/a/v1');
  });

  it('signs for the configured region, not a default one', async () => {
    const url = await presigned({ ...B2, forcePathStyle: false });
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/\/us-west-004\/s3\/aws4_request$/);
    // The credential's key id is in a presigned URL by design; the secret never is.
    expect(url.toString()).not.toContain(B2.secretAccessKey);
  });
});

describe('conditional create', () => {
  /** A store that answers HEAD 404 and PUT 200, recording what each PUT asked for. */
  async function recordingStore(): Promise<{
    endpoint: string;
    puts: Record<string, string | string[] | undefined>[];
    close(): Promise<void>;
  }> {
    const puts: Record<string, string | string[] | undefined>[] = [];
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        if (request.method === 'HEAD') {
          response.writeHead(404).end();
          return;
        }
        puts.push(request.headers);
        response.writeHead(200, { 'x-amz-version-id': 'v1' }).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      endpoint: `http://127.0.0.1:${String(port)}`,
      puts,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it.each([
    [undefined, '*'],
    [true, '*'],
    [false, undefined],
  ] as const)('conditionalCreate %s sends If-None-Match %s', async (conditionalCreate, header) => {
    const store = await recordingStore();
    try {
      const stored = await new S3ObjectStore({
        ...B2,
        endpoint: store.endpoint,
        forcePathStyle: true,
        ...(conditionalCreate === undefined ? {} : { conditionalCreate }),
      }).putIfAbsent('artifacts/a/v1', Buffer.from('bytes'), 'text/plain');
      expect(stored.versionId).toBe('v1');
      expect(store.puts).toHaveLength(1);
      expect(store.puts[0]!['if-none-match']).toBe(header);
    } finally {
      await store.close();
    }
  });
});
