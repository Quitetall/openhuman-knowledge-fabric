/**
 * The master-record payload is read for the whole permitted set in one pass (KF-SAS-RQ-201,
 * ADR 0024, ADR 0011; migration 20260925121500), under a named reading (20260925130000): v1 is
 * the bytes claims recorded, defect included; v2 carries artifact relationships whole.
 *
 * WHY THIS FILE EXISTS. Every Object View enumerates the reader's permitted set to decide whether
 * their claim is still current, and the enumeration called `content.master_record_payload(uuid)`
 * once per visible object. That function walks the catalog and plans ~235 statements per call, so
 * a view cost ~65 ms per object in the organization: 1968 ms p95 at sixteen objects on the
 * workstation run of 2026-09-24, 25 000 shared-buffer hits per object, and linear from there.
 *
 * Two things are held here, and each can fail:
 *
 *   - THE BYTES. The payload feeds each member's content digest and so the corpus digest; a
 *     faster reading that changed one byte would make every stored claim stale, or worse, agree
 *     with a different corpus. So the one-pass function is compared, object for object and as
 *     JSON text, with the 20260826000700 implementation itself — loaded from its own migration
 *     file into a scratch schema, not re-typed — under three different readers' row security.
 *   - THE SHAPE. The work the permission-set statement does must not grow per object the way it
 *     did. Measured deterministically in shared-buffer hits (not wall time): the statement the
 *     repository issues is EXPLAINed at N objects and again at N + 12, and the increment per
 *     object must stay under 1 000 buffers. Per-object planning cost ~25 000; the one-pass form
 *     costs a handful. Reverting `enumeratePermissionSet` to call the one-object form per row
 *     fails this, which was checked before it was committed.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enumeratePermissionSet } from '@kf/documents';
import {
  bindPrincipal,
  setAccessContext,
  setTransactionContext,
  withTransaction,
  type Tx,
} from '@kf/database';
import {
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

const LEGACY_MIGRATION = join(
  import.meta.dirname,
  '..',
  '..',
  'database',
  'migrations',
  '20260826000700_master_record_payload_artifact_refs.sql',
);

let harness: Harness;
let fixtures: Fixtures;
let artifactId: string;
let documentId: string;
const plainObjects: string[] = [];

beforeAll(async () => {
  harness = await startHarness();
  fixtures = await seedFixtures(harness.adminPool);

  // The one-object implementation, verbatim from its migration, under another name.
  const up = readFileSync(LEGACY_MIGRATION, 'utf8').split('-- migrate:down')[0]!;
  const legacy = up.replace(
    'create or replace function content.master_record_payload(',
    'create function kf_legacy_payload.master_record_payload(',
  );
  expect(legacy).not.toBe(up);
  await withTransaction(harness.adminPool, async (tx) => {
    await tx.query('create schema kf_legacy_payload');
    await tx.query(legacy);
    await tx.query('grant usage on schema kf_legacy_payload to kf_app');
    await tx.query(
      'grant execute on function kf_legacy_payload.master_record_payload(uuid) to kf_app',
    );
  });

  // Enough shape that every arm of the payload has something to say: a typed extension that
  // references an artifact version, an artifact with two versions, a locator on one, and a
  // derivation link between them.
  artifactId = await createObject(harness.adminPool, fixtures, {
    type: 'artifact',
    domain: 'artifact',
    state: 'draft',
    title: 'Payload equivalence artifact',
    createdBy: fixtures.reviewerId,
  });
  documentId = await createObject(harness.adminPool, fixtures, {
    type: 'controlled_document',
    domain: 'qms',
    state: 'draft',
    title: 'Payload equivalence document',
    createdBy: fixtures.reviewerId,
  });
  const actionId = await unrecordedAction();
  // The first version gets the LARGER id, so ordering versions by id alone (rather than by
  // version number, then id) would reorder the array, and the equivalence below would see it.
  const [second, first] = [randomUUID(), randomUUID()].sort() as [string, string];
  await withTransaction(harness.adminPool, async (tx) => {
    await setAccessContext(tx, {
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
    });
    await setTransactionContext(tx, {
      actorId: fixtures.reviewerId,
      actingRoleId: fixtures.reviewerRoleId,
      actionId,
      requestId: 'master-record-payloads',
    });
    await tx.query(
      `insert into content.artifact (id, artifact_kind, source_system)
       values ($1, 'document', 'object_store')`,
      [artifactId],
    );
    for (const [n, id] of [first, second].entries()) {
      await tx.query(
        `insert into content.artifact_version
           (id, artifact_id, version_no, revision_label, sha256, size_bytes, media_type,
            storage_uri, storage_version, created_by, created_by_action)
         values ($1, $2, $3, $4, $5, 12, 'text/plain', $6, $7, $8, $9)`,
        [
          id,
          artifactId,
          n + 1,
          `R0${String(n + 1)}`,
          String(n + 1).repeat(64),
          `s3://kf/payloads-${String(n)}`,
          `object-version-${String(n)}`,
          fixtures.reviewerId,
          actionId,
        ],
      );
    }
    await tx.query(
      `insert into content.external_locator (version_id, system, external_id, authority)
       values ($1, 'dms', 'DOC-1', 'mirror')`,
      [first],
    );
    await tx.query(
      `insert into content.artifact_relationship (from_version, to_version, relationship)
       values ($1, $2, 'supersedes')`,
      [second, first],
    );
    await tx.query(
      `insert into quality.controlled_document
         (id, document_class, document_number, revision, owning_role, content_version)
       values ($1, 'report', 'OH-MR-PAYLOADS-001', 'R02', 'technical_authority', $2)`,
      [documentId, second],
    );
  });
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

async function unrecordedAction(): Promise<string> {
  const actionId = randomUUID();
  await withTransaction(harness.adminPool, async (tx) => {
    await tx.query(
      `insert into core.action
         (id, organization_id, request_digest, action_type, actor_id, acting_role_id,
          target_ids, parameters, preconditions, idempotency_key, effective_at,
          reason, result_status, result)
       values ($1, $2, encode(public.digest(convert_to($3, 'UTF8'), 'sha256'), 'hex'),
               'create_initiative', $4, $5, array[$2]::uuid[], '{}'::jsonb, '{}'::jsonb,
               $3, date_trunc('milliseconds', now()), 'master-record payloads test action', 'applied', '{}'::jsonb)`,
      [
        actionId,
        fixtures.organizationId,
        `master-record-payloads-${actionId}`,
        fixtures.reviewerId,
        fixtures.reviewerRoleId,
      ],
    );
  });
  return actionId;
}

/** A transaction on the application login, bound as a fixture person. */
function asReader<T>(
  reader: { actorId: string; actingRoleId: string; ceiling: string },
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withTransaction(harness.pool, async (tx) => {
    await bindPrincipal(tx, {
      actorId: reader.actorId,
      actingRoleId: reader.actingRoleId,
      organizationId: fixtures.organizationId,
      maxClassification: reader.ceiling,
    });
    return work(tx);
  });
}

describe('the v1 one-pass reading is byte for byte the one-object form claims recorded', () => {
  const readers = () => [
    { actorId: fixtures.reviewerId, actingRoleId: fixtures.reviewerRoleId, ceiling: 'restricted' },
    {
      actorId: fixtures.performerId,
      actingRoleId: fixtures.performerRoleId,
      ceiling: 'restricted',
    },
    { actorId: fixtures.reviewerId, actingRoleId: fixtures.reviewerRoleId, ceiling: 'public' },
  ];

  it('for every object in the organization, under each reader’s row security', async () => {
    const everyId = (
      await withTransaction(harness.adminPool, (tx) =>
        tx.query<{ id: string }>(
          'select id from core.object where organization_id = $1 order by id',
          [fixtures.organizationId],
        ),
      )
    ).map((row) => row.id);
    expect(everyId).toEqual(expect.arrayContaining([artifactId, documentId]));
    // An id nobody can see, and one that does not exist, answer the empty payload in both forms.
    const ids = [...everyId, randomUUID()];
    for (const reader of readers()) {
      const rows = await asReader(reader, (tx) =>
        tx.query<{ id: string; legacy: string; one_pass: string; one: string }>(
          `select requested.id,
                  kf_legacy_payload.master_record_payload(requested.id)::text as legacy,
                  payloads.payload::text as one_pass,
                  content.master_record_payload(requested.id, 'kf-master-record-payload-v1')::text
                    as one
             from unnest($1::uuid[]) as requested(id)
             left join content.master_record_payloads($1::uuid[], 'kf-master-record-payload-v1')
                    payloads
               on payloads.object_id = requested.id
            order by requested.id`,
          [ids],
        ),
      );
      expect(rows).toHaveLength(ids.length);
      for (const row of rows) {
        expect(row.one_pass, `${reader.ceiling} ${row.id}`).toBe(row.legacy);
        expect(row.one, `${reader.ceiling} ${row.id}`).toBe(row.legacy);
      }
    }
  });

  it('is not vacuous: the fixture exercises every arm of the payload', async () => {
    const payloads = await asReader(readers()[0]!, (tx) =>
      tx.query<{ object_id: string; payload: Record<string, unknown[]> }>(
        `select object_id, payload
           from content.master_record_payloads($1::uuid[], 'kf-master-record-payload-v2')`,
        [[artifactId, documentId]],
      ),
    );
    const byId = new Map(payloads.map((row) => [row.object_id, row.payload]));
    const artifact = byId.get(artifactId)!;
    const document = byId.get(documentId)!;
    expect(Object.keys(artifact)).toEqual(
      expect.arrayContaining([
        'core.object',
        'content.artifact',
        'content.artifact_version',
        'content.external_locator',
        'content.artifact_relationship',
      ]),
    );
    expect(artifact['content.artifact_version']).toHaveLength(2);
    // The document references only the second version, so it carries that version and the link
    // out of it, and not the first version's locator.
    expect(Object.keys(document)).toEqual(
      expect.arrayContaining([
        'core.object',
        'quality.controlled_document',
        'content.artifact_version',
        'content.artifact_relationship',
      ]),
    );
    expect(document['content.artifact_version']).toHaveLength(1);
    expect(document['content.external_locator']).toBeUndefined();
    // A typed row keyed by an object FK other than id reaches the object as an array too.
    const everyKey = payloads.flatMap((row) => Object.keys(row.payload));
    expect(everyKey.some((key) => key.split('.').length === 3)).toBe(true);
  });

  it('keys every typed extension by a unique id, so the duplicate refusal cannot fire today', async () => {
    const tables = await withTransaction(harness.adminPool, (tx) =>
      tx.query<{ name: string; unique_id: boolean }>(
        `select namespace.nspname || '.' || relation.relname as name,
              exists (select 1 from pg_index ix
                       where ix.indrelid = relation.oid and ix.indisunique
                         and ix.indnkeyatts = 1 and ix.indkey[0] = id_column.attnum) as unique_id
         from pg_class relation
         join pg_namespace namespace on namespace.oid = relation.relnamespace
         join pg_attribute id_column
           on id_column.attrelid = relation.oid and id_column.attname = 'id'
          and id_column.attnum > 0 and not id_column.attisdropped
        where relation.relkind = 'r' and relation.relrowsecurity
          and namespace.nspname in ('content', 'engineering', 'finance', 'ml', 'org', 'product',
                                    'quality', 'secure_object', 'work')
          and relation.relname not like 'master_record%'
          and relation.relname <> 'person_entitlement_exclusion'
          and exists (select 1 from pg_constraint c
                       where c.conrelid = relation.oid and c.contype = 'f'
                         and c.confrelid = 'core.object'::regclass
                         and c.conkey = array[id_column.attnum]::smallint[])`,
      ),
    );
    expect(tables.length).toBeGreaterThan(20);
    expect(tables.filter((t) => !t.unique_id).map((t) => t.name)).toEqual([]);
  });
});

describe('the v2 reading carries each artifact relationship whole (20260925130000)', () => {
  // DELIBERATELY CHANGED. This file first pinned the one-pass form to the one-object form byte
  // for byte, and so pinned a defect both shared: `to_jsonb(relationship)` over
  // content.artifact_relationship resolves to its `relationship` COLUMN, so a payload said
  // ["supersedes"] and not which version superseded which. The v1 reading above keeps that byte
  // for byte, because claims recorded under it are re-checked under it; v2 is the correction, and
  // the member format a claim records says which one it was digested over.
  const relationships = async (format: string): Promise<unknown[]> => {
    const [row] = await withTransaction(harness.pool, async (tx) => {
      await bindPrincipal(tx, {
        actorId: fixtures.reviewerId,
        actingRoleId: fixtures.reviewerRoleId,
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      return tx.query<{ payload: Record<string, unknown[]> }>(
        'select payload from content.master_record_payloads($1::uuid[], $2)',
        [[artifactId], format],
      );
    });
    return row!.payload['content.artifact_relationship']!;
  };

  it('records from, to and kind, where v1 recorded the kind alone', async () => {
    const [v1] = await relationships('kf-master-record-payload-v1');
    expect(v1).toBe('supersedes');
    const [v2] = await relationships('kf-master-record-payload-v2');
    const versions = await withTransaction(harness.adminPool, (tx) =>
      tx.query<{ id: string; version_no: number }>(
        'select id, version_no from content.artifact_version where artifact_id = $1',
        [artifactId],
      ),
    );
    const byNumber = new Map(versions.map((v) => [v.version_no, v.id]));
    expect(v2).toMatchObject({
      from_version: byNumber.get(2),
      to_version: byNumber.get(1),
      relationship: 'supersedes',
    });
  });

  it('differs from v1 nowhere else', async () => {
    const both = await asReader(
      {
        actorId: fixtures.reviewerId,
        actingRoleId: fixtures.reviewerRoleId,
        ceiling: 'restricted',
      },
      (tx) =>
        tx.query<{ v1: Record<string, unknown>; v2: Record<string, unknown> }>(
          `select one.payload as v1, two.payload as v2
             from content.master_record_payloads($1::uuid[], 'kf-master-record-payload-v1') one
             join content.master_record_payloads($1::uuid[], 'kf-master-record-payload-v2') two
               using (object_id)`,
          [[artifactId, documentId, ...plainObjects]],
        ),
    );
    expect(both.length).toBeGreaterThanOrEqual(2);
    for (const { v1, v2 } of both) {
      const { ['content.artifact_relationship']: _r1, ...rest1 } = v1;
      const { ['content.artifact_relationship']: _r2, ...rest2 } = v2;
      expect(rest2).toEqual(rest1);
    }
  });

  it('refuses a reading it does not name, and has no default', async () => {
    await expect(
      withTransaction(harness.adminPool, (tx) =>
        tx.query("select * from content.master_record_payloads(array[gen_random_uuid()], 'v3')"),
      ),
    ).rejects.toThrow(/unknown master-record payload format/);
    await expect(
      withTransaction(harness.adminPool, (tx) =>
        tx.query('select * from content.master_record_payloads(array[gen_random_uuid()])'),
      ),
    ).rejects.toThrow(/does not exist/);
  });
});

describe('the permission-set enumeration does not grow its work per object', () => {
  /**
   * Shared buffers the repository's own permission-set statement touches, including everything
   * the functions it calls do. The statement is intercepted and EXPLAINed in place, so this is
   * the exact SQL `enumeratePermissionSet` issues, not a copy of it.
   */
  async function permissionSetBuffers(): Promise<number> {
    let buffers: number | undefined;
    await asReader(
      {
        actorId: fixtures.reviewerId,
        actingRoleId: fixtures.reviewerRoleId,
        ceiling: 'restricted',
      },
      async (tx) => {
        const intercepting = new Proxy(tx, {
          get(target, key, receiver) {
            if (key === 'query') {
              return async (sql: string, params?: readonly unknown[]) => {
                if (!sql.includes('/* master-record.permission-set */')) {
                  return target.query(sql, params as unknown[]);
                }
                const [plan] = await target.query<{ 'QUERY PLAN': unknown }>(
                  `explain (analyze, buffers, format json) ${sql}`,
                  params as unknown[],
                );
                const root = (plan!['QUERY PLAN'] as { Plan: Record<string, number> }[])[0]!.Plan;
                buffers = root['Shared Hit Blocks']! + root['Shared Read Blocks']!;
                return [];
              };
            }
            const value: unknown = Reflect.get(target, key, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        await enumeratePermissionSet(intercepting, fixtures.organizationId);
      },
    );
    if (buffers === undefined) throw new Error('the permission-set statement was never issued');
    return buffers;
  }

  it('costs well under 1 000 shared buffers per additional object', async () => {
    const before = await permissionSetBuffers();
    const added = 12;
    for (let i = 0; i < added; i += 1) {
      plainObjects.push(
        await createObject(harness.adminPool, fixtures, {
          type: 'artifact',
          domain: 'artifact',
          state: 'draft',
          title: `Payload cost probe ${String(i)}`,
          createdBy: fixtures.reviewerId,
        }),
      );
    }
    const after = await permissionSetBuffers();
    const perObject = (after - before) / added;
    // One-object form, called per row: ~25 000 per object (planning ~235 statements each).
    expect(perObject).toBeLessThan(1_000);
  });
});
