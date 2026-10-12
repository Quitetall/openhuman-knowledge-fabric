import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryObjectStore } from '@kf/artifacts';
import { attestationFor, withTransaction, type Tx } from '@kf/database';
import {
  assertPermissionSetInvariant,
  corpusDigest,
  createDocumentActionAtoms,
  enumeratePermittedSet,
  latestMasterRecordClaim,
  masterRecordCurrency,
  masterRecordMemberFormat,
  type MasterRecordManifest,
} from '@kf/documents';
import { createFabricDispatcher, createFabricTransactionalDispatcher } from '@kf/orchestrator';
import { loadProjectionDefinitions } from '@kf/projections';
import type { DocumentRoutesOptions } from '../../apps/api/src/routes/documents/contracts.js';
import { registerMasterRecordProjectionRoute } from '../../apps/api/src/routes/documents/master-record-projection-route.js';
import { registerMasterRecordRoute } from '../../apps/api/src/routes/documents/master-record-route.js';
import { registerObjectViewRoute } from '../../apps/api/src/routes/documents/object-view-route.js';
import {
  bindContext,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';
import { enrolPerson } from './people.js';

/**
 * A write names the records it can move, and a reader re-checks only those (20261011300000;
 * SAS §100.42, §100.43).
 *
 * Three things are held here. What each kind of write records — the record it names, or nothing,
 * which still makes every reader recount. The plan that decides it, derived from the catalog, with
 * each of its rules planted against and seen to give way. And what a reader of a narrow scope is
 * shown while writes reach, and stop reaching, a record outside their grants: never that record,
 * not after a write to it, not after a grant to it is revoked — the shortcut decides how much is
 * read again, never what may be seen. The verdict of every re-check is compared with the whole
 * comparison it replaces.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const DEFINITIONS = loadProjectionDefinitions(
  join(ROOT, 'generated', 'projections', 'knowledge-fabric.projections.json'),
);

let h: Harness;
let f: Fixtures;
let reader: { readonly personId: string; readonly roleId: string };
let granted: string;
let secret: string;

const atoms = () =>
  createDocumentActionAtoms({
    store: new InMemoryObjectStore(),
    parser: {
      async parse() {
        return undefined;
      },
    },
  });

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  // A narrow reader: their assignment covers the organization's public records only, so every
  // `internal` record is outside their grants unless granted to them by name.
  const enrolled = await enrolPerson(h.adminPool, f, {
    name: 'Narrow Reader',
    assignments: [{ role: 'performer', classificationCeiling: 'public' }],
  });
  reader = { personId: enrolled.personId, roleId: enrolled.assignmentIds[0]! };
  const make = (title: string) =>
    createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title,
      createdBy: f.reviewerId,
    });
  granted = await make('Granted to the narrow reader');
  secret = await make('Outside the narrow reader’s grants');
  await grant(granted);
  expect((await compile()).status).toBe('applied');
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

/** Bind as the narrow reader, as a request of theirs would. */
async function bindAsReader(tx: Tx): Promise<void> {
  const principal = {
    actorId: reader.personId,
    actingRoleId: reader.roleId,
    organizationId: f.organizationId,
    maxClassification: 'restricted',
  };
  await tx.query('select core.bind_principal($1, $2, $3, $4, $5)', [
    principal.actorId,
    principal.actingRoleId,
    principal.organizationId,
    principal.maxClassification,
    (await attestationFor(tx, principal)) ?? null,
  ]);
}

async function compile(): Promise<{ status: string }> {
  return createFabricDispatcher(
    h.pool,
    atoms(),
  )({
    actionType: 'compile_master_record',
    actorId: reader.personId,
    actingRoleId: reader.roleId,
    targetIds: [reader.personId],
    organizationId: f.organizationId,
    maxClassification: 'restricted',
    idempotencyKey: `delta-${randomUUID()}`,
  });
}

/** An object grant to the narrow reader, by the reviewer. Returns the grant. */
async function grant(objectId: string): Promise<string> {
  return withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f, f.reviewerId);
    const action = f.clearanceActionId;
    return (
      await tx.one<{ id: string }>(
        `insert into org.access_grant
           (organization_id, principal_kind, principal_id, capability, scope_object_id,
            granted_by, granted_by_action, reason)
         values ($1, 'person', $2, 'read', $3, $4, $5, 'delta test grant')
         returning id`,
        [f.organizationId, reader.personId, objectId, f.reviewerId, action],
      )
    ).id;
  });
}

async function revoke(grantId: string, options: { unrecorded?: boolean } = {}): Promise<void> {
  await withTransaction(h.adminPool, async (tx) => {
    // Falsification only: a revocation the record of writes never sees.
    if (options.unrecorded === true)
      await tx.query("set local session_replication_role = 'replica'");
    await bindContext(tx, f, f.reviewerId);
    await tx.query(
      `update org.access_grant
          set revoked_at = now(), revoked_by = $2, revoked_by_action = $3,
              revocation_reason = 'delta test revocation'
        where id = $1`,
      [grantId, f.reviewerId, f.clearanceActionId],
    );
  });
}

/** An edit of a record by a bound person of the organization, on the application's login. */
async function edit(objectId: string, title: string): Promise<string> {
  return withTransaction(h.pool, async (tx) => {
    await bindContext(tx, f, f.reviewerId);
    await tx.query(
      'update core.object set title = $2, row_version = row_version + 1 where id = $1',
      [objectId, title],
    );
    return (await tx.one<{ xact: string }>('select pg_current_xact_id()::text as xact')).xact;
  });
}

/** What one transaction recorded: the records and versions it named, or `unconfined`. */
async function recorded(xact: string): Promise<string[]> {
  const rows = await withTransaction(h.adminPool, (tx) =>
    tx.query<{ named: string }>(
      `select coalesce(object_id::text, 'version:' || version_id::text, 'unconfined') as named
         from content.master_record_input_write where xact = $1::xid8 order by 1`,
      [xact],
    ),
  );
  return rows.map((row) => row.named);
}

/** The reader's verdict, and the verdict a whole comparison gives on the same database. */
async function verdicts(): Promise<{
  basis: string;
  digest: string | undefined;
  enumerated: string | undefined;
}> {
  return withTransaction(h.pool, async (tx) => {
    await bindAsReader(tx);
    const claim = (await latestMasterRecordClaim(tx, reader.personId, f.organizationId))!;
    const currency = await masterRecordCurrency(
      tx,
      { personId: reader.personId, organizationId: f.organizationId },
      claim,
    );
    const manifest = (
      await tx.one<{ manifest: MasterRecordManifest }>(
        'select manifest from content.master_record where id = $1',
        [claim.id],
      )
    ).manifest;
    const permitted = await enumeratePermittedSet(
      tx,
      reader.personId,
      f.organizationId,
      masterRecordMemberFormat(manifest),
    );
    let enumerated: string | undefined;
    try {
      assertPermissionSetInvariant(manifest, permitted);
    } catch {
      enumerated = corpusDigest(permitted, manifest.withdrawn);
    }
    return {
      basis: currency.current ? currency.basis : 'stale',
      digest: currency.current ? undefined : currency.currentCorpusDigest,
      enumerated,
    };
  });
}

function routes(): FastifyInstance {
  const options: DocumentRoutesOptions = {
    pool: h.pool,
    projections: DEFINITIONS,
    identify: async () => ({
      actorId: reader.personId,
      actingRoleId: reader.roleId,
      organizationId: f.organizationId,
      maxClassification: 'restricted',
      authentication: { authenticatedAt: undefined, assuranceLevel: undefined, methods: [] },
    }),
    store: undefined,
    preflightInTransaction: async () => undefined,
    executeInTransaction: createFabricTransactionalDispatcher(atoms()),
  };
  const app = Fastify({ logger: false });
  registerMasterRecordRoute(app, options);
  registerMasterRecordProjectionRoute(app, options);
  registerObjectViewRoute(app, options);
  return app;
}

/**
 * Every read surface over the reader's claim, and where `objectId` is shown as an included member.
 * (A record the reader's claim once included and no longer does is carried as WITHDRAWN — that is
 * the record of what they were told, ADR 0013 — and is never shown as included.) `mentioned` names
 * the surfaces whose answer names the record at all.
 */
async function surfaces(objectId: string): Promise<{
  record: number;
  projection: number;
  view: number;
  included: string[];
  mentioned: string[];
}> {
  const app = routes();
  await app.ready();
  try {
    const record = await app.inject({ method: 'GET', url: '/master-record' });
    const projection = await app.inject({
      method: 'GET',
      url: '/master-record/projections/raw_corpus',
    });
    const view = await app.inject({ method: 'GET', url: `/objects/${objectId}` });
    const included: string[] = [];
    if (record.statusCode === 200) {
      const items = (record.json() as { items: { object_id: string; item_state: string }[] }).items;
      if (items.some((i) => i.object_id === objectId && i.item_state === 'included')) {
        included.push('record');
      }
    }
    const projected = (body: unknown): boolean =>
      (
        body as { sections?: { members: { objectId: string; itemState: string }[] }[] }
      ).sections?.some((section) =>
        section.members.some((m) => m.objectId === objectId && m.itemState === 'included'),
      ) ?? false;
    if (projection.statusCode === 200 && projected(projection.json())) included.push('projection');
    if (view.statusCode === 200 && projected((view.json() as { result: unknown }).result)) {
      included.push('view');
    }
    const mentioned = [
      ['record', record.body],
      ['projection', projection.body],
      ['view', view.body],
    ]
      .filter(([, body]) => body!.includes(objectId))
      .map(([name]) => name!);
    return {
      record: record.statusCode,
      projection: projection.statusCode,
      view: view.statusCode,
      included,
      mentioned,
    };
  } finally {
    await app.close();
  }
}

describe('what a write records', () => {
  it('names the record an edit touches, and nothing else', async () => {
    const xact = await edit(granted, 'Granted, edited');
    expect(await recorded(xact)).toEqual([granted]);
  });

  it('names nothing for a reclassification, a write row security reads', async () => {
    const xact = await withTransaction(h.pool, async (tx) => {
      await bindContext(tx, f, f.reviewerId);
      await tx.query(
        `update core.object set classification = 'confidential', row_version = row_version + 1
          where id = $1`,
        [secret],
      );
      await tx.query(
        `update core.object set classification = 'internal', row_version = row_version + 1
          where id = $1`,
        [secret],
      );
      return (await tx.one<{ xact: string }>('select pg_current_xact_id()::text as xact')).xact;
    });
    expect(await recorded(xact)).toContain('unconfined');
  });

  it('names nothing for a write to a role assignment’s envelope, which the coverage reads', async () => {
    const xact = await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f, f.reviewerId);
      await tx.query(
        `update core.object set title = title || ' ', row_version = row_version + 1 where id = $1`,
        [reader.roleId],
      );
      return (await tx.one<{ xact: string }>('select pg_current_xact_id()::text as xact')).xact;
    });
    expect(await recorded(xact)).toEqual(['unconfined']);
  });

  it('names an object grant’s record, and nothing for an organization-wide grant', async () => {
    const xacts = await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f, f.reviewerId);
      const insert = (scope: string) =>
        tx.query(
          `insert into org.access_grant
             (organization_id, principal_kind, principal_id, capability, scope_object_id,
              granted_by, granted_by_action, reason)
           values ($1, 'person', $2, 'read', $3, $4, $5, 'probe')`,
          [f.organizationId, f.performerId, scope, f.reviewerId, f.clearanceActionId],
        );
      await insert(granted);
      const one = (await tx.one<{ xact: string }>('select pg_current_xact_id()::text as xact'))
        .xact;
      const names = await tx.query<{ named: string }>(
        `select coalesce(object_id::text, 'unconfined') as named
           from content.master_record_input_write where xact = $1::xid8`,
        [one],
      );
      expect(names.map((row) => row.named)).toContain(granted);
      expect(names.map((row) => row.named)).not.toContain('unconfined');
      await insert(f.organizationId);
      return one;
    });
    expect(await recorded(xacts)).toContain('unconfined');
  });

  it('names an artifact version, and a reading resolves it to the records that hold it', async () => {
    const artifact = await createObject(h.adminPool, f, {
      type: 'artifact',
      domain: 'artifact',
      state: 'draft',
      title: 'Versioned for the delta test',
      createdBy: f.reviewerId,
    });
    const { version, xact } = await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f, f.reviewerId);
      await tx.query(
        `insert into content.artifact (id, artifact_kind, source_system)
         values ($1, 'document', 'document_system')`,
        [artifact],
      );
      const v = await tx.one<{ id: string }>(
        `insert into content.artifact_version
           (artifact_id, version_no, revision_label, sha256, size_bytes, media_type, created_by)
         values ($1, 1, 'R1', repeat('a', 64), 1, 'text/plain', $2) returning id`,
        [artifact, f.reviewerId],
      );
      return {
        version: v.id,
        xact: (await tx.one<{ xact: string }>('select pg_current_xact_id()::text as xact')).xact,
      };
    });
    expect(await recorded(xact)).toEqual(expect.arrayContaining([artifact, `version:${version}`]));
    const locatorXact = await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f, f.reviewerId);
      await tx.query(
        `insert into content.external_locator (version_id, system, external_id, uri, authority)
         values ($1, 'document_system', 'ext-1', 'https://example.invalid/doc', 'authoritative')`,
        [version],
      );
      return (await tx.one<{ xact: string }>('select pg_current_xact_id()::text as xact')).xact;
    });
    expect(await recorded(locatorXact)).toEqual([`version:${version}`]);
    const holders = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ id: string }>(
        'select content.master_record_objects_of_versions(array[$1]::uuid[]) as id',
        [version],
      ),
    );
    expect(holders.map((row) => row.id)).toContain(artifact);
  });
});

describe('the plan, derived from the catalog', () => {
  const plan = () =>
    withTransaction(h.adminPool, (tx) =>
      tx.query<{
        table_name: string;
        mode: string;
        object_columns: string[];
        version_columns: string[];
        guarded_columns: string[];
        reason: string;
      }>('select * from content.master_record_input_plan()'),
    );

  it('confines exactly these tables', async () => {
    const confined = (await plan()).filter((row) => row.mode === 'confined');
    expect(confined.map((row) => row.table_name).sort()).toEqual(CONFINED);
  });

  it('applies the plan: three naming triggers where confined, the old one everywhere else', async () => {
    const triggers = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ table_name: string; tgname: string; tgtype: number; args: string }>(
        `select format('%I.%I', n.nspname, c.relname) as table_name, t.tgname, t.tgtype,
                encode(t.tgargs, 'escape') as args
           from pg_trigger t join pg_class c on c.oid = t.tgrelid
           join pg_namespace n on n.oid = c.relnamespace
          where t.tgname like 'zz_master_record_input_%'`,
      ),
    );
    const on = (table: string) => triggers.filter((t) => t.table_name === table);
    // tgtype bits: 4 insert, 8 delete, 16 update, 32 truncate.
    for (const row of await plan()) {
      const mine = on(row.table_name);
      if (row.mode === 'confined') {
        expect(mine.map((t) => t.tgname).sort(), row.table_name).toEqual([
          'zz_master_record_input_deleted',
          'zz_master_record_input_inserted',
          'zz_master_record_input_updated',
          'zz_master_record_input_written',
        ]);
        expect(mine.find((t) => t.tgname === 'zz_master_record_input_written')!.tgtype & 60).toBe(
          32,
        );
        const args = mine.find((t) => t.tgname === 'zz_master_record_input_inserted')!.args;
        expect(args.split('\\000')[0], row.table_name).toBe(row.object_columns.join(','));
      } else {
        expect(
          mine.map((t) => t.tgname),
          row.table_name,
        ).toEqual(['zz_master_record_input_written']);
        expect(mine[0]!.tgtype & 60, row.table_name).toBe(60);
      }
    }
  });

  it('reads of the envelope by the coverage are the ones a role assignment write names nothing for', async () => {
    const columns = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ attname: string }>(
        `select distinct a.attname
           from pg_rewrite rw
           join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = rw.oid
           join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
          where rw.ev_class = 'org.effective_access_grant'::regclass
            and d.refobjid = 'core.object'::regclass
          order by 1`,
      ),
    );
    // id and organization_id are guarded on every envelope; lifecycle_state is read only for a role
    // assignment's (and a project's organization), which `unconfined_when` names nothing for.
    expect(columns.map((row) => row.attname)).toEqual(['id', 'lifecycle_state', 'organization_id']);
    const guarded = (await plan()).find((row) => row.table_name === 'core.object')!;
    expect(guarded.guarded_columns).toEqual(['classification', 'id', 'organization_id']);
  });

  it('guards only columns whose values can be compared', async () => {
    const incomparable = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ col: string }>(
        `select p.table_name || '.' || g.col as col
           from content.master_record_input_plan() p
           cross join lateral unnest(p.guarded_columns) as g(col)
           join pg_attribute a on a.attrelid = p.table_name::regclass and quote_ident(a.attname) = g.col
          where not exists (select 1 from pg_opclass o
                             where o.opcintype = a.atttypid and o.opcdefault
                               and o.opcmethod = (select oid from pg_am where amname = 'btree'))
            and a.atttypid not in (select oid from pg_type where typcategory = 'A')`,
      ),
    );
    expect(incomparable).toEqual([]);
  });

  /** Plant DDL, read the plan, and roll it all back. */
  const planted = (ddl: string) =>
    withTransaction(h.adminPool, async (tx) => {
      await tx.query(ddl);
      const rows = await tx.query<{ table_name: string; mode: string; reason: string }>(
        'select table_name, mode, reason from content.master_record_input_plan()',
      );
      throw Object.assign(new Error('planted'), { rows });
    }).catch((error: { rows?: { table_name: string; mode: string; reason: string }[] }) => {
      if (error.rows === undefined) throw error;
      return error.rows;
    });

  it('names nothing for a parent a policy reads without a foreign key to it', async () => {
    const before = (await plan()).find((row) => row.table_name === 'content.artifact')!;
    expect(before.mode).toBe('confined');
    const rows = await planted(
      `create table content.zz_planted_child (
         id uuid primary key references core.object (id), artifact uuid);
       alter table content.zz_planted_child enable row level security;
       create policy zz_planted_read on content.zz_planted_child for select
         using (exists (select 1 from content.artifact a where a.id = zz_planted_child.artifact));`,
    );
    expect(rows.find((row) => row.table_name === 'content.artifact')).toMatchObject({
      mode: 'unconfined',
      reason: 'read by a row-security policy of a table holding no foreign key to it',
    });
  });

  it('names nothing for a table a row-security policy reads inside a function', async () => {
    const rows = await planted(
      `create function content.zz_planted_visible(p uuid) returns boolean language sql stable
         as 'select exists (select 1 from content.observation o where o.id = p)';
       create table content.zz_planted_reader (
         id uuid primary key references core.object (id));
       alter table content.zz_planted_reader enable row level security;
       create policy zz_planted_read on content.zz_planted_reader for select
         using (content.zz_planted_visible(id));`,
    );
    expect(rows.find((row) => row.table_name === 'content.observation')).toMatchObject({
      mode: 'unconfined',
      reason: 'read inside a function a row-security policy calls',
    });
  });

  it('names nothing for a table that names no record', async () => {
    const rows = await planted(
      `create table content.zz_planted_loose (id uuid primary key, note text);
       alter table content.zz_planted_loose enable row level security;`,
    );
    expect(rows.find((row) => row.table_name === 'content.zz_planted_loose')).toMatchObject({
      mode: 'unconfined',
    });
  });
});

describe(
  'a narrow reader, while writes reach and stop reaching a record outside their grants',
  { timeout: 180_000 },
  () => {
    let secretGrant: string;

    it('a write to the record leaves the claim current by re-checking it, and the record unseen', async () => {
      expect((await compile()).status).toBe('applied');
      expect((await verdicts()).basis).toBe('recorded');
      await edit(secret, 'Outside the grants, edited');
      const verdict = await verdicts();
      expect(verdict).toEqual({ basis: 'rechecked', digest: undefined, enumerated: undefined });
      const seen = await surfaces(secret);
      expect(seen).toMatchObject({ record: 200, projection: 200, view: 404, mentioned: [] });
      expect(seen.included).toEqual([]);
    });

    it('a grant reaching it makes the claim stale at once, with the digest a recount gives', async () => {
      secretGrant = await grant(secret);
      const verdict = await verdicts();
      expect(verdict.basis).toBe('stale');
      expect(verdict.digest).toBe(verdict.enumerated);
      const seen = await surfaces(secret);
      expect(seen).toMatchObject({ record: 409, projection: 409, view: 409, mentioned: [] });
    });

    it('the refresh brings it into the claim, which is then current from the record', async () => {
      expect((await compile()).status).toBe('applied');
      expect((await verdicts()).basis).toBe('recorded');
      const seen = await surfaces(secret);
      expect(seen.record).toBe(200);
      expect(seen.included).toEqual(['record', 'projection', 'view']);
    });

    it('revoking the grant makes it stale, and no surface shows the record', async () => {
      await revoke(secretGrant);
      const verdict = await verdicts();
      expect(verdict.basis).toBe('stale');
      expect(verdict.digest).toBe(verdict.enumerated);
      const seen = await surfaces(secret);
      expect(seen).toMatchObject({ record: 409, projection: 409, view: 409, mentioned: [] });
    });

    it('after the refresh the record is gone, and a write to it changes nothing the reader sees', async () => {
      expect((await compile()).status).toBe('applied');
      await edit(secret, 'Outside the grants again');
      expect((await verdicts()).basis).toBe('rechecked');
      // Carried as withdrawn, as every claim carries what it once included; shown nowhere as included,
      // and the edit since is not shown: the withdrawn entry is the claim's, not a live read.
      const seen = await surfaces(secret);
      expect(seen).toMatchObject({ record: 200, projection: 200, included: [] });
      for (const surface of ['record', 'projection'] as const) {
        expect(seen.mentioned).toContain(surface);
      }
    });

    it('re-checks no more than its limit; beyond it the reader recounts', async () => {
      await edit(granted, 'Granted, edited again');
      const answer = await withTransaction(h.pool, async (tx) => {
        await bindAsReader(tx);
        const claim = (await latestMasterRecordClaim(tx, reader.personId, f.organizationId))!;
        // Two records were named since the claim: the edit just made, and the one before it.
        const within = await tx.query(
          'select objects from content.master_record_currency_delta($1, 2)',
          [claim.id],
        );
        const beyond = await tx.query(
          'select objects from content.master_record_currency_delta($1, 1)',
          [claim.id],
        );
        return { within: within.length, beyond: beyond.length };
      });
      expect(answer).toEqual({ within: 1, beyond: 0 });
    });
  },
);

describe('every re-checked verdict is the whole comparison’s', { timeout: 180_000 }, () => {
  /** As the reviewer, bound, on the owner's login: a fixture write. */
  const asOwner = (sql: string, params: unknown[]) =>
    withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f, f.reviewerId);
      await tx.query(sql, params);
    });
  /** As the reviewer, bound on the application's login under a recorded act. */
  const asReviewer = (sql: string, params: unknown[]) =>
    withTransaction(h.pool, async (tx) => {
      await bindContext(tx, f, f.reviewerId);
      await tx.query(sql, params);
    });
  const agrees = async (expected: 'recorded' | 'rechecked' | 'stale') => {
    const verdict = await verdicts();
    expect(verdict.basis).toBe(expected);
    expect(verdict.digest).toBe(verdict.enumerated);
  };
  let open: string;
  let excluded: string;
  let held: string;

  beforeAll(async () => {
    excluded = await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Granted, then excluded',
      createdBy: f.reviewerId,
    });
    await grant(excluded);
    held = await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Granted, then held',
      createdBy: f.reviewerId,
    });
    await grant(held);
  });

  it('an exclusion of a record from the reader, re-checked', async () => {
    expect((await compile()).status).toBe('applied');
    // Releasing one is an act of its own (release_person_entitlement_exclusion); placing one is
    // the write this needs, so the exclusion stays and the record stays out of the claims below.
    await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f, f.reviewerId);
      await tx.query(
        `insert into content.person_entitlement_exclusion
           (subject_id, organization_id, object_id, reason_class, reason, authorizer,
            created_by_action)
         values ($1, $2, $3, 'exclusion', 'delta agreement', $4, $5)`,
        [reader.personId, f.organizationId, excluded, f.reviewerId, f.clearanceActionId],
      );
    });
    await agrees('stale');
    expect((await compile()).status).toBe('applied');
    await agrees('recorded');
  });

  it('a hold on a record of the reader’s, re-checked', async () => {
    expect((await compile()).status).toBe('applied');
    // Releasing it would bring the corpus back to an earlier claim's, which a compilation reuses
    // rather than records anew (ADR 0013); a hold on its own record is the write this needs.
    await asOwner(
      `insert into core.retention_hold (object_id, reason, placed_by) values ($1, 'delta', $2)`,
      [held, f.reviewerId],
    );
    await agrees('stale');
    expect((await compile()).status).toBe('applied');
    await agrees('recorded');
  });

  it('a grant to somebody else, a record the reader cannot see, and an edge, each leave it current', async () => {
    expect((await compile()).status).toBe('applied');
    const grantOf = (scope: string) =>
      asReviewer(
        `insert into org.access_grant
           (organization_id, principal_kind, principal_id, capability, scope_object_id,
            granted_by, granted_by_action, reason)
         values ($1, 'person', $2, 'read', $3, $4, core.current_action_id(), 'somebody else')`,
        [f.organizationId, f.reviewerId, scope, f.reviewerId],
      );
    // On a record outside the reader's grants: it names that record, which they cannot see.
    await grantOf(secret);
    await agrees('rechecked');
    // On one inside them: a grant row is part of its record's payload (the walk reads every row
    // holding a key to it), so the reader's corpus moved, and the re-check says so.
    await grantOf(granted);
    await agrees('stale');
    expect((await compile()).status).toBe('applied');
    await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Internal, so outside the narrow reader’s public assignment',
      createdBy: f.reviewerId,
    });
    await agrees('rechecked');
    expect((await compile()).status).toBe('applied');
    await asReviewer(
      `insert into core.relation (relation_type, source_id, target_id, created_by)
       values ('supersedes', $1, $2, $3)`,
      [granted, secret, f.reviewerId],
    );
    await agrees('recorded');
  });

  it('a record the reader can see arriving, then changing, each re-checked to stale', async () => {
    expect((await compile()).status).toBe('applied');
    open = await withTransaction(h.pool, async (tx) => {
      await bindContext(tx, f, f.reviewerId);
      return (
        await tx.one<{ id: string }>(
          `insert into core.object
             (object_type, authority_domain, lifecycle_state, classification, retention_class,
              schema_version, organization_id, title, created_by, updated_by)
           values ('decision_record', 'engineering', 'draft', 'public', 'project_record', $1, $2,
                   'Public, so inside the narrow reader’s assignment', $3, $3)
           returning id`,
          [f.schemaVersion, f.organizationId, f.reviewerId],
        )
      ).id;
    });
    await agrees('stale');
    expect((await compile()).status).toBe('applied');
    await edit(open, 'Public, edited');
    await agrees('stale');
  });
});

describe(
  'falsified: without the record of writes or the re-check, the revoked record is served',
  { timeout: 180_000 },
  () => {
    it('a revocation the record never sees leaves the claim vouched for, and served', async () => {
      const regrant = await grant(secret);
      expect((await compile()).status).toBe('applied');
      expect((await verdicts()).basis).toBe('recorded');
      await revoke(regrant, { unrecorded: true });
      // The guard removed: the claim is "current" though the corpus moved, and the record leaks.
      const verdict = await verdicts();
      expect(verdict.basis).toBe('recorded');
      expect(verdict.enumerated).toBeDefined();
      const seen = await surfaces(secret);
      expect(seen.record).toBe(200);
      expect(seen.mentioned).toContain('record');
      // Put the database's word back: a recorded write, and the shortcut stands down.
      await edit(secret, 'Recorded again');
      expect((await verdicts()).basis).toBe('stale');
      expect((await surfaces(secret)).mentioned).toEqual([]);
    });

    it('a delta that trusts named writes without re-checking them serves the revoked record', async () => {
      const regrant = await grant(secret);
      expect((await compile()).status).toBe('applied');
      await revoke(regrant);
      expect((await surfaces(secret)).record).toBe(409);
      const original = await withTransaction(h.adminPool, (tx) =>
        tx.one<{ def: string }>(
          `select pg_get_functiondef('content.master_record_currency_delta(uuid, integer)'::regprocedure) as def`,
        ),
      );
      // The planted delta skips the catalog fingerprint (any DDL retires every currency row, which
      // would hide the leak) and answers "nothing to re-check" whenever writes only named records.
      const trusting = original.def
        .replace(
          /and currency\.schema_fingerprint = content\.master_record_schema_fingerprint\(\)/u,
          '',
        )
        .replace(/objects := coalesce\(v_objects, '\{\}'\);/u, "objects := '{}';");
      expect(trusting).not.toBe(original.def);
      await withTransaction(h.adminPool, (tx) => tx.query(trusting));
      try {
        const seen = await surfaces(secret);
        expect(seen.record).toBe(200);
        expect(seen.mentioned).toContain('record');
      } finally {
        await withTransaction(h.adminPool, (tx) => tx.query(original.def));
      }
    });
  },
);

describe('falsified: each guard of the triggers is what makes a write name nothing', () => {
  /**
   * Re-create core.object's update trigger with the arguments given, make `write` in the same
   * transaction, and return what the write recorded — then roll all of it back.
   */
  const withUpdateTrigger = (guarded: string, unconfinedWhen: string, write: string, id: string) =>
    withTransaction(h.adminPool, async (tx) => {
      await tx.query(
        `drop trigger zz_master_record_input_updated on core.object;
         create trigger zz_master_record_input_updated after update on core.object
         referencing old table as old_rows new table as new_rows for each statement
         execute function content.note_master_record_input_rows('id', '', '${guarded}', '${unconfinedWhen}')`,
      );
      await bindContext(tx, f, f.reviewerId);
      await tx.query(write, [id]);
      const rows = await tx.query<{ named: string }>(
        `select coalesce(object_id::text, 'unconfined') as named
           from content.master_record_input_write where xact = pg_current_xact_id() order by 1`,
      );
      throw Object.assign(new Error('rolled back'), { rows: rows.map((row) => row.named) });
    }).catch((error: { rows?: string[] }) => {
      if (error.rows === undefined) throw error;
      return error.rows;
    });
  const reclassify = `update core.object set classification = 'confidential',
                        row_version = row_version + 1 where id = $1`;
  const retitle = `update core.object set title = title || ' ', row_version = row_version + 1
                    where id = $1`;
  const asInstalled = {
    guarded: 'classification,id,organization_id',
    when: "r.object_type = ''role_assignment''",
  };

  it('without the guarded columns, a reclassification names only its record', async () => {
    expect(
      await withUpdateTrigger(asInstalled.guarded, asInstalled.when, reclassify, secret),
    ).toEqual(['unconfined']);
    expect(await withUpdateTrigger('', asInstalled.when, reclassify, secret)).toEqual([secret]);
  });

  it('without the role-assignment predicate, a write to one names only its envelope', async () => {
    expect(
      await withUpdateTrigger(asInstalled.guarded, asInstalled.when, retitle, reader.roleId),
    ).toEqual(['unconfined']);
    expect(await withUpdateTrigger(asInstalled.guarded, '', retitle, reader.roleId)).toEqual([
      reader.roleId,
    ]);
  });
});

/** Pinned: every table whose writes name records. A change here is a change to the argument. */
const CONFINED = [
  'content.adr_decision_body',
  'content.artifact',
  'content.artifact_relationship',
  'content.artifact_version',
  'content.document_subject',
  'content.external_locator',
  'content.observation',
  'content.person_entitlement_exclusion',
  'content.typed_binding',
  'core.object',
  'core.retention_hold',
  'engineering.change_item',
  'engineering.decision_alternative',
  'engineering.requirement',
  'engineering.risk',
  'engineering.risk_control',
  'engineering.test',
  'engineering.test_definition',
  'engineering.test_execution',
  'engineering.verification_link',
  'finance.invoice',
  'finance.payment',
  'ml.promotion_authority_decision',
  'org.access_demand',
  'org.access_grant',
  'org.engagement',
  'org.external_identity',
  'org.person',
  'org.qualification_evidence_submission',
  'org.qualification_pack',
  'org.qualification_record',
  'product.baseline',
  'product.baseline_item',
  'product.configuration_item',
  'product.effectivity',
  'product.interface_conformance',
  'product.interface_contract',
  'product.physical_binding',
  'product.product_system',
  'product.release',
  'product.release_item',
  'quality.calibration',
  'quality.capa',
  'quality.complaint',
  'quality.controlled_document',
  'quality.equipment',
  'quality.federated_link',
  'quality.federated_reference',
  'quality.nonconformity',
  'quality.supplier',
  'quality.supplier_qualification',
  'quality.training_record',
  'work.acceptance_record',
  'work.deliverable',
  'work.initiative_project',
  'work.milestone',
  'work.warrant',
  'work.work_execution',
  'work.work_order',
  'work.work_order_amendment',
  'work.work_package',
];
