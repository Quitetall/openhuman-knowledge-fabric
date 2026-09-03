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
        `insert into content.artifact (id, artifact_kind, source_system) values ($1, 'report', 'object_store')`,
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
