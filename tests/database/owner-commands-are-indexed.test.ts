import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTransaction } from '@kf/database';
import { search } from '@kf/search';
import { runBootstrap } from '../../apps/api/src/admin/bootstrap-organization.js';
import { runDeclareServiceActor } from '../../apps/api/src/admin/declare-service-actor.js';
import { runGrantAuthority } from '../../apps/api/src/admin/grant-authority.js';
import { drainOutbox } from '../../apps/worker/src/outbox.js';
import { aYearFromNow, seedFixtures, startHarness, type Harness } from './harness.js';

/**
 * A record an owner command writes is found by search without a rebuild (SAS §100.68,
 * KF-SAS-RQ-121).
 *
 * The owner's commands record their acts by hand, on the owner credential, and used to write no
 * outbox row, so the organization, person and role assignment they created were invisible to
 * search until `select search.rebuild();`. Since 20261011200000 the database emits the row: an
 * act's audit link emits `kf.<action_type>` over the ledger row's targets, and a record written
 * under an act and not among those targets gets a `kf.record_written` row at commit.
 *
 * Nothing here calls `search.index_object` or `search.rebuild`: the outbox is drained exactly as
 * the worker drains it, and whatever the drain does not index is not found.
 */

let harness: Harness;
let since: Date;

beforeAll(async () => {
  harness = await startHarness({ realisticOwner: true });
  await seedFixtures(harness.adminPool);
  since = (
    await withTransaction(harness.adminPool, (tx) =>
      tx.one<{ at: Date }>('select clock_timestamp() as at'),
    )
  ).at;
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

async function drainAll(): Promise<void> {
  for (let round = 0; round < 50; round += 1) {
    const result = await drainOutbox(harness.adminPool);
    expect(result.failures).toEqual([]);
    if (result.delivered === 0) return;
  }
  throw new Error('the outbox did not drain in 50 rounds');
}

async function indexed(ids: readonly string[]): Promise<string[]> {
  return withTransaction(harness.adminPool, async (tx) => {
    const rows = await tx.query<{ object_id: string }>(
      'select object_id from search.document where object_id = any($1::uuid[]) order by object_id',
      [[...ids]],
    );
    return rows.map((row) => row.object_id);
  });
}

describe('records an owner command writes', () => {
  it('are found by search after the outbox drains, without a rebuild', async () => {
    const marker = randomUUID().slice(0, 8);
    const legalName = `Quillfeather Bindery ${marker}`;
    const personName = `Ottoline Varga ${marker}`;
    const created = await runBootstrap(harness.adminPool, {
      legalName,
      personName,
      organizationKind: 'company',
      organizationId: '',
    });
    const granted = await runGrantAuthority(harness.adminPool, {
      validTo: aYearFromNow(),
      personId: created.personId,
      organizationId: created.organizationId,
      roleId: 'project_owner',
      classification: 'restricted',
      grantedBy: created.personId,
      reason: 'founding grant: the first authority in a new organization is the founder’s own',
    });
    const declared = await runDeclareServiceActor(harness.adminPool, {
      validTo: aYearFromNow(),
      organizationId: created.organizationId,
      name: `index-steward-${marker}`,
      roleId: 'project_owner',
      classification: 'internal',
      declaredBy: created.personId,
      reason: 'a service actor whose person record must be searchable the moment it exists',
    });

    const written = [
      created.organizationId,
      created.personId,
      // Not among `grant_person_clearance`'s ledger targets (the person is): found only because
      // the record written under the act is indexed at commit.
      granted.roleAssignmentId,
      declared.personId,
      declared.roleAssignmentId,
    ];
    expect(await indexed(written), 'indexed before any drain').toEqual([]);

    await drainAll();
    expect(await indexed(written)).toEqual([...written].sort());

    const asFounder = {
      actorId: created.personId,
      actingRoleId: granted.roleAssignmentId,
      organizationId: created.organizationId,
      maxClassification: 'restricted',
    };
    const people = await search(harness.pool, asFounder, { text: personName });
    expect(people.map((hit) => hit.objectId)).toContain(created.personId);
    const organizations = await search(harness.pool, asFounder, { text: 'Quillfeather Bindery' });
    expect(organizations.map((hit) => hit.objectId)).toContain(created.organizationId);
  });

  it('every act recorded and every record written under one is named by an outbox row', async () => {
    // Whatever wrote them — the owner's commands above, the dispatcher, a fixture that records
    // an act — the ledger and the outbox agree. A write path that bypassed the outbox would leave
    // a row here.
    const missing = await withTransaction(harness.adminPool, (tx) =>
      tx.query<{ kind: string; id: string }>(
        `select 'act' as kind, a.id::text as id
           from core.action a
          where a.recorded_at >= $1
            and not exists (select 1 from core.outbox o
                             where o.action_id = a.id and o.topic = 'kf.' || a.action_type)
         union all
         select 'record', ob.id::text
           from core.object ob
          where ob.updated_at >= $1
            and not exists (select 1 from core.outbox o
                             where o.payload -> 'targets' ? ob.id::text)`,
        [since],
      ),
    );
    expect(missing).toEqual([]);
  });

  it('is emitted by the database, once, whoever records the act', async () => {
    const triggers = await withTransaction(harness.adminPool, (tx) =>
      tx.query<{ table_name: string; trigger_name: string; deferred: boolean }>(
        `select c.oid::regclass::text as table_name, t.tgname as trigger_name,
                t.tginitdeferred as deferred
           from pg_trigger t join pg_class c on c.oid = t.tgrelid
          where t.tgname in ('audit_event_emits_outbox', 'written_record_is_indexed')
            and t.tgenabled = 'O'
          order by t.tgname`,
      ),
    );
    expect(triggers).toEqual([
      { table_name: 'core.audit_event', trigger_name: 'audit_event_emits_outbox', deferred: false },
      { table_name: 'core.object', trigger_name: 'written_record_is_indexed', deferred: true },
    ]);
    // One kf.<action_type> row per act, never two: the dispatcher no longer writes its own.
    const doubled = await withTransaction(harness.adminPool, (tx) =>
      tx.query<{ action_id: string; topic: string }>(
        `select action_id::text, topic from core.outbox
          where topic <> 'kf.record_written' and topic <> 'kf.master_record_link_issued'
          group by action_id, topic having count(*) > 1`,
      ),
    );
    expect(doubled).toEqual([]);
  });
});
