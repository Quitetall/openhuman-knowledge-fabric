/** Real SDK serialization/streaming on an owned loopback server, not B2/TLS or encryption qualification. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { B2ArchiveAdapter } from './internal/offsite/b2.js';

const configuration = {
  endpoint: 'https://s3.us-west-004.backblazeb2.com',
  bucket: 'opaque-backups',
  applicationKeyId: 'public-fixture-key-id',
  applicationKey: 'public-fixture-application-key',
};
// Public packet-framing fixture deliberately exceeds the source iterator's 64 KiB chunk.
const ciphertext = Buffer.alloc(256 * 1024 + 1, 0x85);
const digest = createHash('sha256').update(ciphertext).digest('hex');
const versionId = '4_historical_version+/=';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(
  fault?:
    | 'wrong-version'
    | 'wrong-bytes'
    | 'short-stream'
    | 'refused-put'
    | 'redirect'
    | 'stall-put'
    | 'stall-get',
) {
  const root = mkdtempSync(join(tmpdir(), 'kf-b2-wire-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source.tar.gpg');
  writeFileSync(source, ciphertext);
  const requests: Array<{ method: string; path: string; version: string | null; signed: boolean }> =
    [];
  let uploaded: Buffer | undefined;
  async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://owned.invalid');
    requests.push({
      method: request.method ?? '',
      path: url.pathname,
      version: url.searchParams.get('versionId'),
      signed: request.headers.authorization?.startsWith('AWS4-HMAC-SHA256 ') === true,
    });
    response.setHeader('connection', 'close');
    if (url.pathname === '/redirect-target') {
      response.setHeader('x-amz-version-id', versionId);
      response.end();
    } else if (url.searchParams.has('versioning')) {
      response.setHeader('content-type', 'application/xml');
      response.end(
        '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>',
      );
    } else if (url.searchParams.has('acl')) {
      response.setHeader('content-type', 'application/xml');
      response.end(
        '<AccessControlPolicy xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>owner</ID></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>owner</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>',
      );
    } else if (request.method === 'PUT') {
      const parts: Buffer[] = [];
      for await (const chunk of request) parts.push(Buffer.from(chunk));
      uploaded = Buffer.concat(parts);
      if (fault === 'stall-put') return;
      if (fault === 'refused-put') {
        response.statusCode = 403;
        response.setHeader('content-type', 'application/xml');
        response.end(
          `<Error><Code>AccessDenied</Code><Message>${configuration.applicationKey}</Message></Error>`,
        );
      } else if (fault === 'redirect') {
        response.statusCode = 307;
        // The target must be this observed server, not an unobserved/unresolvable hostname.
        response.setHeader('location', `http://${request.headers.host}/redirect-target`);
        response.end();
      } else {
        response.setHeader('x-amz-version-id', versionId);
        response.end();
      }
    } else if (request.method === 'GET') {
      response.setHeader('content-length', ciphertext.length);
      response.setHeader(
        'x-amz-version-id',
        fault === 'wrong-version' ? 'latest-not-recorded' : versionId,
      );
      if (fault === 'stall-get') {
        response.flushHeaders();
        return;
      }
      // A request for latest receives different bytes; only the historical query can succeed.
      const bytes =
        fault === 'wrong-bytes' || url.searchParams.get('versionId') !== versionId
          ? Buffer.alloc(ciphertext.length, 1)
          : (uploaded ?? ciphertext);
      response.end(fault === 'short-stream' ? bytes.subarray(0, 100) : bytes);
    } else {
      response.statusCode = 400;
      response.end();
    }
  }
  const server = createServer((request, response) => {
    void respond(request, response).catch(() => response.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('owned server did not bind');
  const store = new B2ArchiveAdapter(configuration, (options) => {
    // Preserve ALL production client options except the owned test transport endpoint.
    expect(options.endpoint).toBe(configuration.endpoint);
    return new S3Client({ ...options, endpoint: `http://127.0.0.1:${address.port}` });
  });
  cleanup.push(() => store.close());
  return { root, source, store, requests, uploaded: () => uploaded };
}

describe('B2 transport through the pinned real SDK and owned HTTP wire', () => {
  it('streams the actual source bytes and restores exactly the encoded historical version', async () => {
    const run = await fixture();
    const copy = await run.store.publish(run.source);
    expect(copy).toEqual({
      format: 'kf-offsite-object-v1',
      endpoint: configuration.endpoint,
      bucket: configuration.bucket,
      key: `kf-backups/v1/${digest}.tar.gpg`,
      versionId,
      sha256: digest,
      sizeBytes: ciphertext.length,
    });
    expect(run.uploaded()).toEqual(ciphertext);
    const target = join(run.root, 'pulled.tar.gpg');
    await run.store.pull(copy, target);
    expect(readFileSync(target)).toEqual(ciphertext);
    expect(run.requests.every((request) => request.signed)).toBe(true);
    const gets = run.requests.filter(
      (request) => request.method === 'GET' && request.path.includes('/kf-backups/'),
    );
    expect(gets).toHaveLength(2);
    expect(gets.every((request) => request.version === versionId)).toBe(true);
  });
  it.each(['wrong-version', 'wrong-bytes', 'short-stream', 'refused-put', 'redirect'] as const)(
    'refuses %s through the real SDK without returning a copy identity',
    async (fault) => {
      const run = await fixture(fault);
      const result: unknown = await run.store.publish(run.source).catch((error: unknown) => error);
      expect(result).toMatchObject({
        name: 'OffsiteTransferRefused',
        message: 'off-site ciphertext transfer refused',
      });
      expect(result).not.toHaveProperty('cause');
      expect(run.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
      expect(run.requests.some((request) => request.path === '/redirect-target')).toBe(false);
    },
  );
  it.each(['stall-put', 'stall-get'] as const)(
    'cancels a stalled real SDK %s and closes its resources',
    async (fault) => {
      const run = await fixture(fault);
      const abort = new AbortController();
      const rejected = expect(run.store.publish(run.source, abort.signal)).rejects.toMatchObject({
        code: 'offsite_transfer_refused',
      });
      await vi.waitFor(() => {
        expect(run.uploaded()).toEqual(ciphertext);
        if (fault === 'stall-get')
          expect(run.requests.some((request) => request.version === versionId)).toBe(true);
      });
      abort.abort();
      await rejected;
    },
  );
});
