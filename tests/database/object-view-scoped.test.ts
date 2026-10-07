import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Fastify from 'fastify';
import { InMemoryObjectStore } from '@kf/artifacts';
import { withTransaction, type Tx } from '@kf/database';
import {
  createDocumentActionAtoms,
  enumeratePermittedSet,
  enumerateRelevanceGraph,
  latestMasterRecord,
  latestMasterRecordClaim,
  masterRecordCurrency,
  masterRecordMemberFormat,
  type MasterRecordManifest,
} from '@kf/documents';
import { createFabricDispatcher, createFabricTransactionalDispatcher } from '@kf/orchestrator';
import { loadProjectionDefinitions, project, type ProjectionResult } from '@kf/projections';
import {
  liveVerifications,
  projectionMembersOf,
} from '../../apps/api/src/routes/documents/master-record-projection-route.js';
import { registerObjectViewRoute } from '../../apps/api/src/routes/documents/object-view-route.js';
import type { DocumentRoutesOptions } from '../../apps/api/src/routes/documents/contracts.js';
import {
  bindContext,
  bindReader,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

/**
 * The Object View reads one neighbourhood, and says exactly what the whole claim says
 * (20260926110000, 20260926110100).
 *
 * `GET /objects/:id` no longer loads the manifest, the whole permitted set and the whole graph to
 * show one record. Each view here is compared with the reading it replaced — `project` over every
 * member of the claim and every edge, verification read live from the whole permitted set — and
 * must be the same Result, byte for byte, for every record in a neighbourhood built to exercise
 * backlinks, a second hop that must stay out, a withdrawn neighbour and a verified one, on both
 * ways the claim can be known current: from the database's record of writes, and by enumerating.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const DEFINITIONS = loadProjectionDefinitions(
  join(ROOT, 'generated', 'projections', 'knowledge-fabric.projections.json'),
);

let h: Harness;
let f: Fixtures;
const ids: Record<string, string> = {};

const atoms = () =>
  createDocumentActionAtoms({
    store: new InMemoryObjectStore(),
    parser: {
      async parse() {
        return undefined;
      },
    },
  });

function routeOptions(): DocumentRoutesOptions {
  return {
    pool: h.pool,
    projections: DEFINITIONS,
    identify: async () => ({
      actorId: f.performerId,
      actingRoleId: f.performerRoleId,
      organizationId: f.organizationId,
      maxClassification: 'restricted',
      authentication: { authenticatedAt: undefined, assuranceLevel: undefined, methods: [] },
    }),
    store: undefined,
    preflightInTransaction: async () => undefined,
    executeInTransaction: createFabricTransactionalDispatcher(atoms()),
  };
}

async function view(
  method: 'GET' | 'POST',
  id: string,
): Promise<{ status: number; body: { result: ProjectionResult }; digest: unknown }> {
  const app = Fastify({ logger: false });
  registerObjectViewRoute(app, routeOptions());
  await app.ready();
  try {
    const response = await app.inject({
      method,
      url: method === 'GET' ? `/objects/${id}` : `/objects/${id}/refresh`,
    });
    return {
      status: response.statusCode,
      body: response.json(),
      digest: response.headers['x-kf-projection-digest'],
    };
  } finally {
    await app.close();
  }
}

/** The reading the Object View made before 20260926110100: the whole claim, the whole graph. */
async function wholeClaimReading(id: string): Promise<ProjectionResult | 'refused'> {
  return withTransaction(h.pool, async (tx) => {
    await bindReader(tx, f);
    const record = await latestMasterRecord(tx, f.performerId, f.organizationId);
    const manifest = record!['manifest'] as MasterRecordManifest;
    const permitted = await enumeratePermittedSet(
      tx,
      f.performerId,
      f.organizationId,
      masterRecordMemberFormat(manifest),
    );
    try {
      return project({
        definition: DEFINITIONS.byId('object_view')!,
        parameters: { object_id: id },
        corpus: {
          personId: f.performerId,
          organizationId: f.organizationId,
          corpusDigest: String(record!['corpus_digest']),
          members: projectionMembersOf(manifest, liveVerifications(permitted)),
        },
        graph: await enumerateRelevanceGraph(tx),
      });
    } catch {
      return 'refused';
    }
  });
}

async function basis(): Promise<string> {
  return withTransaction(h.pool, async (tx) => {
    await bindReader(tx, f);
    const claim = await latestMasterRecordClaim(tx, f.performerId, f.organizationId);
    const currency = await masterRecordCurrency(
      tx,
      { personId: f.performerId, organizationId: f.organizationId },
      claim!,
    );
    return currency.current ? currency.basis : 'stale';
  });
}

async function relate(tx: Tx, type: string, source: string, target: string): Promise<void> {
  await tx.query(
    `insert into core.relation (relation_type, source_id, target_id, created_by)
     values ($1, $2, $3, $4)`,
    [type, source, target, f.performerId],
  );
}

async function everyViewMatches(): Promise<void> {
  const anchors = [...Object.values(ids), f.performerId];
  let compared = 0;
  for (const id of anchors) {
    const reference = await wholeClaimReading(id);
    const scoped = await view('GET', id);
    if (reference === 'refused') {
      expect(scoped.status, id).toBe(404);
      continue;
    }
    expect(scoped.status, `${id}: ${JSON.stringify(scoped.body)}`).toBe(200);
    expect(scoped.body.result, id).toEqual(reference);
    expect(JSON.stringify(scoped.body.result), id).toBe(JSON.stringify(reference));
    expect(scoped.digest).toBe(reference.projectionDigest);
    compared += 1;
  }
  expect(compared).toBeGreaterThanOrEqual(5);
}

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  for (const name of ['anchor', 'next', 'back', 'twoHops', 'unrelated', 'leaving']) {
    ids[name] = await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: `Scoped view ${name}`,
      createdBy: f.performerId,
    });
  }
  await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f, f.performerId);
    await relate(tx, 'supersedes', ids['anchor']!, ids['next']!);
    await relate(tx, 'supersedes', ids['back']!, ids['anchor']!);
    await relate(tx, 'supersedes', ids['next']!, ids['twoHops']!);
    await relate(tx, 'supersedes', ids['anchor']!, ids['leaving']!);
    await relate(tx, 'produces', f.performerId, ids['anchor']!);
  });
  // First claim, then one neighbour leaves the organization, then the claim is refreshed through
  // the view: the second claim carries `leaving` as withdrawn.
  expect((await view('POST', ids['anchor']!)).status).toBe(200);
  await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f, f.performerId);
    await tx.query(
      `update core.object set organization_id = $2, row_version = row_version + 1 where id = $1`,
      [ids['leaving'], randomUUID()],
    );
  });
  expect((await view('GET', ids['anchor']!)).status).toBe(409);
  expect((await view('POST', ids['anchor']!)).status).toBe(200);
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe('the Object View over one neighbourhood', () => {
  it('knows a just-refreshed claim is current from the record of writes alone', async () => {
    expect(await basis()).toBe('recorded');
    const manifest = await withTransaction(h.pool, async (tx) => {
      await bindReader(tx, f);
      return (await latestMasterRecord(tx, f.performerId, f.organizationId))![
        'manifest'
      ] as MasterRecordManifest;
    });
    expect(manifest.withdrawn.map((m) => m.objectId)).toContain(ids['leaving']);
  });

  it('gives the whole-claim Result for every record, when known current from the record', async () => {
    expect(await basis()).toBe('recorded');
    await everyViewMatches();
    expect(await basis(), 'reading wrote nothing').toBe('recorded');
  }, 120_000);

  it('reads a verification live, and it moves nothing the record of writes vouches for', async () => {
    const verify = createFabricDispatcher(h.pool, atoms());
    const outcome = await verify({
      actionType: 'verify_record',
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      targetIds: [ids['next']!],
      organizationId: f.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `scoped-verify-${randomUUID()}`,
      reason: 'read it against the source',
      payload: { basis: 'reviewed_individually' },
    });
    expect(outcome.status).toBe('applied');
    // Verification is not part of the corpus (KF-SAS-RQ-228): the claim is still vouched for,
    // and the view shows the new label because it reads it live.
    expect(await basis()).toBe('recorded');
    await everyViewMatches();
    const next = await view('GET', ids['anchor']!);
    const shown = next.body.result.sections[1]!.members.find((m) => m.objectId === ids['next']);
    expect(shown?.verification).toMatchObject({ verified: true });
  }, 120_000);

  it('gives the same Result when a write in the organization makes it enumerate', async () => {
    // A write the compilation did not see, in this organization, to a record this reader's
    // corpus does not depend on: the record of writes cannot tell, so currency is decided by
    // enumerating — and the claim is still current.
    await withTransaction(h.adminPool, (tx) =>
      tx.query(`insert into content.master_record_input_write (organization_id) values ($1)`, [
        f.organizationId,
      ]),
    );
    expect(await basis()).toBe('enumerated');
    await everyViewMatches();
    // The refresh compiles, reuses the unchanged claim, and records that it looked.
    expect((await view('POST', ids['anchor']!)).status).toBe(200);
    expect(await basis()).toBe('recorded');
  }, 120_000);

  it('still answers 409 when the corpus moved, and the refresh brings the shortcut back', async () => {
    await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Arrived after the claim',
      createdBy: f.performerId,
    });
    expect(await basis()).toBe('stale');
    expect((await view('GET', ids['anchor']!)).status).toBe(409);
    expect((await view('POST', ids['anchor']!)).status).toBe(200);
    expect(await basis()).toBe('recorded');
    await everyViewMatches();
  }, 120_000);

  it('does not vouch after a catalog change, a passed validity boundary, or an unseen write', async () => {
    expect(await basis()).toBe('recorded');
    const latestCurrency = async (): Promise<string> =>
      (
        await withTransaction(h.adminPool, (tx) =>
          tx.one<{ id: string }>(
            `select id from content.master_record_currency order by recorded_at desc, id desc limit 1`,
          ),
        )
      ).id;
    const currency = await latestCurrency();

    // Another organization's write does not touch this one; an unbound one touches every one.
    await withTransaction(h.adminPool, (tx) =>
      tx.query(`insert into content.master_record_input_write (organization_id) values ($1)`, [
        randomUUID(),
      ]),
    );
    expect(await basis()).toBe('recorded');
    await withTransaction(h.adminPool, (tx) =>
      tx.query(`insert into content.master_record_input_write (organization_id) values (null)`),
    );
    expect(await basis()).toBe('enumerated');

    expect((await view('POST', ids['anchor']!)).status).toBe(200);
    // The corpus did not move, so the refresh reused the claim — and still recorded that it looked.
    expect(await latestCurrency()).not.toBe(currency);
    expect(await basis()).toBe('recorded');
    await withTransaction(h.adminPool, (tx) =>
      tx.query(
        `update content.master_record_currency set valid_until = recorded_at + interval '1 microsecond'
          where id = (select id from content.master_record_currency
                       order by recorded_at desc, id desc limit 1)`,
      ),
    );
    expect(await basis(), 'a grant started or ended since').toBe('enumerated');

    expect((await view('POST', ids['anchor']!)).status).toBe(200);
    expect(await basis()).toBe('recorded');
    await withTransaction(h.adminPool, (tx) =>
      tx.query(
        `create function content.a_later_migration() returns int language sql as 'select 1'`,
      ),
    );
    expect(await basis(), 'the catalog a reading depends on changed').toBe('enumerated');
  }, 120_000);
});

describe('the member budget over a neighbourhood', () => {
  it('refuses a neighbourhood larger than the budget by counting, with 413', async () => {
    const definition = DEFINITIONS.byId('object_view')!;
    const app = Fastify({ logger: false });
    registerObjectViewRoute(app, {
      ...routeOptions(),
      projections: {
        ...DEFINITIONS,
        byId: (id: string) =>
          id === 'object_view'
            ? { ...definition, budgets: { ...definition.budgets, maxMembers: 2 } }
            : DEFINITIONS.byId(id),
      },
    });
    await app.ready();
    try {
      const response = await app.inject({ method: 'GET', url: `/objects/${ids['anchor']}` });
      expect(response.statusCode, response.body).toBe(413);
      expect(response.json()).toMatchObject({ reason: 'budget_exceeded' });
      // The same budget is not a ceiling on the corpus: a record with a small neighbourhood
      // is served although the corpus is far larger than two.
      const small = await app.inject({ method: 'GET', url: `/objects/${ids['unrelated']}` });
      expect([200, 409]).toContain(small.statusCode);
    } finally {
      await app.close();
    }
  });
});

describe('a master-record item is a member of its manifest (20260926110000)', () => {
  it('refuses an item the manifest does not list, once per statement', async () => {
    const claim = await withTransaction(h.pool, async (tx) => {
      await bindReader(tx, f);
      return (await latestMasterRecordClaim(tx, f.performerId, f.organizationId))!;
    });
    // A record the claim does not list: it arrived after the claim.
    const stranger = await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Not in the claim',
      createdBy: f.performerId,
    });
    const plant = (disableGuard: boolean) =>
      withTransaction(h.adminPool, async (tx) => {
        if (disableGuard) {
          await tx.query(
            'alter table content.master_record_item disable trigger master_record_item_matches_manifest',
          );
        }
        await tx.query(
          `insert into content.master_record_item
             (master_record_id, object_id, object_type, title, classification, content_digest,
              item_state, content_payload)
           values ($1, $2, 'decision_record', 'Planted', 'internal', $3, 'included', '{}')`,
          [claim.id, stranger, 'f'.repeat(64)],
        );
        // Never keep what was planted: this only asks whether the insert was accepted.
        throw new Error('planted item accepted');
      });
    await expect(plant(false)).rejects.toThrow(/is not a member of the manifest/);
    // Falsified: without the trigger the same statement is accepted (and rolled back here).
    await expect(plant(true)).rejects.toThrow(/planted item accepted/);
  });
});

describe('what the record of writes covers', () => {
  it('notes a write to every table in the governed schemas, or names why not', async () => {
    const uncovered = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ table: string }>(
        `select format('%I.%I', n.nspname, c.relname) as table
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'p')
            and n.nspname in ('content', 'core', 'engineering', 'finance', 'ml', 'org', 'product',
                              'quality', 'registry', 'secure_object', 'work')
            and not exists (select 1 from pg_trigger t
                             where t.tgrelid = c.oid and t.tgname = 'zz_master_record_input_written')
            and not exists (select 1 from content.master_record_input_exemption e
                             where e.table_name = format('%I.%I', n.nspname, c.relname))
          order by 1`,
      ),
    );
    expect(uncovered).toEqual([]);
  });

  it('exempts only tables that no read policy of a noted table, nor its functions, reads', async () => {
    const dependents = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ exempt: string; policy: string }>(
        `with exempt as (
           select e.table_name, e.table_name::regclass as oid
             from content.master_record_input_exemption e
         ),
         noted as (
           select t.tgrelid as oid from pg_trigger t
            where t.tgname = 'zz_master_record_input_written'
         ),
         policies as (
           select p.oid, p.polrelid, p.polname from pg_policy p
            where p.polrelid in (select oid from noted)
         )
         select exempt.table_name as exempt,
                policies.polrelid::regclass::text || '.' || policies.polname as policy
           from policies
           join pg_depend d on d.classid = 'pg_policy'::regclass and d.objid = policies.oid
           join exempt on d.refclassid = 'pg_class'::regclass and d.refobjid = exempt.oid
         union
         select exempt.table_name,
                policies.polrelid::regclass::text || '.' || policies.polname || ' via ' ||
                f.oid::regprocedure::text
           from policies
           join pg_depend d on d.classid = 'pg_policy'::regclass and d.objid = policies.oid
                           and d.refclassid = 'pg_proc'::regclass
           join pg_proc f on f.oid = d.refobjid
           join exempt on f.prosrc ~* ('\\m' || replace(exempt.table_name, '.', '\\.') || '\\M')
         order by 1, 2`,
      ),
    );
    expect(dependents).toEqual([]);
  });

  it('pins the exemption list', async () => {
    const exempt = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ table_name: string }>(
        'select table_name from content.master_record_input_exemption order by table_name',
      ),
    );
    expect(exempt.map((row) => row.table_name)).toEqual([
      'content.master_record',
      'content.master_record_currency',
      'content.master_record_delivery_receipt',
      'content.master_record_input_exemption',
      'content.master_record_input_write',
      'content.master_record_item',
      'content.master_record_link',
      'content.master_record_link_access',
      'content.master_record_link_revocation',
      'content.master_record_withholding',
      // ADR 0040 (20261007100000): decisions about trust and proposals, read by no permitted set.
      'core.act_proposal',
      'core.act_proposal_resolution',
      'core.action',
      'core.action_migration019_legacy',
      'core.approval',
      'core.audit_chain_head',
      'core.audit_checkpoint',
      'core.audit_event',
      'core.context_seal_key',
      'core.migration030_rollback_state',
      'core.object_verification',
      'core.outbox',
      'core.principal_attestation',
      'core.relation',
      'core.snapshot',
      'core.verification_policy',
      'core.write_guard_exemption',
      'registry.identifier_allocation',
      'registry.identifier_sequence',
    ]);
  });

  it('lets no application role read the write log or write a currency row directly', async () => {
    const grants = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ log: boolean; insert: boolean; update: boolean }>(
        `select has_table_privilege('kf_app', 'content.master_record_input_write', 'select') as log,
                has_table_privilege('kf_app', 'content.master_record_currency', 'insert') as insert,
                has_table_privilege('kf_app', 'content.master_record_currency', 'update') as update`,
      ),
    );
    expect(grants).toEqual({ log: false, insert: false, update: false });
  });
});
