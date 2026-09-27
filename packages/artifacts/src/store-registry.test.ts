/**
 * Every store a process holds is resolved against its registered row (KF-SAS-RQ-095).
 *
 * Unit level, with a fake transaction that answers the one select and records the bind: what
 * the registry refuses before it builds a client, and — by reading the application sources —
 * that no program builds an S3 client for an artifact store except through the registry.
 * `tests/database/store-registry.test.ts` holds the same refusals against a real PostgreSQL,
 * including the one the database repeats when the registry is bypassed.
 *
 * What this does not cover: whether the FIRST address bound was the right one. Nothing does;
 * the first process to present one binds it (ADR 0017 note of 2026-09-25).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Tx } from '@kf/database';
import { StoreAddressMismatch, StoreRegistry, normalizeStoreEndpoint } from './locations.js';
import { InMemoryObjectStore, type S3Config } from './store.js';

interface Row {
  readonly id: string;
  readonly kind: string;
  readonly endpoint: string | null;
  readonly bucket: string | null;
}

function fakeTx(rows: readonly Row[], bindError?: Error): { tx: Tx; binds: unknown[][] } {
  const binds: unknown[][] = [];
  const tx = {
    async maybeOne(_sql: string, params: readonly unknown[]) {
      return rows.find((row) => row.id === params[0]);
    },
    async query(sql: string, params: readonly unknown[]) {
      if (!sql.includes('content.bind_artifact_store')) throw new Error(`unexpected: ${sql}`);
      if (bindError !== undefined) throw bindError;
      binds.push([...params]);
      return [];
    },
  } as unknown as Tx;
  return { tx, binds };
}

function config(endpoint: string, bucket: string): S3Config {
  return { endpoint, bucket, region: 'us-east-1', accessKeyId: 'id', secretAccessKey: 'secret' };
}

function counting(): { construct: (config: S3Config) => InMemoryObjectStore; built: S3Config[] } {
  const built: S3Config[] = [];
  return {
    built,
    construct: (c) => {
      built.push(c);
      return new InMemoryObjectStore();
    },
  };
}

const BOUND: Row = {
  id: 'working',
  kind: 'object_store',
  endpoint: 'http://minio:9000',
  bucket: 'kf-artifacts',
};

describe('StoreRegistry.fromDatabase', () => {
  it('refuses a store whose configured bucket differs from its registered row, before building a client', async () => {
    const { tx, binds } = fakeTx([BOUND]);
    const { construct, built } = counting();
    const refused = StoreRegistry.fromDatabase(
      tx,
      { working: config('http://minio:9000', 'yesterdays-bucket') },
      { construct },
    );
    await expect(refused).rejects.toBeInstanceOf(StoreAddressMismatch);
    await expect(refused).rejects.toMatchObject({
      code: 'artifact_store_address_mismatch',
      storeId: 'working',
      registered: { endpoint: 'http://minio:9000', bucket: 'kf-artifacts' },
      configured: { endpoint: 'http://minio:9000', bucket: 'yesterdays-bucket' },
    });
    expect(built).toEqual([]);
    expect(binds).toEqual([]);
  });

  it('refuses a store whose configured endpoint differs from its registered row', async () => {
    const { tx } = fakeTx([BOUND]);
    await expect(
      StoreRegistry.fromDatabase(tx, { working: config('http://elsewhere:9000', 'kf-artifacts') }),
    ).rejects.toBeInstanceOf(StoreAddressMismatch);
  });

  it('refuses to put an object-store address on a store declared as memory', async () => {
    const { tx } = fakeTx([{ id: 'durable', kind: 'memory', endpoint: null, bucket: null }]);
    await expect(
      StoreRegistry.fromDatabase(tx, { durable: config('http://minio:9000', 'kf-durable') }),
    ).rejects.toThrow(/declared memory, not an object store/);
  });

  it('accepts the registered address written differently, and binds it in its normal form', async () => {
    const { tx, binds } = fakeTx([BOUND]);
    const { construct, built } = counting();
    const registry = await StoreRegistry.fromDatabase(
      tx,
      { working: config('HTTP://MinIO:9000/', 'kf-artifacts') },
      { construct },
    );
    expect(registry.ids()).toEqual(['working']);
    expect(built).toHaveLength(1);
    expect(binds).toEqual([
      ['working', 'working object store (kf-artifacts)', 'http://minio:9000', 'kf-artifacts'],
    ]);
  });

  it('binds an unaddressed row and declares an undeclared store', async () => {
    const { tx, binds } = fakeTx([{ ...BOUND, endpoint: null, bucket: null }]);
    const { construct } = counting();
    const registry = await StoreRegistry.fromDatabase(
      tx,
      {
        working: config('http://minio:9000', 'kf-artifacts'),
        durable: config('https://storage.googleapis.com', 'kf-durable'),
      },
      { construct },
    );
    expect(registry.ids().toSorted()).toEqual(['durable', 'working']);
    expect(binds.map((bind) => bind[0])).toEqual(['durable', 'working']);
  });

  it('turns the database repeating the refusal (a race) into the same named error', async () => {
    const { tx } = fakeTx(
      [{ ...BOUND, endpoint: null, bucket: null }],
      new Error('artifact_store_address_mismatch: store working is registered at …'),
    );
    await expect(
      StoreRegistry.fromDatabase(tx, { working: config('http://minio:9000', 'kf-artifacts') }),
    ).rejects.toBeInstanceOf(StoreAddressMismatch);
  });
});

describe('normalizeStoreEndpoint', () => {
  it('refuses an endpoint carrying credentials rather than stripping them', () => {
    expect(() => normalizeStoreEndpoint('https://key:secret@s3.example.com')).toThrow(
      /must not carry credentials/,
    );
  });

  it('refuses a non-http endpoint and a query', () => {
    expect(() => normalizeStoreEndpoint('ftp://s3.example.com')).toThrow(/http or https/);
    expect(() => normalizeStoreEndpoint('https://s3.example.com/?x=1')).toThrow(/query/);
  });

  it('keeps a path prefix and drops only trailing slashes', () => {
    expect(normalizeStoreEndpoint('https://S3.Example.com:8443/prefix//')).toBe(
      'https://s3.example.com:8443/prefix',
    );
  });
});

describe('the deferred registry (the API)', () => {
  it('lets no call reach a store before its address resolves, and a mismatch refuses every later call', async () => {
    let attempts = 0;
    const pool = {
      async connect() {
        attempts += 1;
        const client = {
          async query(sql: string) {
            if (sql === 'begin' || sql === 'rollback' || sql === 'commit') return { rows: [] };
            if (sql.includes('select id, kind, endpoint, bucket')) return { rows: [BOUND] };
            throw new Error(`unexpected: ${sql}`);
          },
          release() {},
        };
        return client;
      },
    };
    const inner = new InMemoryObjectStore();
    await inner.put('k', Buffer.from('bytes'), 'text/plain');
    const registry = StoreRegistry.deferredFromDatabase(
      pool as never,
      { working: config('http://minio:9000', 'another-bucket') },
      { construct: () => inner },
    );
    const store = registry.get('working')!;
    await expect(store.read('k')).rejects.toBeInstanceOf(StoreAddressMismatch);
    await expect(store.put('k2', Buffer.from('x'), 'text/plain')).rejects.toBeInstanceOf(
      StoreAddressMismatch,
    );
    await expect(registry.verify()).rejects.toBeInstanceOf(StoreAddressMismatch);
    // Permanent: resolved once, not re-asked on every call.
    expect(attempts).toBe(1);
    expect(await inner.head('k2')).toBeUndefined();
  });
});

describe('no program builds an artifact-store client outside the registry', () => {
  // Each exception says why it is not an artifact store held by a running program.
  const EXCEPTIONS = new Map<string, string>([
    [
      'apps/checkpoint/src/main.ts',
      'the checkpoint anchor bucket holds signed checkpoints, not artifact versions; its login ' +
        'has no grant on the content schema by design',
    ],
    [
      'apps/kf-storage/src/verify-object-store.ts',
      'a database-free proof tool: it hashes the objects a request file names and connects to ' +
        'no ledger it could resolve an address against',
    ],
  ]);
  const root = join(import.meta.dirname, '..', '..', '..');

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return entry.name === 'node_modules' || entry.name === 'dist' ? [] : sources(path);
      }
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
    });
  }

  it('finds every `new S3ObjectStore(` in apps/ in the registry or in the named exceptions', () => {
    const offenders: string[] = [];
    const seen = new Set<string>();
    for (const file of sources(join(root, 'apps'))) {
      if (!readFileSync(file, 'utf8').includes('new S3ObjectStore(')) continue;
      const path = relative(root, file);
      seen.add(path);
      if (!EXCEPTIONS.has(path)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
    // An exception nobody needs any more is removed, not kept as a standing permission.
    expect([...EXCEPTIONS.keys()].filter((path) => !seen.has(path))).toEqual([]);
  });
});
