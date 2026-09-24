/**
 * The API refuses to serve a database seeded with another ontology (KF-SAS-RQ-081).
 *
 * `registry.schema_release` names the ontology digest the seed installed; the release names the
 * digest it was compiled from in its projections artifact. Until 2026-09-25 nothing compared
 * them: a release switched without its migration, or a database seeded from another checkout,
 * served states and transitions the code does not define, and readiness said `ok` because a
 * current row existed. Each case plants the disagreement in a real PostgreSQL.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTransaction } from '@kf/database';
import { buildApp } from '../../apps/api/src/app.js';
import type { ApiConfig } from '../../apps/api/src/config.js';
import { startHarness, type Harness } from '../database/harness.js';

let h: Harness;
let original: string;
const PLANTED = 'c'.repeat(64);
const ARTIFACT = join(
  import.meta.dirname,
  '..',
  '..',
  'generated',
  'projections',
  'knowledge-fabric.projections.json',
);

function appUrl(): string {
  const uri = new URL(h.connectionString);
  uri.username = 'kf_app_login';
  uri.password = 'test-only-not-a-secret';
  return uri.toString();
}

function config(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    databaseUrl: appUrl(),
    environment: 'test',
    deploymentProfile: 'development',
    tlsTerminatedUpstream: false,
    identity: undefined,
    projectionsArtifact: ARTIFACT,
    ...overrides,
  };
}

const dogfood = (overrides: Partial<ApiConfig> = {}): ApiConfig =>
  config({
    deploymentProfile: 'dogfood',
    identity: {
      issuer: 'https://id.example.invalid/realms/kf',
      audience: 'knowledge-fabric',
      jwksUri: 'https://id.example.invalid/realms/kf/certs',
    },
    attestorSocket: '/nonexistent/kf-attestor.sock',
    ...overrides,
  });

async function plantOtherSeed(): Promise<void> {
  await withTransaction(h.adminPool, async (tx) => {
    await tx.query('update registry.schema_release set is_current = false');
    await tx.query(
      `insert into registry.schema_release (version, ontology_digest, is_current)
       values ('9.9.9-planted', $1, true)`,
      [PLANTED],
    );
  });
}

async function restoreSeed(): Promise<void> {
  await withTransaction(h.adminPool, async (tx) => {
    await tx.query(`delete from registry.schema_release where version = '9.9.9-planted'`);
    await tx.query('update registry.schema_release set is_current = true where version = $1', [
      original,
    ]);
  });
}

beforeAll(async () => {
  h = await startHarness();
  original = (
    await withTransaction(h.adminPool, (tx) =>
      tx.one<{ version: string }>('select version from registry.schema_release where is_current'),
    )
  ).version;
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

describe('the seeded ontology at API startup', () => {
  it('serves under dogfood when the database holds this release ontology', async () => {
    const app = await buildApp(dogfood());
    await app.ready();
    await app.close();
  });

  describe('with a database seeded from another ontology', () => {
    beforeAll(plantOtherSeed);
    afterAll(restoreSeed);

    it.each([
      ['the dogfood profile', () => dogfood()],
      ['production', () => dogfood({ environment: 'production', tlsTerminatedUpstream: true })],
      ['staging, even under the development profile', () => config({ environment: 'staging' })],
    ])('refuses to become ready under %s', async (_label, build) => {
      const app = await buildApp(build());
      await expect(app.ready()).rejects.toThrow(
        /refusing to serve: .*9\.9\.9-planted was seeded from ontology cccccccccccc/,
      );
      await app.close().catch(() => undefined);
    });

    it('warns, and serves, under the development profile', async () => {
      const app = await buildApp(config());
      const warn = vi.spyOn(app.log, 'warn');
      await app.ready();
      expect(warn.mock.calls.map((call) => String(call.at(-1)))).toContainEqual(
        expect.stringMatching(/ontology digest: .*cccccccccccc/),
      );
      await app.close();
    });
  });

  it('refuses under dogfood when the release cannot say which ontology it carries', async () => {
    // Loadable as projections (the document routes accept any string), but no digest to compare.
    const directory = mkdtempSync(join(tmpdir(), 'kf-projections-'));
    const artifact = join(directory, 'knowledge-fabric.projections.json');
    writeFileSync(
      artifact,
      JSON.stringify({
        'x-generated-from': { source_digest: 'unknown' },
        projection_definitions: [],
      }),
    );
    try {
      const app = await buildApp(dogfood({ projectionsArtifact: artifact }));
      await expect(app.ready()).rejects.toThrow(/cannot determine this release's ontology digest/);
      await app.close().catch(() => undefined);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
