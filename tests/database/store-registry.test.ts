/**
 * A declared store carries its address, and a process that claims it is held to it
 * (KF-SAS-RQ-095, SAS §100.5, migration 20260925160000).
 *
 * Against a real PostgreSQL, through the application login:
 *
 *   1. The first process to present an address for `working` binds it; the same address, written
 *      differently, is accepted; a different bucket or endpoint is refused by the registry with
 *      StoreAddressMismatch, and — the registry bypassed — by the database seam itself.
 *   2. `durable`, which nothing declared before this, is declared and bound on first use.
 *   3. No application login may rewrite an address; an address with credentials in it is refused
 *      by the table.
 *   4. The API resolves its stores through the registry: configured with the wrong bucket it
 *      refuses to serve, and no request reaches the store.
 *
 * Not covered: that the first address was the right one (nothing checks that; ADR 0017).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  InMemoryObjectStore,
  StoreAddressMismatch,
  StoreRegistry,
  type S3Config,
} from '@kf/artifacts';
import { withTransaction } from '@kf/database';
import { buildApp } from '../../apps/api/src/app.js';
import type { ApiConfig } from '../../apps/api/src/config.js';
import { startHarness, type Harness } from './harness.js';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

function s3(endpoint: string, bucket: string): S3Config {
  return {
    endpoint,
    bucket,
    region: 'us-east-1',
    accessKeyId: 'kf-test-access-key',
    secretAccessKey: 'test-only-not-a-secret',
  };
}

const memory = { construct: () => new InMemoryObjectStore() };

async function row(id: string): Promise<Record<string, unknown> | undefined> {
  return withTransaction(h.adminPool, (tx) =>
    tx.maybeOne(
      'select id, kind, endpoint, bucket, bound_at from content.artifact_store where id = $1',
      [id],
    ),
  );
}

describe('a store is bound to its address', () => {
  it('binds working on first use, accepts it again, and refuses another bucket or endpoint', async () => {
    expect(await row('working')).toMatchObject({ endpoint: null, bucket: null, bound_at: null });

    await withTransaction(h.pool, (tx) =>
      StoreRegistry.fromDatabase(tx, { working: s3('http://minio:9000', 'kf-artifacts') }, memory),
    );
    expect(await row('working')).toMatchObject({
      kind: 'object_store',
      endpoint: 'http://minio:9000',
      bucket: 'kf-artifacts',
    });
    expect((await row('working'))?.['bound_at']).toBeInstanceOf(Date);

    await withTransaction(h.pool, (tx) =>
      StoreRegistry.fromDatabase(tx, { working: s3('HTTP://MINIO:9000/', 'kf-artifacts') }, memory),
    );

    await expect(
      withTransaction(h.pool, (tx) =>
        StoreRegistry.fromDatabase(tx, { working: s3('http://minio:9000', 'other') }, memory),
      ),
    ).rejects.toBeInstanceOf(StoreAddressMismatch);
    await expect(
      withTransaction(h.pool, (tx) =>
        StoreRegistry.fromDatabase(
          tx,
          { working: s3('https://storage.example.com', 'kf-artifacts') },
          memory,
        ),
      ),
    ).rejects.toBeInstanceOf(StoreAddressMismatch);
    expect(await row('working')).toMatchObject({ bucket: 'kf-artifacts' });
  });

  it('refuses a different address at the database seam when the registry is bypassed', async () => {
    await expect(
      withTransaction(h.pool, (tx) =>
        tx.query(
          `select content.bind_artifact_store('working', 'x', 'http://minio:9000', 'other')`,
        ),
      ),
    ).rejects.toThrow(/artifact_store_address_mismatch/);
  });

  it('declares and binds durable, which nothing declared before', async () => {
    expect(await row('durable')).toBeUndefined();
    const registry = await withTransaction(h.pool, (tx) =>
      StoreRegistry.fromDatabase(
        tx,
        {
          working: s3('http://minio:9000', 'kf-artifacts'),
          durable: s3('https://storage.googleapis.com', 'kf-durable'),
        },
        memory,
      ),
    );
    expect(registry.ids().toSorted()).toEqual(['durable', 'working']);
    expect(await row('durable')).toMatchObject({
      kind: 'object_store',
      endpoint: 'https://storage.googleapis.com',
      bucket: 'kf-durable',
    });
  });

  it('gives no application login a way to rewrite an address, and keeps credentials out of it', async () => {
    await expect(
      withTransaction(h.pool, (tx) =>
        tx.query(`update content.artifact_store set bucket = 'other' where id = 'working'`),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTransaction(h.pool, (tx) =>
        tx.query(
          `select content.bind_artifact_store('leaky', 'x', 'https://key:secret@s3.example.com', 'b1')`,
        ),
      ),
    ).rejects.toThrow(/check constraint/);
    await withTransaction(h.adminPool, (tx) =>
      tx.query(
        `insert into content.artifact_store (id, kind, label) values ('mem', 'memory', 'm')`,
      ),
    );
    await expect(
      withTransaction(h.pool, (tx) =>
        StoreRegistry.fromDatabase(tx, { mem: s3('http://minio:9000', 'kf-mem') }, memory),
      ),
    ).rejects.toBeInstanceOf(StoreAddressMismatch);
    await expect(
      withTransaction(h.pool, (tx) =>
        tx.query(`select content.bind_artifact_store('mem', 'x', 'http://minio:9000', 'kf-mem')`),
      ),
    ).rejects.toThrow(/not an object store/);
  });
});

describe('the API resolves its stores through the registry', () => {
  function appUrl(): string {
    const uri = new URL(h.connectionString);
    uri.username = 'kf_app_login';
    uri.password = 'test-only-not-a-secret';
    return uri.toString();
  }

  function config(artifactStore: S3Config): ApiConfig {
    return {
      host: '127.0.0.1',
      port: 0,
      logLevel: 'silent',
      databaseUrl: appUrl(),
      environment: 'test',
      deploymentProfile: 'development',
      tlsTerminatedUpstream: false,
      identity: undefined,
      projectionsArtifact: join(
        import.meta.dirname,
        '..',
        '..',
        'generated',
        'projections',
        'knowledge-fabric.projections.json',
      ),
      artifactStore,
    };
  }

  it('refuses to serve when configured with a bucket the ledger does not call working', async () => {
    const app = await buildApp(config(s3('http://minio:9000', 'yesterdays-bucket')));
    try {
      await expect(app.ready()).rejects.toThrow(
        /refusing to serve: store working is registered at http:\/\/minio:9000 bucket kf-artifacts/,
      );
    } finally {
      await app.close().catch(() => undefined);
    }
  });

  it('serves when configured with the registered address', async () => {
    const app = await buildApp(config(s3('http://minio:9000/', 'kf-artifacts')));
    try {
      await app.ready();
    } finally {
      await app.close();
    }
  });
});
