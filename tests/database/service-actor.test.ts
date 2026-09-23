import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  InMemoryObjectStore,
  StoreRegistry,
  createStorageActionAtoms,
  declareStore,
  digestOf,
  locationsOf,
} from '@kf/artifacts';
import { withTransaction } from '@kf/database';
import { createFabricDispatcher } from '@kf/orchestrator';
import { runDeclareServiceActor } from '../../apps/api/src/admin/declare-service-actor.js';
import { EVIDENCE_KEY_NAMESPACES } from '@kf/documents';
import type { ListedObject, SweepableObjectStore } from '@kf/artifacts';
import { EVIDENCE_NAMESPACES, sweepOrphanedEvidence } from '../../apps/kf-storage/src/orphans.js';
import { runStorageSweep } from '../../apps/kf-storage/src/sweep.js';
import {
  bindContext,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

/**
 * A service actor is a declared principal, not a login (ADR 0020). Against a real database:
 *
 *   1. Declaring one records a real act by the human who decided, creates the person of kind
 *      `service` with an organization-scoped role and a clearance, and is idempotent by name.
 *   2. It can never be linked to a login: the database refuses the link.
 *   3. It can never perform an institutional act: `requires: act` is refused for it even with
 *      an organization-wide role, by name.
 *   4. The storage sweep, run as it, replicates every version lacking a durable copy and
 *      re-verifies stale locations — each an audited action with the service actor as actor —
 *      and a second run does nothing.
 */

let harness: Harness;
let fixtures: Fixtures;
let steward: { personId: string; roleAssignmentId: string };

beforeAll(async () => {
  harness = await startHarness();
  fixtures = await seedFixtures(harness.adminPool);
  const declared = await runDeclareServiceActor(harness.adminPool, {
    organizationId: fixtures.organizationId,
    name: 'storage-steward',
    roleId: 'performer',
    classification: 'restricted',
    declaredBy: fixtures.reviewerId,
    reason: 'replicates and re-verifies artifact copies on a timer',
  });
  steward = { personId: declared.personId, roleAssignmentId: declared.roleAssignmentId };
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

describe('a declared service actor', () => {
  it('is a person of kind service with a role, a clearance and a recorded act; idempotent', async () => {
    const row = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{
        person_kind: string;
        display_name: string;
        role_id: string;
        max_classification: string;
        actor_id: string;
      }>(
        `select p.person_kind, p.display_name, ra.role_id, pc.max_classification, a.actor_id
           from org.person p
           join org.role_assignment ra on ra.subject_id = p.id
           join org.person_clearance pc on pc.subject_id = p.id
           join core.action a on a.id = pc.granted_by_action
          where p.id = $1`,
        [steward.personId],
      ),
    );
    expect(row).toEqual({
      person_kind: 'service',
      display_name: 'storage-steward',
      role_id: 'performer',
      max_classification: 'restricted',
      actor_id: fixtures.reviewerId,
    });
    const again = await runDeclareServiceActor(harness.adminPool, {
      organizationId: fixtures.organizationId,
      name: 'storage-steward',
      roleId: 'performer',
      classification: 'restricted',
      declaredBy: fixtures.reviewerId,
      reason: 'declared twice',
    });
    expect(again.reused).toBe(true);
    expect(again.personId).toBe(steward.personId);
  });

  it('can never be linked to a login', async () => {
    await expect(
      withTransaction(harness.adminPool, async (tx) => {
        await bindContext(tx, fixtures, fixtures.reviewerId);
        await tx.query(
          `insert into org.external_identity (issuer, subject, person_id, provider_label, linked_by)
           values ('https://idp.example', 'steward', $1, 'steward', $2)`,
          [steward.personId, fixtures.reviewerId],
        );
      }),
    ).rejects.toThrow(/service actor and cannot be linked/);
  });

  it('can never perform an institutional act, whatever role it holds', async () => {
    const document = await createObject(harness.adminPool, fixtures, {
      type: 'controlled_document',
      domain: 'quality',
      state: 'draft',
      title: 'Not for a robot to number',
      createdBy: fixtures.reviewerId,
    });
    await expect(
      createFabricDispatcher(harness.pool)({
        actionType: 'allocate_enterprise_identifier',
        actorId: steward.personId,
        actingRoleId: steward.roleAssignmentId,
        targetIds: [document],
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
        idempotencyKey: `steward-allocate-${randomUUID()}`,
        reason: 'a timer trying to number a record',
      }),
    ).rejects.toMatchObject({
      name: 'ActionRejected',
      failure: 'act_not_granted',
      message: expect.stringContaining('service actor'),
    });
  });

  it('runs the storage sweep as itself: replicate, verify, and then nothing', async () => {
    const working = new InMemoryObjectStore();
    const durable = new InMemoryObjectStore();
    const registry = new StoreRegistry({ working, durable });
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, fixtures);
      await declareStore(tx, { id: 'durable', kind: 'memory', label: 'Second failure domain' });
    });
    const body = Buffer.from('bytes the steward will copy');
    const artifactId = await createObject(harness.adminPool, fixtures, {
      type: 'artifact',
      domain: 'content',
      state: 'draft',
      title: 'Swept artifact',
      createdBy: fixtures.reviewerId,
    });
    const key = `artifacts/${artifactId}/v1`;
    const stored = await working.put(key, body, 'text/plain');
    const versionId = randomUUID();
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, fixtures, fixtures.reviewerId);
      await tx.query(
        `insert into content.artifact (id, artifact_kind, source_system) values ($1, 'document', 'object_store')`,
        [artifactId],
      );
      await tx.query(
        `insert into content.artifact_version
           (id, artifact_id, version_no, revision_label, sha256, size_bytes, media_type,
            storage_uri, storage_version, created_by, created_by_action)
         values ($1, $2, 1, 'R01', $3, $4, 'text/plain', $5, $6, $7, $8)`,
        [
          versionId,
          artifactId,
          digestOf(body),
          body.length,
          key,
          stored.versionId,
          fixtures.reviewerId,
          fixtures.clearanceActionId,
        ],
      );
    });

    const execute = createFabricDispatcher(
      harness.pool,
      undefined,
      undefined,
      undefined,
      createStorageActionAtoms(registry),
    );
    const actor = {
      personId: steward.personId,
      roleAssignmentId: steward.roleAssignmentId,
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
    };
    const first = await runStorageSweep(harness.pool, execute, actor, {
      replicateTo: 'durable',
      verifyOlderThanDays: 0,
    });
    expect(first.refused).toEqual([]);
    expect(first.replicated.map((r) => r.versionId)).toContain(versionId);
    expect(first.verified.every((v) => v.ok)).toBe(true);

    const locations = await withTransaction(harness.adminPool, (tx) => locationsOf(tx, versionId));
    expect(locations.map((l) => [l.role, l.store_id])).toEqual([
      ['durable_copy', 'durable'],
      ['working', 'working'],
    ]);
    const actors = await withTransaction(harness.adminPool, (tx) =>
      tx.query<{ actor_id: string; action_type: string }>(
        `select actor_id, action_type from core.action
          where action_type in ('replicate_artifact_version', 'verify_artifact_location')
            and $1 = any(target_ids)`,
        [artifactId],
      ),
    );
    expect(actors.length).toBeGreaterThanOrEqual(2);
    expect(actors.every((a) => a.actor_id === steward.personId)).toBe(true);

    const second = await runStorageSweep(harness.pool, execute, actor, { replicateTo: 'durable' });
    expect(second.replicated).toEqual([]);
    expect(second.refused).toEqual([]);
  });
});

/** A bucket listing with controllable ages; deletion is recorded rather than performed. */
class AgedStore implements SweepableObjectStore {
  readonly objects = new Map<string, Date>();
  readonly deleted: string[] = [];

  async *list(prefix: string): AsyncIterable<ListedObject> {
    for (const [key, lastModified] of this.objects) {
      if (key.startsWith(prefix)) yield { key, lastModified };
    }
  }

  async deleteEveryVersion(key: string): Promise<number> {
    this.deleted.push(key);
    this.objects.delete(key);
    return 1;
  }
}

describe('orphaned evidence collection', () => {
  it('names the same evidence namespaces the documents package derives keys in', () => {
    expect([...EVIDENCE_NAMESPACES]).toEqual([...EVIDENCE_KEY_NAMESPACES]);
  });

  it('removes only old, unreferenced keys under its own organization', async () => {
    const now = new Date('2026-09-23T03:30:00Z');
    const old = new Date(now.getTime() - 8 * 24 * 3_600_000);
    const young = new Date(now.getTime() - 3_600_000);
    const org = fixtures.organizationId;
    const hex = (n: number): string => n.toString(16).padStart(64, '0');

    // A referenced key: a real version row points at it, however old the object is.
    const body = Buffer.from('bytes a record was signed against');
    const referencedKey = `ingest/${org}/${digestOf(body)}`;
    const artifactId = await createObject(harness.adminPool, fixtures, {
      type: 'artifact',
      domain: 'content',
      state: 'draft',
      title: 'Referenced evidence',
      createdBy: fixtures.reviewerId,
    });
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, fixtures, fixtures.reviewerId);
      await tx.query(
        `insert into content.artifact (id, artifact_kind, source_system) values ($1, 'document', 'object_store')`,
        [artifactId],
      );
      await tx.query(
        `insert into content.artifact_version
           (id, artifact_id, version_no, revision_label, sha256, size_bytes, media_type,
            storage_uri, storage_version, created_by, created_by_action)
         values ($1, $2, 1, 'R01', $3, $4, 'text/plain', $5, 'v1', $6, $7)`,
        [
          randomUUID(),
          artifactId,
          digestOf(body),
          body.length,
          referencedKey,
          fixtures.reviewerId,
          fixtures.clearanceActionId,
        ],
      );
    });

    const store = new AgedStore();
    const orphanIngest = `ingest/${org}/${hex(1)}`;
    const orphanImport = `document-imports/${org}/${hex(2)}`;
    const youngOrphan = `ingest/${org}/${hex(3)}`;
    const otherOrganization = `ingest/0badc0de-0000-4000-8000-000000000001/${hex(4)}`;
    const legacyUnscoped = `document-imports/${hex(5)}`;
    const notEvidence = `artifacts/${org}/${hex(6)}`;
    for (const key of [referencedKey, orphanIngest, orphanImport, otherOrganization]) {
      store.objects.set(key, old);
    }
    store.objects.set(legacyUnscoped, old);
    store.objects.set(notEvidence, old);
    store.objects.set(youngOrphan, young);

    const actor = {
      personId: steward.personId,
      roleAssignmentId: steward.roleAssignmentId,
      organizationId: org,
      maxClassification: 'restricted',
    };
    const report = await sweepOrphanedEvidence(harness.pool, store, actor, {
      graceHours: 168,
      now,
    });
    expect(report.refused).toEqual([]);
    expect([...store.deleted].sort()).toEqual([orphanImport, orphanIngest].sort());
    expect(store.objects.has(referencedKey), 'a referenced key was collected').toBe(true);
    expect(store.objects.has(youngOrphan), 'a key inside the grace period was collected').toBe(
      true,
    );
    expect(store.objects.has(otherOrganization)).toBe(true);
    expect(store.objects.has(legacyUnscoped)).toBe(true);
    expect(store.objects.has(notEvidence)).toBe(true);

    // Every deletion is recorded, in the same run, and attributed by the database to the bound
    // service actor; the digest is read from the key, not from the caller (20260924000400).
    const recorded = await withTransaction(harness.adminPool, (tx) =>
      tx.query<{
        storage_key: string;
        sha256: string | null;
        store_id: string;
        versions_removed: number;
        collected_by: string;
        organization_id: string;
      }>(
        `select storage_key, sha256, store_id, versions_removed, collected_by, organization_id
           from content.orphan_collection order by storage_key`,
      ),
    );
    expect(recorded).toEqual(
      [orphanImport, orphanIngest].sort().map((key) => ({
        storage_key: key,
        sha256: key.slice(-64),
        store_id: 'working',
        versions_removed: 1,
        collected_by: steward.personId,
        organization_id: org,
      })),
    );
  });

  it('records collections only through its seam, only as a service actor, and never edits one', async () => {
    const org = fixtures.organizationId;
    const key = `ingest/${org}/${'e'.repeat(64)}`;
    // The application role holds no INSERT: a hand-written row is refused outright.
    await expect(
      withTransaction(harness.pool, async (tx) => {
        await bindContext(tx, fixtures, fixtures.reviewerId);
        await tx.query(
          `insert into content.orphan_collection
             (organization_id, store_id, storage_key, versions_removed, collected_by, reason)
           values ($1, 'working', $2, 1, $3, 'a forged collection record')`,
          [org, key, fixtures.reviewerId],
        );
      }),
    ).rejects.toThrow(/permission denied/);
    // A human principal is not a collector (ADR 0020).
    await expect(
      withTransaction(harness.pool, async (tx) => {
        await bindContext(tx, fixtures, fixtures.reviewerId);
        await tx.query("select content.record_orphan_collection('working', $1, 1, $2)", [
          key,
          'a human claiming a sweep',
        ]);
      }),
    ).rejects.toThrow(/service actor/);
    // Nor may the collector name a key outside its own organization's evidence prefixes.
    const asSteward = <T>(sql: string, params: unknown[]) =>
      withTransaction(harness.pool, async (tx) => {
        await tx.query('select core.bind_principal($1, $2, $3, $4)', [
          steward.personId,
          steward.roleAssignmentId,
          org,
          'restricted',
        ]);
        return tx.query<T & Record<string, unknown>>(sql, params);
      });
    await expect(
      asSteward("select content.record_orphan_collection('working', $1, 1, $2)", [
        `artifacts/${org}/${'e'.repeat(64)}`,
        'outside the evidence prefixes',
      ]),
    ).rejects.toThrow(/evidence prefixes/);
    // And once written, a record is not the owner's to change either.
    await expect(
      withTransaction(harness.adminPool, (tx) =>
        tx.query("update content.orphan_collection set reason = 'rewritten afterwards'"),
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      withTransaction(harness.adminPool, (tx) => tx.query('delete from content.orphan_collection')),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses to collect below the top classification, where records could be invisible', async () => {
    const store = new AgedStore();
    store.objects.set(
      `ingest/${fixtures.organizationId}/${'f'.repeat(64)}`,
      new Date('2020-01-01T00:00:00Z'),
    );
    await expect(
      sweepOrphanedEvidence(
        harness.pool,
        store,
        {
          personId: steward.personId,
          roleAssignmentId: steward.roleAssignmentId,
          organizationId: fixtures.organizationId,
          maxClassification: 'internal',
        },
        { graceHours: 168 },
      ),
    ).rejects.toThrow(/highest classification/);
    expect(store.deleted).toEqual([]);
  });
});
