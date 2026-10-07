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
import { SECTIONS_ADDED_WITHOUT_FORMAT_BUMP } from '../../packages/export/src/internal/section-eras.js';
import { IMPORT_TARGETS } from '../../packages/export/src/internal/import-targets.js';
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
/**
 * The arrival after the retired attributes (b535bb14, ADR 0040): an archive written before the
 * retired attributes was written before these too, so every archive of that era lacks them.
 */
const AFTER_RETIRED = ['verification-policies', 'act-proposals', 'act-proposal-resolutions'];

/**
 * Sections whose rows 20260902000200 derived rather than created empty: the `working` store it
 * declared and the working location of every addressed version. An archive from before them
 * still restores those rows.
 */
const STORAGE_SECTIONS = ['artifact-stores', 'artifact-locations'] as const;

/**
 * The later sections, by the day an exporter first wrote them, spelled out here rather than read
 * from `section-eras.ts`: the list there is what these tests check, not what they are built from.
 */
const AUGUST_26 = [
  'person-clearances',
  'person-clearance-retirements',
  'person-entitlement-exclusions',
  'master-records',
  'master-record-items',
  'master-record-withholdings',
  'master-record-links',
  'master-record-link-revocations',
  'master-record-delivery-receipts',
  'master-record-link-access',
];
/** Written before storage locations (b240779c) and kept by an archive of that day. */
const BEFORE_STORAGE = [...AUGUST_26, 'access-grants'];
/** Storage locations, and every section after them. */
const FROM_STORAGE_ON = [
  ...STORAGE_SECTIONS,
  'identifier-sequences',
  'identifier-allocations',
  'warrants',
  'warrant-contract-revisions',
  'warrant-preflights',
  'warrant-dispatches',
  'warrant-runtime-receipts',
  'warrant-submissions',
  'warrant-blockers',
  'warrant-deviations',
  'warrant-discovered-gaps',
  'warrant-artifacts',
  'warrant-evidence',
  'warrant-gate-runs',
  'warrant-inferences',
  'warrant-judgments',
  'warrant-resolution-requests',
  'object-verifications',
  'orphan-collections',
  'product-systems',
  'baselines',
  'releases',
  'requirements',
  'risks',
  'tests',
  'observations',
  'access-demand',
  // ADR 0040 (20261007100000), after the retired attributes: an archive older than those is
  // older than these.
  'verification-policies',
  'act-proposals',
  'act-proposal-resolutions',
];
/** Every section added without a format bump but the retired attributes, dropped separately. */
const LATER = [...BEFORE_STORAGE, ...FROM_STORAGE_ON];

let h: Harness;
let f: Fixtures;
let pkg: ExportPackage;
const deliverables: { id: string; kind: string; done: string }[] = [];
/** The addressed artifact version, as its working location must be derived from it. */
let addressed: { id: string; uri: string; version: string };

function sign(p: ExportPackage): ExportPackage {
  return signExportPackage(p, { keyId: KEY_ID, privateKey: KEY.privateKey });
}

type JsonRow = Record<string, unknown>;

function rowsOf(p: ExportPackage, name: string): JsonRow[] {
  return JSON.parse(p.files.find((file) => file.path === `${name}.json`)!.content) as JsonRow[];
}

/**
 * Rewrite the package's files (a null content removes one) and sign it again, and the result must
 * verify. Unsigned, it is left for the caller to verify: the signer refuses a malformed package.
 */
function repack(
  base: ExportPackage,
  changes: ReadonlyMap<string, unknown>,
  { signed = true }: { readonly signed?: boolean } = {},
): ExportPackage {
  const files = base.files
    .filter((x) => x.path !== 'manifest.json' && x.path !== EXPORT_MANIFEST_SIGNATURE_PATH)
    .filter((x) => !(changes.has(x.path) && changes.get(x.path) === null))
    .map((x) =>
      changes.has(x.path) ? { path: x.path, content: `${canonicalize(changes.get(x.path))}\n` } : x,
    );
  const counts = Object.fromEntries(
    Object.entries(base.manifest.counts)
      .filter(([name]) => !(changes.has(`${name}.json`) && changes.get(`${name}.json`) === null))
      .map(([name, count]) => {
        const changed = changes.get(`${name}.json`);
        return [name, Array.isArray(changed) ? changed.length : count];
      }),
  );
  const manifest: ExportManifest = {
    ...base.manifest,
    counts,
    // The identity an exporter of the archive's day computed: over the sections it wrote.
    database_snapshot_sha256: recomputeDatabaseSnapshotDigest(
      files,
      new Set(
        Object.keys(base.manifest.counts)
          .concat(RETIRED_SECTION, AFTER_RETIRED)
          .filter((name) => !files.some((file) => file.path === `${name}.json`)),
      ),
    ),
    files: files.map((file) => {
      const bytes = Buffer.from(file.content, 'utf8');
      return { path: file.path, size_bytes: bytes.length, sha256: digestBytes(bytes) };
    }),
  };
  const unsigned: ExportPackage = {
    files: [...files, { path: 'manifest.json', content: `${canonicalize(manifest)}\n` }],
    manifest,
  };
  if (!signed) return unsigned;
  const result = sign(unsigned);
  expect(verifyExport(result, VERIFICATION)).toEqual([]);
  return result;
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
      ...AFTER_RETIRED.map((name): [string, null] => [`${name}.json`, null]),
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

  // One version with an address and one without, recorded as a host before 20260902000200
  // recorded them: the columns only. The trigger that migration installed gives the addressed one
  // its working location here; an archive from before it must get the same location on import.
  for (const uri of [`artifacts/upconversion/v1`, null]) {
    const artifactId = await createObject(h.adminPool, f, {
      type: 'artifact',
      domain: 'artifact',
      state: 'draft',
      title: `Artifact ${uri ?? 'without an address'}`,
      createdBy: f.reviewerId,
    });
    const versionId = randomUUID();
    await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f, f.reviewerId);
      await tx.query(
        `insert into content.artifact (id, artifact_kind, source_system)
         values ($1, 'document', 'object_store')`,
        [artifactId],
      );
      await tx.query(
        `insert into content.artifact_version
           (id, artifact_id, version_no, revision_label, sha256, size_bytes, media_type,
            storage_uri, storage_version, created_by, created_by_action)
         values ($1, $2, 1, 'R01', $3, 5, 'text/plain', $4, $5, $6, $7)`,
        [
          versionId,
          artifactId,
          digestBytes(Buffer.from(versionId)),
          uri,
          uri === null ? null : 'store-version-1',
          f.reviewerId,
          f.clearanceActionId,
        ],
      );
    });
    if (uri !== null) addressed = { id: versionId, uri, version: 'store-version-1' };
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

  it('restores a format-2 archive written before any section added without a format bump', async () => {
    // Each arrived without a format bump (2026-08-26 to 2026-09-24, section-eras.ts); an archive
    // from before them has no file, entry or count, and a snapshot identity over the sections of
    // its day. The retired-attributes section is the upconversion's own and is dropped above.
    const later = LATER;
    // A table whose section is named was created empty by its migration, so an older host had no
    // rows in it. The fixture has some only where the current schema cannot run without them:
    // clearances, without which nobody may act at all since 20260826000200. Cutting those rows
    // is exactly the older host's state for that table.
    const populated = later.filter(
      (name) =>
        !(STORAGE_SECTIONS as readonly string[]).includes(name) && rowsOf(pkg, name).length > 0,
    );
    expect(populated).toEqual(['person-clearances']);
    const older = repack(
      asArchiveBeforeTheMigration(pkg),
      new Map<string, unknown>(later.map((name) => [`${name}.json`, null])),
    );
    for (const name of later) expect(older.manifest.counts, name).not.toHaveProperty(name);
    const fresh = await startHarness();
    try {
      await withTransaction(fresh.adminPool, (tx) => importExport(tx, older, VERIFICATION));
      const restored = await withTransaction(fresh.adminPool, async (tx) => {
        const count = async (table: string) =>
          Number((await tx.one<{ n: string }>(`select count(*)::text as n from ${table}`)).n);
        const empty: Record<string, number> = {};
        for (const name of later) {
          if ((STORAGE_SECTIONS as readonly string[]).includes(name)) continue;
          empty[name] = await count(IMPORT_TARGETS[name]!);
        }
        return {
          retired: await count('work.deliverable_retired_attribute'),
          empty,
          stores: await tx.query<{ id: string }>('select id from content.artifact_store'),
          locations: await tx.query<{ version_id: string }>(
            'select version_id from content.artifact_location',
          ),
        };
      });
      expect(restored.retired).toBe(deliverables.length);
      // Absence meant none, and none is what the restore holds.
      expect(
        Object.values(restored.empty).every((n) => n === 0),
        JSON.stringify(restored.empty),
      ).toBe(true);
      // Absence did not mean none for these: the migration's rows are back.
      expect(restored.stores).toEqual([{ id: 'working' }]);
      expect(restored.locations).toEqual([{ version_id: addressed.id }]);
      // And this test covers every section the list names.
      expect(new Set(SECTIONS_ADDED_WITHOUT_FORMAT_BUMP)).toEqual(
        new Set([...later, RETIRED_SECTION]),
      );
    } finally {
      await fresh.stop();
    }
  }, 240_000);

  it('restores the roles a later migration seeded when the archive predates them', async () => {
    // 20260911000100 seeded customer_contact and partner_contact. An archive written before it
    // carries every other role and not those two; the restore replaces the roles with the
    // archive's, and must keep the two the migration would have added.
    const seededLater = ['customer_contact', 'partner_contact'];
    const roles = rowsOf(pkg, 'roles');
    for (const id of seededLater) expect(roles.map((row) => row['id'])).toContain(id);
    const older = repack(
      pkg,
      new Map<string, unknown>([
        ['roles.json', roles.filter((row) => !seededLater.includes(String(row['id'])))],
      ]),
    );
    const fresh = await startHarness();
    try {
      await withTransaction(fresh.adminPool, (tx) => importExport(tx, older, VERIFICATION));
      const restored = await withTransaction(fresh.adminPool, (tx) =>
        tx.query<{ id: string }>('select id from org.role order by id'),
      );
      expect(restored.map((row) => row.id)).toEqual(roles.map((row) => String(row['id'])).sort());
    } finally {
      await fresh.stop();
    }
  }, 240_000);

  it('restores an archive written before storage locations as 20260902000200 derived them', async () => {
    // What the source holds is what a host that ran the migration over these versions held: the
    // `working` store it declared, and one working location per addressed version.
    expect(rowsOf(pkg, 'artifact-stores').map((row) => row['id'])).toEqual(['working']);
    expect(
      rowsOf(pkg, 'artifact-locations').map((row) => [
        row['version_id'],
        row['store_id'],
        row['role'],
      ]),
    ).toEqual([[addressed.id, 'working', 'working']]);

    const dropped = FROM_STORAGE_ON;
    for (const name of dropped) {
      if ((STORAGE_SECTIONS as readonly string[]).includes(name)) continue;
      expect(rowsOf(pkg, name), name).toEqual([]);
    }
    const older = repack(
      asArchiveBeforeTheMigration(pkg),
      new Map<string, unknown>(dropped.map((name) => [`${name}.json`, null])),
    );
    // The sections of 2026-08-26 and the access grants before it stay.
    expect(older.manifest.counts).toHaveProperty('person-clearances');
    expect(older.manifest.counts).toHaveProperty('access-grants');
    expect(older.manifest.counts).not.toHaveProperty('artifact-stores');

    const fresh = await startHarness();
    try {
      await withTransaction(fresh.adminPool, (tx) => importExport(tx, older, VERIFICATION));
      const locations = await withTransaction(fresh.adminPool, (tx) =>
        tx.query(
          `select l.version_id, l.store_id, l.role, l.uri, l.store_version,
                  l.recorded_at = v.created_at as recorded_when_created,
                  l.recorded_by, l.recorded_by_action, l.verified_at, l.verified_sha256,
                  l.verification_failure, l.verified_by_action
             from content.artifact_location l
             join content.artifact_version v on v.id = l.version_id`,
        ),
      );
      // The migration's backfill, column for column: no recorder, because it recorded none.
      expect(locations).toEqual([
        {
          version_id: addressed.id,
          store_id: 'working',
          role: 'working',
          uri: addressed.uri,
          store_version: addressed.version,
          recorded_when_created: true,
          recorded_by: null,
          recorded_by_action: null,
          verified_at: null,
          verified_sha256: null,
          verification_failure: null,
          verified_by_action: null,
        },
      ]);

      // Everything else the archive carried comes back byte for byte; the storage sections come
      // back as the migration made them. The store's declaration time is when this database ran
      // the migration, and the location's id and recorder are the backfill's, not the trigger's.
      const again = sign(await withTransaction(fresh.adminPool, (tx) => createExport(tx)));
      expect(verifyExport(again, VERIFICATION)).toEqual([]);
      const before = new Map(pkg.files.map((file) => [file.path, file.content]));
      for (const file of again.files) {
        if (file.path === 'manifest.json' || file.path === EXPORT_MANIFEST_SIGNATURE_PATH) continue;
        if (file.path === `${RETIRED_SECTION}.json`) continue;
        if ((STORAGE_SECTIONS as readonly string[]).some((name) => file.path === `${name}.json`)) {
          continue;
        }
        expect(file.content, `${file.path} differs after the upconverting round trip`).toBe(
          before.get(file.path),
        );
      }
      const without = (p: ExportPackage, name: string, columns: readonly string[]) =>
        rowsOf(p, name).map((row) =>
          Object.fromEntries(Object.entries(row).filter(([column]) => !columns.includes(column))),
        );
      expect(without(again, 'artifact-stores', ['declared_at'])).toEqual(
        without(pkg, 'artifact-stores', ['declared_at']),
      );
      expect(
        without(again, 'artifact-locations', ['id', 'recorded_by', 'recorded_by_action']),
      ).toEqual(without(pkg, 'artifact-locations', ['id', 'recorded_by', 'recorded_by_action']));
    } finally {
      await fresh.stop();
    }
  }, 240_000);

  it("refuses an archive whose missing sections are no exporter's era", () => {
    // The shape findings of the unsigned package; the missing signature is not what is tested.
    const drop = (...names: string[]) =>
      verifyExport(
        repack(pkg, new Map<string, unknown>(names.map((name) => [`${name}.json`, null])), {
          signed: false,
        }),
        VERIFICATION,
      )
        .filter((finding) => finding.problem !== 'missing_signature')
        .map((finding) => finding.detail);

    // Half of one arrival: the warrants came with their contract revisions.
    expect(drop('warrants')).toEqual([
      expect.stringMatching(/warrants, warrant-contract-revisions arrived together \(20ead1c9\)/),
    ]);
    expect(drop('artifact-locations')).toEqual([
      expect.stringMatching(/arrived together \(b240779c\), but only artifact-locations is absent/),
    ]);
    // An arrival absent under a later one present: no exporter wrote access grants without
    // having written clearances first.
    expect(drop(...AUGUST_26)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /predates person-clearances.* \(2184efba\) but carries access-grants/,
        ),
      ]),
    );
    // The fork of 2026-09-24: an exporter on the access-demand branch wrote access-demand
    // without the product records and observations, and that archive is an era.
    expect(
      drop(
        'product-systems',
        'baselines',
        'releases',
        'requirements',
        'risks',
        'tests',
        'observations',
        RETIRED_SECTION,
        ...AFTER_RETIRED,
      ),
    ).toEqual([]);
    expect(drop('access-demand', RETIRED_SECTION, ...AFTER_RETIRED)).toEqual([]);
    expect(drop('access-demand')).toEqual([
      expect.stringMatching(
        /predates access-demand \(de59c226\) but carries deliverable-retired-attributes/,
      ),
      expect.stringMatching(
        /predates access-demand \(de59c226\) but carries verification-policies, act-proposals, act-proposal-resolutions/,
      ),
    ]);
  });

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
    // Truncated to the retired attributes' era: what arrived after them goes too, or the verifier
    // refuses the era before the importer ever sees the deliverables.
    const truncated = repack(
      pkg,
      new Map([RETIRED_SECTION, ...AFTER_RETIRED].map((name) => [`${name}.json`, null])),
    );
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
