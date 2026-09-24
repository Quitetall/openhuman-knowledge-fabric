/**
 * An export cut before 20260925130100 still restores (KF preservation: old archives are the
 * backups).
 *
 * That migration moved `work.deliverable` from `deliverable_kind`/`definition_of_done` to the
 * ontology's fields and kept both old values in `work.deliverable_retired_attribute`. An archive
 * written before it names the old columns and has no retired-attributes section. The importer
 * moves each old row exactly as the migration did; this test proves it by cutting an archive in
 * the old shape from a current one, restoring it, and exporting again: every file must come back
 * byte for byte, the retirement stamp excepted (it is when the restore retired the values).
 */

import { randomUUID } from 'node:crypto';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryObjectStore } from '@kf/artifacts';
import { canonicalize, digestBytes } from '@kf/canonicalization';
import { withTransaction } from '@kf/database';
import { createDocumentActionAtoms } from '@kf/documents';
import {
  createExport,
  EXPORT_MANIFEST_SIGNATURE_PATH,
  importExport,
  recomputeDatabaseSnapshotDigest,
  signExportPackage,
  verifyExport,
  type ExportManifest,
  type ExportPackage,
} from '@kf/export';
import { createFabricDispatcher } from '@kf/orchestrator';
import {
  bindContext,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from '../database/harness.js';

const KEY_ID = 'deliverable-upconversion-key';
const KEY = generateKeyPairSync('ed25519');
const VERIFICATION = { trustedManifestKeys: new Map([[KEY_ID, KEY.publicKey]]) };

const RETIRED_SECTION = 'deliverable-retired-attributes';

let h: Harness;
let f: Fixtures;
let pkg: ExportPackage;
const deliverables: { id: string; kind: string; done: string }[] = [];

function sign(p: ExportPackage): ExportPackage {
  return signExportPackage(p, { keyId: KEY_ID, privateKey: KEY.privateKey });
}

type JsonRow = Record<string, unknown>;

function rowsOf(p: ExportPackage, name: string): JsonRow[] {
  return JSON.parse(p.files.find((file) => file.path === `${name}.json`)!.content) as JsonRow[];
}

/** Rewrite the package's files (a null content removes one) and sign it again. */
function repack(base: ExportPackage, changes: ReadonlyMap<string, unknown>): ExportPackage {
  const files = base.files
    .filter((x) => x.path !== 'manifest.json' && x.path !== EXPORT_MANIFEST_SIGNATURE_PATH)
    .filter((x) => !(changes.has(x.path) && changes.get(x.path) === null))
    .map((x) =>
      changes.has(x.path) ? { path: x.path, content: `${canonicalize(changes.get(x.path))}\n` } : x,
    );
  const counts = Object.fromEntries(
    Object.entries(base.manifest.counts).filter(
      ([name]) => !(changes.has(`${name}.json`) && changes.get(`${name}.json`) === null),
    ),
  );
  const manifest: ExportManifest = {
    ...base.manifest,
    counts,
    // The identity an exporter of the archive's day computed: over the sections it wrote.
    database_snapshot_sha256: recomputeDatabaseSnapshotDigest(
      files,
      new Set(
        Object.keys(base.manifest.counts)
          .concat(RETIRED_SECTION)
          .filter((name) => !files.some((file) => file.path === `${name}.json`)),
      ),
    ),
    files: files.map((file) => {
      const bytes = Buffer.from(file.content, 'utf8');
      return { path: file.path, size_bytes: bytes.length, sha256: digestBytes(bytes) };
    }),
  };
  const signed = sign({
    files: [...files, { path: 'manifest.json', content: `${canonicalize(manifest)}\n` }],
    manifest,
  });
  expect(verifyExport(signed, VERIFICATION)).toEqual([]);
  return signed;
}

/** The archive as an exporter before 20260925130100 wrote it. */
function asArchiveBeforeTheMigration(current: ExportPackage): ExportPackage {
  const retired = new Map(
    rowsOf(current, RETIRED_SECTION).map((row) => [row['deliverable_id'], row]),
  );
  const old = rowsOf(current, 'deliverables').map((row) => ({
    // The old section's column list, in its order.
    id: row['id'],
    work_package_id: row['work_package_id'],
    deliverable_kind: retired.get(row['id'])!['deliverable_kind'],
    definition_of_done: retired.get(row['id'])!['definition_of_done'],
  }));
  return repack(
    current,
    new Map<string, unknown>([
      ['deliverables.json', old],
      [`${RETIRED_SECTION}.json`, null],
    ]),
  );
}

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  const execute = createFabricDispatcher(
    h.pool,
    createDocumentActionAtoms({
      store: new InMemoryObjectStore(),
      parser: {
        async parse() {
          return undefined;
        },
      },
    }),
  );
  const act = (actionType: string, payload: Record<string, unknown>) =>
    execute({
      actionType,
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      organizationId: f.organizationId,
      maxClassification: 'restricted',
      targetIds: [],
      idempotencyKey: `upconvert-${actionType}-${randomUUID()}`,
      payload: payload as never,
    });
  const project = (
    await act('create_initiative', {
      title: 'Old deliverables',
      objective: 'An old archive restores.',
      sponsor_id: f.reviewerId,
    })
  ).objectIds[0]!;
  const packageId = (
    await act('create_work_package', {
      title: 'Package',
      project_id: project,
      scope_statement: 'Hand over two reports.',
      acceptance_criterion: 'The reports are accepted.',
    })
  ).objectIds.find((id) => id !== project)!;

  // Each deliverable exactly as 20260925130100 left an old one: the definition of done is the
  // description and the one criterion, and both old values are retired beside it.
  for (const [kind, done] of [
    ['test_report', 'A signed test report for the enclosure.'],
    ['firmware', 'Firmware image v1.2 flashed and verified on three boards.'],
  ] as const) {
    const id = await createObject(h.adminPool, f, {
      type: 'deliverable',
      domain: 'project',
      state: 'planned',
      title: `Deliverable ${kind}`,
      createdBy: f.reviewerId,
    });
    await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f, f.reviewerId);
      await tx.query(
        `insert into work.deliverable (id, work_package_id, description, acceptance_criteria)
         values ($1, $2, $3, array[$3])`,
        [id, packageId, done],
      );
      await tx.query(
        `insert into work.deliverable_retired_attribute
           (deliverable_id, deliverable_kind, definition_of_done)
         values ($1, $2, $3)`,
        [id, kind, done],
      );
    });
    deliverables.push({ id, kind, done });
  }
  pkg = sign(await withTransaction(h.adminPool, (tx) => createExport(tx)));
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe('an archive written before deliverables had their ontology fields', () => {
  it('restores, moving each old row as the migration did, and exports again unchanged', async () => {
    expect(rowsOf(pkg, 'deliverables')).toHaveLength(deliverables.length);
    const old = asArchiveBeforeTheMigration(pkg);
    expect(old.files.some((file) => file.path === `${RETIRED_SECTION}.json`)).toBe(false);
    expect(Object.keys(rowsOf(old, 'deliverables')[0]!)).toEqual([
      'definition_of_done',
      'deliverable_kind',
      'id',
      'work_package_id',
    ]);

    const fresh = await startHarness();
    try {
      await withTransaction(fresh.adminPool, (tx) => importExport(tx, old, VERIFICATION));

      const restored = await withTransaction(fresh.adminPool, (tx) =>
        tx.query<{
          id: string;
          work_order_id: string | null;
          description: string;
          acceptance_criteria: string[];
          due_date: string | null;
          deliverable_kind: string;
          definition_of_done: string;
        }>(
          `select d.id, d.work_order_id, d.description, d.acceptance_criteria, d.due_date,
                  r.deliverable_kind, r.definition_of_done
             from work.deliverable d
             join work.deliverable_retired_attribute r on r.deliverable_id = d.id
            order by d.id`,
        ),
      );
      expect(restored).toEqual(
        [...deliverables]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(({ id, kind, done }) => ({
            id,
            work_order_id: null,
            description: done,
            acceptance_criteria: [done],
            due_date: null,
            deliverable_kind: kind,
            definition_of_done: done,
          })),
      );

      const again = sign(await withTransaction(fresh.adminPool, (tx) => createExport(tx)));
      expect(verifyExport(again, VERIFICATION)).toEqual([]);
      const before = new Map(pkg.files.map((file) => [file.path, file.content]));
      for (const file of again.files) {
        if (file.path === 'manifest.json' || file.path === EXPORT_MANIFEST_SIGNATURE_PATH) continue;
        if (file.path === `${RETIRED_SECTION}.json`) continue;
        expect(file.content, `${file.path} differs after the upconverting round trip`).toBe(
          before.get(file.path),
        );
      }
      const withoutStamp = (p: ExportPackage) =>
        rowsOf(p, RETIRED_SECTION).map(({ retired_at: _stamp, ...row }) => row);
      expect(withoutStamp(again)).toEqual(withoutStamp(pkg));
    } finally {
      await fresh.stop();
    }
  }, 240_000);

  it('restores a format-2 archive written before object-verifications and access-demand', async () => {
    // Both arrived without a format bump (2026-09-20, 2026-09-24); an archive from before then
    // has neither file, entry nor count, and a snapshot identity over the sections of its day.
    expect(rowsOf(pkg, 'object-verifications')).toEqual([]);
    expect(rowsOf(pkg, 'access-demand')).toEqual([]);
    const older = repack(
      asArchiveBeforeTheMigration(pkg),
      new Map<string, unknown>([
        ['object-verifications.json', null],
        ['access-demand.json', null],
      ]),
    );
    const fresh = await startHarness();
    try {
      await withTransaction(fresh.adminPool, (tx) => importExport(tx, older, VERIFICATION));
      const restored = await withTransaction(fresh.adminPool, (tx) =>
        tx.one<{ n: string }>('select count(*)::text as n from work.deliverable_retired_attribute'),
      );
      expect(restored.n).toBe(String(deliverables.length));
    } finally {
      await fresh.stop();
    }
  }, 240_000);

  it('refuses a package that mixes the old and new deliverable shapes', async () => {
    const current = rowsOf(pkg, 'deliverables');
    const mixed = asArchiveBeforeTheMigration(pkg);
    const rows = rowsOf(mixed, 'deliverables');
    rows[1] = current[1]!;
    const fresh = await startHarness();
    try {
      await expect(
        withTransaction(fresh.adminPool, (tx) =>
          importExport(tx, repack(mixed, new Map([['deliverables.json', rows]])), VERIFICATION),
        ),
      ).rejects.toThrow(/mixes rows with and without the retired/);
    } finally {
      await fresh.stop();
    }
  }, 240_000);

  it('refuses a current package that lost its retired-attributes section', async () => {
    const truncated = repack(pkg, new Map([[`${RETIRED_SECTION}.json`, null]]));
    const fresh = await startHarness();
    try {
      await expect(
        withTransaction(fresh.adminPool, (tx) => importExport(tx, truncated, VERIFICATION)),
      ).rejects.toThrow(/export has no deliverable-retired-attributes\.json/);
    } finally {
      await fresh.stop();
    }
  }, 240_000);
});
