import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { VersioningNotEnabled, bucketVersioning, requireVersioning } from './versioning.js';

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
});

/** A store that answers GetBucketVersioning from a table, as a real one would on the wire. */
async function store(answers: Record<string, string | undefined>): Promise<string> {
  const server = createServer((request, response) => {
    const bucket = (request.url ?? '').split('?')[0]?.replaceAll('/', '') ?? '';
    const status = answers[bucket];
    response.writeHead(200, { 'content-type': 'application/xml' });
    response.end(
      '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
        (status === undefined ? '' : `<Status>${status}</Status>`) +
        '</VersioningConfiguration>',
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

const credentials = { region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' };

describe('object-store versioning', () => {
  it('reads Enabled, Suspended and a bucket that never had a configuration', async () => {
    const endpoint = await store({ a: 'Enabled', b: 'Suspended' });
    const answers = await bucketVersioning({ endpoint, ...credentials }, ['a', 'b', 'c']);
    expect([...answers]).toEqual([
      ['a', 'Enabled'],
      ['b', 'Suspended'],
      ['c', 'never enabled'],
    ]);
  });

  it('refuses naming every bucket that is not Enabled, and only those', async () => {
    const endpoint = await store({ 'kf-artifacts': 'Enabled', 'kf-exports': 'Suspended' });
    const refusal = await requireVersioning({ endpoint, ...credentials }, [
      'kf-artifacts',
      'kf-exports',
      'kf-snapshots',
    ]).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(VersioningNotEnabled);
    expect([...(refusal as VersioningNotEnabled).buckets.keys()]).toEqual([
      'kf-exports',
      'kf-snapshots',
    ]);
    expect((refusal as Error).message).toContain('bucket kf-snapshots is never enabled');
  });

  it('passes when every bucket answers Enabled', async () => {
    const endpoint = await store({ a: 'Enabled', b: 'Enabled' });
    await expect(requireVersioning({ endpoint, ...credentials }, ['a', 'b'])).resolves.toBe(
      undefined,
    );
  });
});
