import { randomUUID, randomBytes, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { InMemoryObjectStore } from '@kf/artifacts';
import { withTransaction, type Tx } from '@kf/database';
import { canonicalize, digestBytes } from '@kf/canonicalization';
import {
  createExport,
  importExport,
  recomputeDatabaseSnapshotDigest,
  signExportPackage,
  verifyExport,
  type ExportPackage,
} from '@kf/export';
import {
  createDocumentActionAtoms,
  latestMasterRecordClaim,
  enumeratePermittedSet,
  enumerateRelevanceGraph,
  masterRecordMemberFormat,
} from '@kf/documents';
import { loadProjectionDefinitions, project } from '@kf/projections';
import { createFabricDispatcher } from '@kf/orchestrator';
import { latestClaim } from '../../apps/api/src/routes/context-source/record.js';
import {
  readCurrentMasterRecord,
  readCurrentProjectionCorpus,
} from '../../apps/api/src/routes/documents/current-master-record.js';
import {
  liveVerifications,
  projectionMembersOf,
} from '../../apps/api/src/routes/documents/master-record-members.js';
import { bindReader, seedFixtures, startHarness, type Fixtures, type Harness } from './harness.js';

let h: Harness;
let f: Fixtures;
const ROOT = join(import.meta.dirname, '..', '..');
const DEFINITIONS = loadProjectionDefinitions(
  join(ROOT, 'generated/projections/knowledge-fabric.projections.json'),
);
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
  await execute({
    actionType: 'compile_master_record',
    actorId: f.performerId,
    actingRoleId: f.performerRoleId,
    organizationId: f.organizationId,
    maxClassification: 'restricted',
    targetIds: [f.performerId],
    idempotencyKey: randomUUID(),
  });
}, 180000);
afterAll(async () => {
  await h?.stop();
});

function observed(tx: Tx, statements: string[]): Tx {
  return {
    query(sql, params) {
      statements.push(sql);
      return tx.query(sql, params);
    },
    one(sql, params) {
      statements.push(sql);
      return tx.one(sql, params);
    },
    maybeOne(sql, params) {
      statements.push(sql);
      return tx.maybeOne(sql, params);
    },
    queryWithTextParsers(sql, params, parsers) {
      statements.push(sql);
      return tx.queryWithTextParsers(sql, params, parsers);
    },
  };
}

it('reads the context format from a stored header, never from the large manifest', async () => {
  await withTransaction(h.pool, async (tx) => {
    await bindReader(tx, f);
    const statements: string[] = [];
    const claim = await latestClaim(observed(tx, statements), {
      actorId: f.performerId,
      organizationId: f.organizationId,
    });
    expect(claim?.memberFormat).toBe('kf-master-record-member-v2');
    expect(statements.join('\n')).not.toContain('manifest ->>');
    expect(statements.join('\n')).toContain('manifest_format');
  });
});

it('carries the exact manifest format in the same small claim header', async () => {
  await withTransaction(h.pool, async (tx) => {
    await bindReader(tx, f);
    const claim = await latestMasterRecordClaim(tx, f.performerId, f.organizationId);
    expect(claim).toHaveProperty('manifestFormat', 'kf-master-record-v3');
  });
});

it('does not permit an independently authored format header', async () => {
  await expect(
    withTransaction(h.adminPool, (tx) =>
      tx.query("update content.master_record set manifest_format='independent-format'"),
    ),
  ).rejects.toMatchObject({ code: '428C9' });
});

it('serves a current full record without recomputing every content payload', async () => {
  await withTransaction(h.pool, async (tx) => {
    await bindReader(tx, f);
    const statements: string[] = [];
    const reading = await readCurrentMasterRecord(observed(tx, statements), {
      actorId: f.performerId,
      organizationId: f.organizationId,
    });
    expect(reading.status).toBe('ready');
    expect(statements.join('\n')).toContain('master-record.current-format');
    expect(statements.join('\n')).not.toContain('master-record.permission-set');
    expect(statements.filter((sql) => sql.includes('master-record.by-id'))).toHaveLength(1);
  });
});

it('projects validated items without the manifest or a recount, byte-identical to the previous reading', async () => {
  await withTransaction(h.pool, async (tx) => {
    await bindReader(tx, f);
    const reader = { actorId: f.performerId, organizationId: f.organizationId };
    const definition = DEFINITIONS.byId('master_sections')!;
    const statements: string[] = [];
    const reading = await readCurrentProjectionCorpus(observed(tx, statements), reader, definition);
    if (reading.status !== 'ready') throw new Error(reading.status);
    expect(statements.join('\n')).not.toMatch(
      /master-record\.(?:permission-set|manifest|by-id|latest)\s/,
    );
    expect(statements.join('\n')).toContain('master-record.members-among');
    const graph = await enumerateRelevanceGraph(tx);
    const record = await readCurrentMasterRecord(tx, reader);
    if (record.status !== 'ready') throw new Error(record.status);
    const manifest = record.manifest;
    const permitted = await enumeratePermittedSet(
      tx,
      f.performerId,
      f.organizationId,
      masterRecordMemberFormat(manifest),
    );
    const previous = project({
      definition,
      parameters: {},
      graph,
      corpus: {
        personId: f.performerId,
        organizationId: f.organizationId,
        corpusDigest: String(record.record['corpus_digest']),
        members: projectionMembersOf(manifest, liveVerifications(permitted)),
      },
    });
    expect(project({ definition, parameters: {}, graph, corpus: reading.corpus })).toEqual(
      previous,
    );
  });
});

it('refuses excessive membership and malformed parameters before loading payloads', async () => {
  await withTransaction(h.pool, async (tx) => {
    await bindReader(tx, f);
    const definition = DEFINITIONS.byId('master_sections')!;
    const small = { ...definition, budgets: { ...definition.budgets, maxMembers: 1 } };
    const reader = { actorId: f.performerId, organizationId: f.organizationId };
    const statements: string[] = [];
    await expect(
      readCurrentProjectionCorpus(observed(tx, statements), reader, small),
    ).rejects.toMatchObject({ reason: 'budget_exceeded' });
    await expect(
      readCurrentProjectionCorpus(observed(tx, statements), reader, small, { nonsense: true }),
    ).rejects.toMatchObject({ reason: 'unknown_parameter' });
    expect(statements.join('\n')).not.toMatch(
      /master-record\.(?:members-among|member-ids|manifest|by-id)\s/,
    );
  });
});

it('the physical header avoids TOAST reads on a large manifest', async () => {
  const proof = await withTransaction(h.adminPool, async (tx) => {
    const row = await tx.one<{ id: string }>('select id from content.master_record limit 1');
    // Synthetic physical-layout probe only, always rolled back: never serve this modified claim.
    await tx.query('alter table content.master_record disable trigger master_record_append_only');
    await tx.query(
      "update content.master_record set manifest = manifest || jsonb_build_object('layout_probe', $2::text) where id=$1",
      [row.id, randomBytes(512 * 1024).toString('hex')],
    );
    await tx.query('alter table content.master_record enable trigger master_record_append_only');
    const buffers = async (expression: string) => {
      const result = await tx.one<{ 'QUERY PLAN': { Plan: Record<string, number> }[] }>(
        `explain (analyze, buffers, format json) select ${expression} from content.master_record where id=$1`,
        [row.id],
      );
      const plan = result['QUERY PLAN'][0]!.Plan;
      return (plan['Shared Hit Blocks'] ?? 0) + (plan['Shared Read Blocks'] ?? 0);
    };
    const previous = await buffers("manifest ->> 'format'");
    const header = await buffers('manifest_format');
    expect(previous).toBeGreaterThan(header + 64);
    // Roll back before leaving the transaction while still returning the measured values.
    throw Object.assign(new Error('layout probe rollback'), { previous, header });
  }).catch((error: unknown) => {
    if (
      !(error instanceof Error) ||
      error.message !== 'layout probe rollback' ||
      !('previous' in error) ||
      !('header' in error)
    )
      throw error;
    return { previous: error.previous, header: error.header };
  });
  console.warn(
    `[master-record-header-cost] previous=${String(proof.previous)} header=${String(proof.header)} shared buffers`,
  );
});

for (const field of ['title', 'classification'] as const) {
  it(`refuses a trusted signed archive whose item ${field} contradicts its manifest`, async () => {
    const fresh = await startHarness();
    // Ephemeral test authority only: authenticating an archive does not prove its row invariants.
    const key = generateKeyPairSync('ed25519');
    const signing = { keyId: 'item-consistency-test', privateKey: key.privateKey };
    const trust = { trustedManifestKeys: new Map([[signing.keyId, key.publicKey]]) };
    const base = await withTransaction(h.adminPool, (tx) => createExport(tx));
    const path = 'master-record-items.json';
    const entry = base.files.find((file) => file.path === path)!;
    const rows = JSON.parse(entry.content) as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    const first = rows[0]!;
    first[field] =
      field === 'title'
        ? 'Contradictory title'
        : first[field] === 'public'
          ? 'restricted'
          : 'public';
    const files = base.files
      .filter((file) => file.path !== 'manifest.json')
      .map((file) => (file.path === path ? { path, content: `${canonicalize(rows)}\n` } : file));
    const manifest = {
      ...base.manifest,
      database_snapshot_sha256: recomputeDatabaseSnapshotDigest(files),
      files: files.map((file) => {
        const bytes = Buffer.from(file.content, 'utf8');
        return { path: file.path, size_bytes: bytes.length, sha256: digestBytes(bytes) };
      }),
    };
    const altered: ExportPackage = signExportPackage(
      {
        files: [...files, { path: 'manifest.json', content: `${canonicalize(manifest)}\n` }],
        manifest,
      },
      signing,
    );
    expect(verifyExport(altered, trust)).toEqual([]);
    try {
      await expect(
        withTransaction(fresh.adminPool, (tx) => importExport(tx, altered, trust)),
      ).rejects.toThrow('master-record item contradicts its immutable manifest');
      await withTransaction(fresh.adminPool, async (tx) => {
        expect(await tx.one('select count(*)::text as count from core.object')).toEqual({
          count: '0',
        });
        const disabled = await tx.query(
          `select 1 from pg_trigger where tgrelid='content.master_record_item'::regclass
             and not tgisinternal and tgenabled='D'`,
        );
        expect(disabled).toEqual([]);
        // The untouched archive still restores, including its recomputed generated header.
        await importExport(tx, signExportPackage(base, signing), trust);
        expect(await tx.one('select manifest_format from content.master_record limit 1')).toEqual({
          manifest_format: 'kf-master-record-v3',
        });
      });
    } finally {
      await fresh.stop();
    }
  }, 180000);

  it(`refuses an item whose ${field} contradicts its immutable manifest`, async () => {
    const plant = (withoutCheck: boolean) =>
      withTransaction(h.adminPool, async (tx) => {
        const item = await tx.one<Record<string, unknown>>(
          'select * from content.master_record_item order by object_id limit 1',
        );
        // Fault fixture only: free this one key, restore guards, then test the INSERT itself.
        // The final throw rolls back every change, including the temporary trigger state.
        await tx.query('alter table content.master_record_item disable trigger user');
        await tx.query(
          'delete from content.master_record_item where master_record_id=$1 and object_id=$2',
          [item['master_record_id'], item['object_id']],
        );
        await tx.query('alter table content.master_record_item enable trigger user');
        if (withoutCheck)
          await tx.query(
            'alter table content.master_record_item disable trigger master_record_item_matches_manifest',
          );
        await tx.query(
          `insert into content.master_record_item
        (master_record_id, object_id, object_type, title, classification, content_digest, item_state, content_payload)
        values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
          [
            item['master_record_id'],
            item['object_id'],
            item['object_type'],
            field === 'title' ? 'Contradictory title' : item['title'],
            field === 'classification'
              ? item['classification'] === 'public'
                ? 'restricted'
                : 'public'
              : item['classification'],
            item['content_digest'],
            item['item_state'],
            JSON.stringify(item['content_payload']),
          ],
        );
        throw new Error('contradictory item accepted');
      });
    await expect(plant(false)).rejects.toThrow('not a member of the manifest');
    await expect(plant(true)).rejects.toThrow('contradictory item accepted');
  });

  it(`the migration refuses a pre-existing contradictory ${field} without rewriting it`, async () => {
    const migration = readFileSync(
      join(ROOT, 'database/migrations/20261001000200_item_metadata_matches_the_manifest.sql'),
      'utf8',
    ).split('-- migrate:down')[0]!;
    await expect(
      withTransaction(h.adminPool, async (tx) => {
        await tx.query('alter table content.master_record_item disable trigger user');
        await tx.query(
          field === 'title'
            ? "update content.master_record_item set title='Contradictory title'"
            : "update content.master_record_item set classification=case when classification='public' then 'restricted' else 'public' end",
        );
        await tx.query('alter table content.master_record_item enable trigger user');
        await tx.query(migration);
        throw new Error('contradictory migration accepted');
      }),
    ).rejects.toThrow('existing master-record item metadata contradicts its manifest');
  });
}
