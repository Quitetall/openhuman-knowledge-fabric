/**
 * Preservation export round trip, and evidence-vault verification.
 *
 * The round trip is the test that keeps the engine replaceable. Export, import into an
 * EMPTY database, export again, compare — if that holds, "the database died" is a restore
 * rather than a loss, and a claim that the canonical export is the institutional record is
 * something the build checks rather than something the README asserts.
 */

import { createHash, generateKeyPairSync } from 'node:crypto';
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
  type ObjectStore,
} from '@kf/artifacts';
import {
  auditChainDigest,
  canonicalize,
  compareCanonicalText,
  digestBytes,
} from '@kf/canonicalization';
import {
  createExport,
  EXPORT_MANIFEST_SIGNATURE_PATH,
  exportIdentity,
  importExport,
  PRESERVATION_IMPORT_TARGETS,
  recomputeDatabaseSnapshotDigest,
  signExportPackage,
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

const PRESERVATION_KEY_ID = 'round-trip-preservation-key';
const PRESERVATION_KEY = generateKeyPairSync('ed25519');
const PRESERVATION_VERIFICATION = {
  trustedManifestKeys: new Map([[PRESERVATION_KEY_ID, PRESERVATION_KEY.publicKey]]),
};
const PRECISE_ACTION_ID = '019f0000-0000-7000-8000-00000000f001';
const PRECISE_JSON_INTEGER = '900719925474099312345678901234567890';
const PRECISE_RECORDED_AT = '2026-08-15T12:34:56.123456Z';
const PRECISE_EFFECTIVE_AT = '2026-08-15T12:34:56.123Z';

function authenticate(pkg: ExportPackage): ExportPackage {
  return signExportPackage(pkg, {
    keyId: PRESERVATION_KEY_ID,
    privateKey: PRESERVATION_KEY.privateKey,
  });
}

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  store = new InMemoryObjectStore();

  // A little real history, so the export has something to be faithful about.
  const execute = createDispatcher(h.pool);
  let preciseTargetId = '';
  for (let i = 0; i < 3; i++) {
    const id = await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'proposed',
      title: `Decision ${i}`,
      createdBy: f.performerId,
    });
    if (i === 0) preciseTargetId = id;
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

  await withTransaction(h.adminPool, async (tx) => {
    const actionType = await tx.one<{ id: string }>(
      'select id from registry.action_type order by id limit 1',
    );
    await tx.query(
      `insert into core.action
         (id, organization_id, request_digest, action_type, actor_id, acting_role_id,
          target_ids, parameters, preconditions, idempotency_key, recorded_at, effective_at,
          result_status, result)
       values ($1, $2, $3, $4, $5, $6, $7::uuid[], $8::jsonb, '{}'::jsonb, $9, $10, $11,
               'applied', '{}'::jsonb)`,
      [
        PRECISE_ACTION_ID,
        f.organizationId,
        'b'.repeat(64),
        actionType.id,
        f.performerId,
        f.performerRoleId,
        [preciseTargetId],
        `{"precise":${PRECISE_JSON_INTEGER}}`,
        'precision-export-fixture-aaaaaaaa',
        PRECISE_RECORDED_AT,
        PRECISE_EFFECTIVE_AT,
      ],
    );
    const head = await tx.one<{ digest: string }>(
      'select digest from core.audit_event order by seq desc limit 1',
    );
    const auditDigest = auditChainDigest(head.digest, {
      action_id: PRECISE_ACTION_ID,
      action_type: actionType.id,
      actor_id: f.performerId,
      acting_role_id: f.performerRoleId,
      object_ids: [preciseTargetId],
      effective_at: PRECISE_EFFECTIVE_AT,
      before_digest: null,
      after_digest: null,
    });
    await tx.query(
      `insert into core.audit_event
         (action_id, actor_id, acting_role_id, action_type, object_id, recorded_at,
          effective_at, before_digest, after_digest, prev_digest, digest)
       values ($1,$2,$3,$4,$5,$6,$7,null,null,$8,$9)`,
      [
        PRECISE_ACTION_ID,
        f.performerId,
        f.performerRoleId,
        actionType.id,
        preciseTargetId,
        PRECISE_RECORDED_AT,
        PRECISE_EFFECTIVE_AT,
        head.digest,
        auditDigest,
      ],
    );
  });
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
      storageVersion: verified.storageVersion,
    });
    expect(intact.ok).toBe(true);

    store.tamper(ticket.key, Buffer.alloc(BYTES.length, 'x'));

    const sameSizeTamper = await verifyRecordedVersion(store, {
      sha256: verified.sha256,
      sizeBytes: verified.sizeBytes,
      storageUri: verified.key,
      storageVersion: verified.storageVersion,
    });
    expect(sameSizeTamper.ok).toBe(false);
    if (!sameSizeTamper.ok) expect(sameSizeTamper.failure).toBe('digest_mismatch');

    store.tamper(ticket.key, Buffer.from('quietly altered later', 'utf8'));
    const changedSizeTamper = await verifyRecordedVersion(store, {
      sha256: verified.sha256,
      sizeBytes: verified.sizeBytes,
      storageUri: verified.key,
      storageVersion: verified.storageVersion,
    });
    expect(changedSizeTamper.ok).toBe(false);
    if (!changedSizeTamper.ok) expect(changedSizeTamper.failure).toBe('size_mismatch');
  });

  it('verifies a pinned historical version even when the current key is absent', async () => {
    const bytes = Buffer.from('historical immutable bytes');
    const sha256 = digestOf(bytes);
    const versionId = 'immutable-v1';
    const historicalOnlyStore = {
      presignPut: async () => 'unused',
      head: async (_key: string, requestedVersion?: string) =>
        requestedVersion === versionId
          ? { key: 'historical', sizeBytes: bytes.length, versionId }
          : undefined,
      read: async (_key: string, requestedVersion?: string) => {
        if (requestedVersion !== versionId) throw new Error('version not found');
        return Buffer.from(bytes);
      },
      putIfAbsent: async () => {
        throw new Error('unused');
      },
      put: async () => {
        throw new Error('unused');
      },
    } satisfies ObjectStore;

    await expect(
      verifyRecordedVersion(historicalOnlyStore, {
        sha256,
        sizeBytes: bytes.length,
        storageUri: 'historical',
        storageVersion: versionId,
      }),
    ).resolves.toEqual({ ok: true });
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
    .filter((x) => x.path !== 'manifest.json' && x.path !== EXPORT_MANIFEST_SIGNATURE_PATH)
    .map((x) => (x.path === path ? { path, content: `${canonicalize(content)}\n` } : x));

  const manifest: ExportManifest = {
    ...base.manifest,
    database_snapshot_sha256: recomputeDatabaseSnapshotDigest(files),
    files: files.map((f) => {
      const bytes = Buffer.from(f.content, 'utf8');
      return { path: f.path, size_bytes: bytes.length, sha256: digestBytes(bytes) };
    }),
  };
  const pkg = authenticate({
    files: [...files, { path: 'manifest.json', content: `${canonicalize(manifest)}\n` }],
    manifest,
  });
  expect(
    verifyExport(pkg, PRESERVATION_VERIFICATION),
    'the hostile package must be internally consistent and signed by the trusted test authority',
  ).toEqual([]);
  return pkg;
}

function asLegacyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(asLegacyValue);
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    if (
      Object.keys(row).length === 2 &&
      typeof row['$kf_type'] === 'string' &&
      typeof row['text'] === 'string'
    ) {
      if (row['$kf_type'] === 'postgres.timestamptz') return row['text'];
      if (row['$kf_type'] === 'postgres.json' || row['$kf_type'] === 'postgres.jsonb') {
        return JSON.parse(row['text']);
      }
    }
    return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, asLegacyValue(item)]));
  }
  return value;
}

const LEGACY_V1_SECTIONS = [
  'objects',
  'relations',
  'actions',
  'approvals',
  'snapshots',
  'audit-events',
  'audit-checkpoints',
  'artifacts',
  'artifact-versions',
  'artifact-relationships',
  'external-identifiers',
  'organizations',
  'people',
  'engagements',
  'role-assignments',
] as const;

/** Reproduce exact format-1 section/column shape for an importer compatibility fixture. */
function asLegacyV1(base: ExportPackage): ExportPackage {
  const wanted = new Set<string>([
    'ontology/registry.json',
    ...LEGACY_V1_SECTIONS.map((name) => `${name}.json`),
  ]);
  const files = base.files
    .filter((entry) => wanted.has(entry.path))
    .map((entry) => {
      const rows = JSON.parse(entry.content) as Record<string, unknown>[];
      if (entry.path === 'ontology/registry.json') {
        return { path: entry.path, content: `${canonicalize(asLegacyValue(rows))}\n` };
      }
      const legacyRows = asLegacyValue(rows) as Record<string, unknown>[];
      if (entry.path === 'actions.json') {
        return {
          path: entry.path,
          content: `${canonicalize(
            legacyRows.map(
              ({ organization_id: _organizationId, request_digest: _requestDigest, ...row }) => row,
            ),
          )}\n`,
        };
      }
      if (entry.path !== 'audit-checkpoints.json') {
        return { path: entry.path, content: `${canonicalize(legacyRows)}\n` };
      }
      return {
        path: entry.path,
        content: `${canonicalize(legacyRows.map(({ format_version: _formatVersion, ...row }) => row))}\n`,
      };
    })
    .sort((left, right) => compareCanonicalText(left.path, right.path));
  const counts = Object.fromEntries(
    LEGACY_V1_SECTIONS.map((name) => [name, base.manifest.counts[name] ?? 0]),
  );
  const { database_snapshot_sha256: _databaseSnapshot, ...legacyManifest } = base.manifest;
  const manifest: ExportManifest = {
    ...legacyManifest,
    format_version: '1',
    counts,
    files: files.map((entry) => {
      const bytes = Buffer.from(entry.content, 'utf8');
      return { path: entry.path, size_bytes: bytes.length, sha256: digestBytes(bytes) };
    }),
  };
  return {
    files: [...files, { path: 'manifest.json', content: `${canonicalize(manifest)}\n` }],
    manifest,
  };
}

describe('preservation export', () => {
  let pkg: ExportPackage;

  it('exports and verifies against its own manifest', async () => {
    pkg = authenticate(await withTransaction(h.adminPool, async (tx) => createExport(tx)));
    expect(verifyExport(pkg, PRESERVATION_VERIFICATION)).toEqual([]);
    expect(pkg.manifest.counts['objects']).toBeGreaterThan(0);
    expect(pkg.manifest.counts['audit-events']).toBeGreaterThanOrEqual(3);
    // The artifact index travels too — the digests that prove the object store still agrees
    // with the record are worthless if only one of the two is restorable.
    expect(pkg.manifest.counts['artifacts']).toBeGreaterThan(0);
    expect(pkg.manifest.counts['artifact-versions']).toBeGreaterThan(0);

    const actions = JSON.parse(
      pkg.files.find((entry) => entry.path === 'actions.json')!.content,
    ) as Record<string, unknown>[];
    const precise = actions.find((row) => row['id'] === PRECISE_ACTION_ID)!;
    expect(precise['recorded_at']).toEqual({
      $kf_type: 'postgres.timestamptz',
      text: PRECISE_RECORDED_AT,
    });
    expect(precise['parameters']).toEqual({
      $kf_type: 'postgres.jsonb',
      text: `{"precise": ${PRECISE_JSON_INTEGER}}`,
    });

    const auditRows = JSON.parse(
      pkg.files.find((entry) => entry.path === 'audit-events.json')!.content,
    ) as Record<string, unknown>[];
    expect(pkg.manifest.audit_from_seq).toBe(auditRows[0]?.['seq']);
    expect(pkg.manifest.audit_to_seq).toBe(auditRows[auditRows.length - 1]?.['seq']);
    expect(typeof pkg.manifest.audit_from_seq).toBe('string');
    expect(pkg.manifest.database_snapshot_sha256).toBe(recomputeDatabaseSnapshotDigest(pkg.files));
  });

  it('carries the ontology with the data — all of it', async () => {
    // Without it, a reader in twenty years has rows whose state and action tokens mean
    // nothing.
    //
    // Counted against the registry rather than against a literal. A number here would have
    // to be edited every time the ontology grew, and an assertion edited to make it pass is
    // not an assertion — this one fails if the export drops a single type.
    const ontology = pkg.files.find((x) => x.path === 'ontology/registry.json');
    expect(ontology).toBeDefined();
    const parsed = JSON.parse(ontology!.content) as Record<string, unknown[]>;

    const registry = await withTransaction(h.adminPool, async (tx) =>
      tx.one<{ types: string; transitions: string; actions: string }>(
        `select (select count(*) from registry.object_type)::text as types,
                (select count(*) from registry.state_transition)::text as transitions,
                (select count(*) from registry.action_type)::text as actions`,
      ),
    );
    expect(parsed['object_types']).toHaveLength(Number(registry.types));
    expect(parsed['state_transitions']).toHaveLength(Number(registry.transitions));
    expect(parsed['action_types']).toHaveLength(Number(registry.actions));
    // And it is not vacuously empty.
    expect(Number(registry.types)).toBeGreaterThan(20);
  });

  it('imports a strict PostgreSQL snapshot and keeps one repeatable-read, read-only view', async () => {
    const anchor = await h.adminPool.connect();
    const roleId = 'snapshot_visibility_probe';
    try {
      await anchor.query('begin isolation level repeatable read, read only');
      const tokenResult = await anchor.query<{ token: string }>(
        'select pg_export_snapshot() as token',
      );
      const token = tokenResult.rows[0]!.token;

      await withTransaction(h.adminPool, async (tx) => {
        await tx.query('insert into org.role (id, description) values ($1, $2)', [
          roleId,
          'Committed after exported snapshot',
        ]);
      });

      const strict = await withTransaction(h.adminPool, async (tx) => {
        const exported = await createExport(tx, { strictSnapshotToken: token });
        const settings = await tx.one<{ isolation: string; read_only: string }>(
          `select current_setting('transaction_isolation') as isolation,
                  current_setting('transaction_read_only') as read_only`,
        );
        return { exported, settings };
      });
      const current = await withTransaction(h.adminPool, (tx) => createExport(tx));
      const roleIds = (exported: ExportPackage): string[] =>
        (
          JSON.parse(exported.files.find((entry) => entry.path === 'roles.json')!.content) as {
            id: string;
          }[]
        ).map((row) => row.id);

      expect(strict.settings).toEqual({ isolation: 'repeatable read', read_only: 'on' });
      expect(roleIds(strict.exported)).not.toContain(roleId);
      expect(roleIds(current)).toContain(roleId);
    } finally {
      await anchor.query('rollback').catch(() => undefined);
      anchor.release();
      await withTransaction(h.adminPool, async (tx) => {
        await tx.query('delete from org.role where id = $1', [roleId]);
      });
    }
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
    const findings = verifyExport(damaged, PRESERVATION_VERIFICATION);
    expect(findings.map((x) => x.problem)).toContain('digest_mismatch');
  });

  it('catches a file that is present but unlisted', () => {
    const smuggled: ExportPackage = {
      ...pkg,
      files: [...pkg.files, { path: 'extra.json', content: '{}\n' }],
    };
    // Content nobody vouched for is as much a problem as content that went missing.
    expect(verifyExport(smuggled, PRESERVATION_VERIFICATION).map((x) => x.problem)).toContain(
      'unlisted',
    );
  });

  it('ROUND TRIP: import into an empty database and re-export identically', async () => {
    // The one that keeps the engine replaceable.
    const fresh = await startHarness();
    try {
      await withTransaction(fresh.adminPool, async (tx) => {
        await importExport(tx, pkg, PRESERVATION_VERIFICATION);
      });

      const precise = await withTransaction(fresh.adminPool, (tx) =>
        tx.one<{ parameters: string; recorded_at: string }>(
          `select parameters::text as parameters,
                  to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                    as recorded_at
             from core.action where id = $1`,
          [PRECISE_ACTION_ID],
        ),
      );
      expect(precise).toEqual({
        parameters: `{"precise": ${PRECISE_JSON_INTEGER}}`,
        recorded_at: PRECISE_RECORDED_AT,
      });

      const again = authenticate(
        await withTransaction(fresh.adminPool, async (tx) => createExport(tx)),
      );

      expect(verifyExport(again, PRESERVATION_VERIFICATION)).toEqual([]);
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

  it('resumes an empty restored audit sequence at its first value', async () => {
    const emptySource = await startHarness();
    const emptyTarget = await startHarness();
    try {
      const empty = authenticate(
        await withTransaction(emptySource.adminPool, async (tx) => createExport(tx)),
      );
      expect(empty.manifest.counts['actions']).toBe(0);
      expect(empty.manifest.counts['audit-events']).toBe(0);

      await withTransaction(emptyTarget.adminPool, async (tx) => {
        await importExport(tx, empty, PRESERVATION_VERIFICATION);
        const next = await tx.one<{ seq: string }>(
          `select nextval(pg_get_serial_sequence('core.audit_event', 'seq'))::text as seq`,
        );
        expect(next.seq).toBe('1');
      });
    } finally {
      await emptyTarget.stop();
      await emptySource.stop();
    }
  }, 180_000);

  it('restores original format-1 archives through an explicit fixed-point upconverter', async () => {
    const legacy = asLegacyV1(pkg);
    expect(legacy.manifest.format_version).toBe('1');
    const legacyVerification = {
      allowUnsignedLegacyV1: true,
      onWarning: () => undefined,
    };
    expect(verifyExport(legacy, legacyVerification)).toEqual([]);

    const fresh = await startHarness();
    try {
      await withTransaction(fresh.adminPool, (tx) => importExport(tx, legacy, legacyVerification));
      const restoredV2 = authenticate(
        await withTransaction(fresh.adminPool, (tx) => createExport(tx)),
      );
      expect(restoredV2.manifest.counts['legacy-action-provenance']).toBe(
        legacy.manifest.counts['actions'],
      );
      expect(
        JSON.parse(
          restoredV2.files.find((entry) => entry.path === 'legacy-action-provenance.json')!.content,
        ),
      ).toEqual(
        expect.arrayContaining(
          (
            JSON.parse(
              legacy.files.find((entry) => entry.path === 'actions.json')!.content,
            ) as Record<string, unknown>[]
          ).map((action) => ({
            action_id: action['id'],
            migration_version: '20260814001900',
          })),
        ),
      );
      const downconverted = asLegacyV1(restoredV2);
      expect(downconverted.manifest).toEqual(legacy.manifest);
      expect(new Map(downconverted.files.map((entry) => [entry.path, entry.content]))).toEqual(
        new Map(legacy.files.map((entry) => [entry.path, entry.content])),
      );
    } finally {
      await fresh.stop();
    }
  }, 180_000);

  it('refuses unknown preservation formats instead of guessing missing sections', async () => {
    const futureManifest = { ...pkg.manifest, format_version: '999' };
    const future: ExportPackage = {
      manifest: futureManifest,
      files: pkg.files
        .filter((entry) => entry.path !== EXPORT_MANIFEST_SIGNATURE_PATH)
        .map((entry) =>
          entry.path === 'manifest.json'
            ? { ...entry, content: `${canonicalize(futureManifest)}\n` }
            : entry,
        ),
    };
    const fresh = await startHarness();
    try {
      await expect(
        withTransaction(fresh.adminPool, (tx) =>
          importExport(tx, future, PRESERVATION_VERIFICATION),
        ),
      ).rejects.toThrow(/unsupported export format version/);
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
          importExport(tx, await repack(pkg, 'objects.json', injected), PRESERVATION_VERIFICATION),
        ),
      ).rejects.toThrow(/does not have/);

      // A ragged section cannot be inserted as one shape, and quietly using the first row's
      // shape would drop whatever the later rows carried.
      const ragged = rows('objects.json').map((r, i) => (i === 1 ? { id: r['id'] } : r));
      await expect(
        withTransaction(fresh.adminPool, async (tx) =>
          importExport(tx, await repack(pkg, 'objects.json', ragged), PRESERVATION_VERIFICATION),
        ),
      ).rejects.toThrow(/different column set/);

      const orphanAuditEvent = rows('audit-events.json').map((row, index) =>
        index === 0 ? { ...row, action_id: '019f0000-0000-7000-8000-00000000dead' } : row,
      );
      await expect(
        withTransaction(fresh.adminPool, async (tx) =>
          importExport(
            tx,
            await repack(pkg, 'audit-events.json', orphanAuditEvent),
            PRESERVATION_VERIFICATION,
          ),
        ),
      ).rejects.toThrow(/foreign key constraint/);

      const nullTarget = rows('actions.json').map((row, index) =>
        index === 0 ? { ...row, target_ids: [null] } : row,
      );
      await expect(
        withTransaction(fresh.adminPool, async (tx) =>
          importExport(
            tx,
            await repack(pkg, 'actions.json', nullTarget),
            PRESERVATION_VERIFICATION,
          ),
        ),
      ).rejects.toThrow(/action_target_ids_canonical/);

      const reservedWithoutProvenance = rows('actions.json').map((row, index) => {
        if (index !== 0) return row;
        const actionId = row['id'];
        if (typeof actionId !== 'string') throw new Error('fixture action id is not text');
        return {
          ...row,
          request_digest: createHash('sha256')
            .update(`kf-action-legacy-v1:${actionId}`, 'utf8')
            .digest('hex'),
        };
      });
      await expect(
        withTransaction(fresh.adminPool, async (tx) =>
          importExport(
            tx,
            await repack(pkg, 'actions.json', reservedWithoutProvenance),
            PRESERVATION_VERIFICATION,
          ),
        ),
      ).rejects.toThrow(/legacy action provenance mismatch/);

      const microsecondAction = rows('actions.json').map((row, index) => {
        if (index !== 0) return row;
        return {
          ...row,
          effective_at: {
            $kf_type: 'postgres.timestamptz',
            text: '2026-08-15T12:34:56.123456Z',
          },
        };
      });
      await expect(
        withTransaction(fresh.adminPool, async (tx) =>
          importExport(
            tx,
            await repack(pkg, 'actions.json', microsecondAction),
            PRESERVATION_VERIFICATION,
          ),
        ),
      ).rejects.toThrow(/action_effective_at_canonical_wire/);

      const disconnectedAudit = rows('audit-events.json').map((row, index) => {
        if (index !== 0) return row;
        const action = rows('actions.json').find(
          (candidate) => candidate['id'] === row['action_id'],
        );
        if (action === undefined) throw new Error('audit fixture has no action');
        const timestamp = row['effective_at'];
        if (
          timestamp === null ||
          typeof timestamp !== 'object' ||
          !('text' in timestamp) ||
          typeof timestamp.text !== 'string'
        ) {
          throw new Error('audit fixture timestamp is not lossless text');
        }
        const prevDigest = 'f'.repeat(64);
        return {
          ...row,
          prev_digest: prevDigest,
          digest: auditChainDigest(prevDigest, {
            action_id: row['action_id'] as string,
            action_type: row['action_type'] as string,
            actor_id: row['actor_id'] as string,
            acting_role_id: row['acting_role_id'] as string,
            object_ids: action['target_ids'] as string[],
            effective_at: timestamp.text.replace(/(\.\d{3})\d{3}Z$/, '$1Z'),
            before_digest: row['before_digest'] as string | null,
            after_digest: row['after_digest'] as string | null,
          }),
        };
      });
      await expect(
        withTransaction(fresh.adminPool, async (tx) =>
          importExport(
            tx,
            await repack(pkg, 'audit-events.json', disconnectedAudit),
            PRESERVATION_VERIFICATION,
          ),
        ),
      ).rejects.toThrow(/audit chain predecessor mismatch/);

      const duplicatedReceipt = rows('audit-events.json').map((row, index, all) =>
        index === 0 && all.length > 1 ? { ...row, action_id: all[1]!['action_id'] } : row,
      );
      await expect(
        withTransaction(fresh.adminPool, async (tx) =>
          importExport(
            tx,
            await repack(pkg, 'audit-events.json', duplicatedReceipt),
            PRESERVATION_VERIFICATION,
          ),
        ),
      ).rejects.toThrow(/audit receipts; expected exactly one/);

      const seededRolesBefore = await withTransaction(fresh.adminPool, (tx) =>
        tx.one<{ count: number }>('select count(*)::integer as count from org.role'),
      );
      // Even a broken caller that swallows the import error cannot commit seed deletion or
      // disabled-trigger DDL. importExport poisons its transaction on every failure.
      await withTransaction(fresh.adminPool, async (tx) => {
        await importExport(
          tx,
          await repack(pkg, 'objects.json', injected),
          PRESERVATION_VERIFICATION,
        ).catch(() => undefined);
      });
      const seededRolesAfter = await withTransaction(fresh.adminPool, (tx) =>
        tx.one<{ count: number }>('select count(*)::integer as count from org.role'),
      );
      expect(seededRolesAfter).toEqual(seededRolesBefore);

      // Neither attempt wrote anything, and the table it named is still there.
      const remaining = await withTransaction(fresh.adminPool, async (tx) =>
        tx.one<{ n: string }>('select count(*)::text as n from core.object'),
      );
      expect(Number(remaining.n)).toBe(0);

      const triggerState = await withTransaction(fresh.adminPool, (tx) =>
        tx.one<{ total: number; disabled: number }>(
          `select count(*)::integer as total,
                  count(*) filter (where t.tgenabled <> 'O')::integer as disabled
             from pg_trigger t
             join pg_class c on c.oid = t.tgrelid
             join pg_namespace n on n.oid = c.relnamespace
            where not t.tgisinternal
              and n.nspname || '.' || c.relname = any($1::text[])`,
          [[...new Set(Object.values(PRESERVATION_IMPORT_TARGETS))]],
        ),
      );
      expect(triggerState.total).toBeGreaterThan(0);
      expect(triggerState.disabled).toBe(0);
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
      withTransaction(h.adminPool, async (tx) =>
        importExport(tx, damaged, PRESERVATION_VERIFICATION),
      ),
    ).rejects.toThrow(/fails its own manifest/);
  });
});
