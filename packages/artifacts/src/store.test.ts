import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryObjectStore, S3ObjectStore } from './store.js';

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
});

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server has no port');
  return address.port;
}

describe('bounded object reads', () => {
  it('refuses an in-memory object larger than the caller cap', async () => {
    const store = new InMemoryObjectStore();
    await store.put('source', Buffer.from('oversized'), 'application/octet-stream');

    await expect(store.read('source', undefined, 4)).rejects.toMatchObject({
      code: 'object_read_limit_exceeded',
      key: 'source',
      maxBytes: 4,
    });
  });

  it('returns exact historical versions and rejects unknown version ids', async () => {
    const store = new InMemoryObjectStore();
    const first = await store.put('source', Buffer.from('first'), 'text/plain');
    const second = await store.put('source', Buffer.from('second'), 'text/plain');

    await expect(store.read('source')).resolves.toEqual(Buffer.from('second'));
    await expect(store.read('source', first.versionId)).resolves.toEqual(Buffer.from('first'));
    await expect(store.read('source', second.versionId)).resolves.toEqual(Buffer.from('second'));
    await expect(store.read('source', 'missing')).rejects.toThrow(
      'object source version missing not found',
    );
  });

  it('does not expose mutable aliases to stored version bytes', async () => {
    const store = new InMemoryObjectStore();
    const source = Buffer.from('immutable');
    const stored = await store.put('source', source, 'text/plain');

    source.fill(0x78);
    const firstRead = await store.read('source', stored.versionId);
    expect(firstRead).toEqual(Buffer.from('immutable'));
    firstRead.fill(0x79);
    await expect(store.read('source', stored.versionId)).resolves.toEqual(Buffer.from('immutable'));
  });

  it('aborts an S3 chunked response before buffering the complete oversized body', async () => {
    let sentChunks = 0;
    let confirmResponseClosed: (() => void) | undefined;
    const responseClosed = new Promise<void>((resolve) => {
      confirmResponseClosed = resolve;
    });
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      let timer: NodeJS.Timeout | undefined;
      const writeNext = (): void => {
        sentChunks += 1;
        response.write(Buffer.alloc(4, sentChunks));
        if (sentChunks === 4) {
          response.end();
          return;
        }
        timer = setTimeout(writeNext, 30);
      };
      response.once('close', () => {
        if (timer !== undefined) clearTimeout(timer);
        confirmResponseClosed?.();
      });
      writeNext();
    });
    const port = await listen(server);
    const store = new S3ObjectStore({
      endpoint: `http://127.0.0.1:${String(port)}`,
      region: 'test',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      bucket: 'test',
      forcePathStyle: true,
    });

    await expect(store.read('source', undefined, 5)).rejects.toMatchObject({
      code: 'object_read_limit_exceeded',
      key: 'source',
      maxBytes: 5,
    });
    await responseClosed;
    const chunksAtClose = sentChunks;
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(sentChunks).toBe(chunksAtClose);
    expect(sentChunks).toBeLessThan(4);
  });
});

describe('conditional object creation', () => {
  it('creates one in-memory version under concurrent calls', async () => {
    const store = new InMemoryObjectStore();
    const [first, second] = await Promise.all([
      store.putIfAbsent('source', Buffer.from('first'), 'text/plain'),
      store.putIfAbsent('source', Buffer.from('second'), 'text/plain'),
    ]);

    expect(second).toEqual(first);
    await expect(store.read('source', first.versionId)).resolves.toEqual(Buffer.from('first'));
  });

  it('retries an S3 conditional conflict when no winning object remains', async () => {
    let putRequests = 0;
    const server = createServer((request, response) => {
      if (request.method === 'HEAD') {
        response.writeHead(404);
        response.end();
        return;
      }
      putRequests += 1;
      expect(request.headers['if-none-match']).toBe('*');
      if (putRequests === 1) {
        response.writeHead(409, { 'content-type': 'application/xml' });
        response.end(
          '<Error><Code>ConditionalRequestConflict</Code><Message>conflict</Message></Error>',
        );
        return;
      }
      response.writeHead(200, { 'x-amz-version-id': 'immutable-v1' });
      response.end();
    });
    const port = await listen(server);
    const store = new S3ObjectStore({
      endpoint: `http://127.0.0.1:${String(port)}`,
      region: 'test',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      bucket: 'test',
      forcePathStyle: true,
    });

    await expect(store.putIfAbsent('source', Buffer.from('bytes'), 'text/plain')).resolves.toEqual({
      key: 'source',
      sizeBytes: 5,
      versionId: 'immutable-v1',
    });
    expect(putRequests).toBe(2);
  });
});
