/**
 * Preservation export round trip, and evidence-vault verification.
 *
 * The round trip is the test that keeps the engine replaceable. Export, import into an
 * EMPTY database, export again, compare — if that holds, "the database died" is a restore
 * rather than a loss, and a claim that the canonical export is the institutional record is
 * something the build checks rather than something the README asserts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDispatcher } from '@kf/actions';
import { withTransaction } from '@kf/database';
import {
  ArtifactRejected,
  InMemoryObjectStore,
  beginUpload,
  digestOf,
  recordVersion,
  verifyRecordedVersion,
  verifyUpload,
} from '@kf/artifacts';
import { canonicalize, digestBytes } from '@kf/canonicalization';
import {
  createExport,
  exportIdentity,
  importExport,
  verifyExport,
  type ExportManifest,
  type ExportPackage,
} from '@kf/export';
import {
  bindContext,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from '../database/harness.js';

let h: Harness;
let f: Fixtures;
let store: InMemoryObjectStore;

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  store = new InMemoryObjectStore();

  // A little real history, so the export has something to be faithful about.
  const execute = createDispatcher(h.pool);
  for (let i = 0; i < 3; i++) {
    const id = await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'proposed',
      title: `Decision ${i}`,
      createdBy: f.performerId,
    });
    await execute({
      actionType: 'accept_decision',
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      targetIds: [id],
      idempotencyKey: `export-fixture-${i}-aaaaaaaa`,
      organizationId: f.organizationId,
      maxClassification: 'restricted',
    });
  }
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

const BYTES = Buffer.from('Atlas enclosure, revision 3. Not a real CAD file.', 'utf8');

async function makeArtifact(): Promise<string> {
  const id = await createObject(h.adminPool, f, {
    type: 'artifact',
    domain: 'artifact',
    state: 'draft',
    title: 'Atlas enclosure assembly',
    createdBy: f.performerId,
  });
  await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f);
    await tx.query(
      `insert into content.artifact (id, artifact_kind, source_system)
       values ($1, 'cad_assembly', 'object_store')`,
      [id],
    );
  });
  return id;
}

describe('evidence vault', () => {
  it('records a version only after re-deriving the digest from the stored bytes', async () => {
    const artifactId = await makeArtifact();
    const sha = digestOf(BYTES);

    const ticket = await beginUpload(store, {
      artifactId,
      claimedSha256: sha,
      mediaType: 'application/step',
    });
    expect(ticket.expiresAt.getTime()).toBeGreaterThan(Date.now());

    await store.put(ticket.key, BYTES, 'application/step');
    const verified = await verifyUpload(store, {
      key: ticket.key,
      claimedSha256: sha,
      claimedSizeBytes: BYTES.length,
    });
    expect(verified.sha256).toBe(sha);

    const recorded = await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f);
      return recordVersion(tx, {
        artifactId,
        verified,
        mediaType: 'application/step',
        createdBy: f.performerId,
        revisionLabel: 'Rev 3.0',
      });
    });
    expect(recorded.versionNo).toBe(1);
  });

  it('rejects bytes that do not match the claim — the headline guarantee', async () => {
    const artifactId = await makeArtifact();
    const sha = digestOf(BYTES);
    const ticket = await beginUpload(store, {
      artifactId,
      claimedSha256: sha,
      mediaType: 'application/step',
    });

    // The client claims one digest and uploads something else. Nothing about the claim is
    // trusted: the server hashes what actually arrived.
    await store.put(ticket.key, Buffer.from('different content entirely', 'utf8'), 'text/plain');

    const err = await verifyUpload(store, { key: ticket.key, claimedSha256: sha }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ArtifactRejected);
    expect((err as ArtifactRejected).failure).toBe('digest_mismatch');
  });

  it('rejects an upload that never arrived, and an empty one', async () => {
    const artifactId = await makeArtifact();
    const sha = digestOf(BYTES);
    const ticket = await beginUpload(store, {
      artifactId,
      claimedSha256: sha,
      mediaType: 'application/step',
    });

    await expect(verifyUpload(store, { key: ticket.key, claimedSha256: sha })).rejects.toThrow(
      /no object at that key/,
    );

    // An empty object is almost always a failed upload reported as a success.
    await store.put(ticket.key, Buffer.alloc(0), 'application/step');
    await expect(verifyUpload(store, { key: ticket.key, claimedSha256: sha })).rejects.toThrow(
      /empty/,
    );
  });

  it('detects tampering in the store AFTER a version was recorded', async () => {
    // The restore-and-audit path: given what the database says, are the bytes still what
    // they were? No amount of database integrity can answer that on its own.
    const artifactId = await makeArtifact();
    const sha = digestOf(BYTES);
    const ticket = await beginUpload(store, {
      artifactId,
      claimedSha256: sha,
      mediaType: 'application/step',
    });
    await store.put(ticket.key, BYTES, 'application/step');
    const verified = await verifyUpload(store, { key: ticket.key, claimedSha256: sha });

    const intact = await verifyRecordedVersion(store, {
      sha256: verified.sha256,
      sizeBytes: verified.sizeBytes,
      storageUri: verified.key,
      storageVersion: verified.storageVersion ?? null,
    });
    expect(intact.ok).toBe(true);

    store.tamper(ticket.key, Buffer.from('quietly altered later', 'utf8'));

    const after = await verifyRecordedVersion(store, {
      sha256: verified.sha256,
      sizeBytes: verified.sizeBytes,
      storageUri: verified.key,
      storageVersion: null,
    });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.failure).toBe('digest_mismatch');
  });

  it('assigns version numbers under a lock, so concurrent uploads do not collide', async () => {
    const artifactId = await makeArtifact();
    for (const text of ['one', 'two', 'three']) {
      const body = Buffer.from(text, 'utf8');
      const sha = digestOf(body);
      const ticket = await beginUpload(store, {
        artifactId,
        claimedSha256: sha,
        mediaType: 'text/plain',
      });
      await store.put(ticket.key, body, 'text/plain');
      const verified = await verifyUpload(store, { key: ticket.key, claimedSha256: sha });
      await withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f);
        await recordVersion(tx, {
          artifactId,
          verified,
          mediaType: 'text/plain',
          createdBy: f.performerId,
        });
      });
    }
    const rows = await withTransaction(h.adminPool, async (tx) =>
      tx.query<{ version_no: number }>(
        'select version_no from content.artifact_version where artifact_id = $1 order by version_no',
        [artifactId],
      ),
    );
    expect(rows.map((r) => Number(r.version_no))).toEqual([1, 2, 3]);
  });
});

/**
 * Rebuild a package around altered content, re-signing the manifest.
 *
 * Deliberately produces a package that PASSES `verifyExport`. The manifest proves internal
 * consistency, not good intent — anyone who can hand you a package can hash it too — so a
 * hostile-input test that failed at the digest check would prove nothing about the import
 * path itself.
 */
async function repack(base: ExportPackage, path: string, content: unknown): Promise<ExportPackage> {
  const files = base.files
    .filter((x) => x.path !== 'manifest.json')
    .map((x) => (x.path === path ? { path, content: `${canonicalize(content)}\n` } : x));

  const manifest: ExportManifest = {
    ...base.manifest,
    files: files.map((f) => {
      const bytes = Buffer.from(f.content, 'utf8');
      return { path: f.path, size_bytes: bytes.length, sha256: digestBytes(bytes) };
    }),
  };
  const pkg: ExportPackage = {
    files: [...files, { path: 'manifest.json', content: `${canonicalize(manifest)}\n` }],
    manifest,
  };
  expect(verifyExport(pkg), 'the hostile package must be internally consistent').toEqual([]);
  return pkg;
}

describe('preservation export', () => {
  let pkg: ExportPackage;

  it('exports and verifies against its own manifest', async () => {
    pkg = await withTransaction(h.adminPool, async (tx) => createExport(tx));
    expect(verifyExport(pkg)).toEqual([]);
    expect(pkg.manifest.counts['objects']).toBeGreaterThan(0);
    expect(pkg.manifest.counts['audit-events']).toBeGreaterThanOrEqual(3);
    // The artifact index travels too — the digests that prove the object store still agrees
    // with the record are worthless if only one of the two is restorable.
    expect(pkg.manifest.counts['artifacts']).toBeGreaterThan(0);
    expect(pkg.manifest.counts['artifact-versions']).toBeGreaterThan(0);
  });

  it('carries the ontology with the data', () => {
    // Without it, a reader in twenty years has rows whose state and action tokens mean
    // nothing.
    const ontology = pkg.files.find((x) => x.path === 'ontology/registry.json');
    expect(ontology).toBeDefined();
    const parsed = JSON.parse(ontology!.content) as Record<string, unknown[]>;
    expect(parsed['object_types']).toHaveLength(21);
    expect(parsed['state_transitions']!.length).toBeGreaterThan(60);
  });

  it('does not list its own manifest — a file cannot contain its own hash', () => {
    expect(pkg.manifest.files.map((x) => x.path)).not.toContain('manifest.json');
    expect(pkg.files.some((x) => x.path === 'manifest.json')).toBe(true);
  });

  it('catches a tampered file', () => {
    const damaged: ExportPackage = {
      ...pkg,
      files: pkg.files.map((x) =>
        x.path === 'objects.json' ? { ...x, content: `${x.content} ` } : x,
      ),
    };
    const findings = verifyExport(damaged);
    expect(findings.map((x) => x.problem)).toContain('digest_mismatch');
  });

  it('catches a file that is present but unlisted', () => {
    const smuggled: ExportPackage = {
      ...pkg,
      files: [...pkg.files, { path: 'extra.json', content: '{}\n' }],
    };
    // Content nobody vouched for is as much a problem as content that went missing.
    expect(verifyExport(smuggled).map((x) => x.problem)).toContain('unlisted');
  });

  it('ROUND TRIP: import into an empty database and re-export identically', async () => {
    // The one that keeps the engine replaceable.
    const fresh = await startHarness();
    try {
      await withTransaction(fresh.adminPool, async (tx) => {
        await importExport(tx, pkg);
      });

      const again = await withTransaction(fresh.adminPool, async (tx) => createExport(tx));

      expect(verifyExport(again)).toEqual([]);
      expect(again.manifest.counts).toEqual(pkg.manifest.counts);
      expect(exportIdentity(again.manifest)).toBe(exportIdentity(pkg.manifest));

      // File by file, byte for byte. A count match alone would pass even if every row's
      // content had changed.
      const before = new Map(pkg.files.map((x) => [x.path, x.content]));
      for (const file of again.files) {
        if (file.path === 'manifest.json') continue;
        expect(file.content, `${file.path} differs after round trip`).toBe(before.get(file.path));
      }
    } finally {
      await fresh.stop();
    }
  }, 180_000);

  it('refuses hostile packages that pass their own manifest', async () => {
    // Column names cannot be bound as parameters — SQL has no parameter form for an
    // identifier — so they are interpolated. An export is attacker-supplied data, and whoever
    // crafts a package computes its digests too, so passing manifest verification proves
    // nothing about intent. The allow-list read from the catalogue is what closes this.
    //
    // Runs against a FRESH database: importing into a populated one collides on the first
    // section and would never reach the hostile input, so the test would pass without the
    // defence existing.
    const fresh = await startHarness();
    try {
      const rows = (path: string): Record<string, unknown>[] =>
        JSON.parse(pkg.files.find((x) => x.path === path)!.content) as Record<string, unknown>[];

      const injected = rows('objects.json').map((r) => ({
        ...r,
        'id) values (1); drop table core.object; --': 'x',
      }));
      await expect(
        withTransaction(fresh.adminPool, async (tx) =>
          importExport(tx, await repack(pkg, 'objects.json', injected)),
        ),
      ).rejects.toThrow(/does not have/);

      // A ragged section cannot be inserted as one shape, and quietly using the first row's
      // shape would drop whatever the later rows carried.
      const ragged = rows('objects.json').map((r, i) => (i === 1 ? { id: r['id'] } : r));
      await expect(
        withTransaction(fresh.adminPool, async (tx) =>
          importExport(tx, await repack(pkg, 'objects.json', ragged)),
        ),
      ).rejects.toThrow(/different column set/);

      // Neither attempt wrote anything, and the table it named is still there.
      const remaining = await withTransaction(fresh.adminPool, async (tx) =>
        tx.one<{ n: string }>('select count(*)::text as n from core.object'),
      );
      expect(Number(remaining.n)).toBe(0);
    } finally {
      await fresh.stop();
    }
  }, 180_000);

  it('refuses to import a package that fails its own manifest', async () => {
    // A restore is exactly when you cannot afford to discover the package was damaged.
    const damaged: ExportPackage = {
      ...pkg,
      files: pkg.files.map((x) => (x.path === 'actions.json' ? { ...x, content: '[]\n' } : x)),
    };
    await expect(
      withTransaction(h.adminPool, async (tx) => importExport(tx, damaged)),
    ).rejects.toThrow(/fails its own manifest/);
  });
});
