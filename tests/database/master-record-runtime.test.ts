import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  createDocumentActionAtoms,
  latestMasterRecord,
  masterRecordItems,
  masterRecordWithholdings,
} from '@kf/documents';
import { compileAndRecordMasterRecord } from '../../packages/documents/src/master-record-repository.js';
import {
  issueMasterRecordLink,
  revokeMasterRecordLink,
  verifyMasterRecordLinkToken,
} from '../../packages/documents/src/master-record-links.js';
import { registerMasterRecordLinkRoute } from '../../apps/api/src/routes/documents/master-record-link-route.js';
import type { DocumentRoutesOptions } from '../../apps/api/src/routes/documents/contracts.js';
import { InMemoryObjectStore } from '@kf/artifacts';
import { createFabricDispatcher } from '@kf/orchestrator';
import { setAccessContext, setTransactionContext, withTransaction } from '@kf/database';
import { seedFixtures, startHarness, type Fixtures, type Harness } from './harness.js';

let harness: Harness;
let fixtures: Fixtures;

beforeAll(async () => {
  harness = await startHarness();
  fixtures = await seedFixtures(harness.adminPool);
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

async function bootstrapAction(): Promise<string> {
  return withTransaction(harness.adminPool, async (tx) => {
    const row = await tx.one<{ id: string }>(
      'select id from core.action order by recorded_at limit 1',
    );
    return row.id;
  });
}

/** Create an action without an audit row, as required by append-only compiler insert policies. */
async function unrecordedAction(): Promise<string> {
  const actionId = randomUUID();
  const effectiveAt = new Date().toISOString();
  await withTransaction(harness.adminPool, async (tx) => {
    await tx.query(
      `insert into core.action
         (id, organization_id, request_digest, action_type, actor_id, acting_role_id,
          target_ids, parameters, preconditions, idempotency_key, effective_at,
          reason, result_status, result)
       values ($1, $2, encode(public.digest(convert_to($3, 'UTF8'), 'sha256'), 'hex'),
               'create_initiative', $4, $5, array[$2]::uuid[], '{}'::jsonb, '{}'::jsonb,
               $6, $7, 'master-record test action', 'applied', '{}'::jsonb)`,
      [
        actionId,
        fixtures.organizationId,
        `master-record-test-${actionId}`,
        fixtures.reviewerId,
        fixtures.reviewerRoleId,
        `master-record-test-${actionId}`,
        effectiveAt,
      ],
    );
  });
  return actionId;
}

describe('master-record runtime', () => {
  it('runs through composed typed action kernel', async () => {
    const atoms = createDocumentActionAtoms({
      store: new InMemoryObjectStore(),
      parser: {
        async parse() {
          return undefined;
        },
      },
    });
    const execute = createFabricDispatcher(harness.adminPool, atoms);
    const result = await execute({
      actionType: 'compile_master_record',
      actorId: fixtures.reviewerId,
      actingRoleId: fixtures.reviewerRoleId,
      targetIds: [fixtures.performerId],
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: 'master-record-action-test',
      reason: 'dogfood compiler exercise',
    });
    expect(result.status).toBe('applied');
    const record = await withTransaction(harness.adminPool, (tx) =>
      latestMasterRecord(tx, fixtures.performerId, fixtures.organizationId),
    );
    expect(record?.['person_id']).toBe(fixtures.performerId);
  });

  it('enumerates permission, persists sectioned claim, and reports third-party withholding by count', async () => {
    const actionId = await bootstrapAction();
    const first = await withTransaction(harness.adminPool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      await setTransactionContext(tx, {
        actorId: fixtures.reviewerId,
        actingRoleId: fixtures.reviewerRoleId,
        actionId,
        requestId: 'master-record-test',
      });
      return compileAndRecordMasterRecord(tx, {
        personId: fixtures.reviewerId,
        organizationId: fixtures.organizationId,
        effectiveClassification: 'restricted',
        recordedBy: fixtures.reviewerId,
        recordedByAction: actionId,
      });
    });
    expect(first.manifest.format).toBe('kf-master-record-v1');
    expect(first.manifest.included.length).toBeGreaterThan(0);
    const subjectMember = first.manifest.included.find(
      (member) => member.objectId === fixtures.reviewerId,
    );
    expect(subjectMember?.content).toMatchObject({
      'core.object': expect.objectContaining({ id: fixtures.reviewerId }),
      'org.person': expect.objectContaining({ id: fixtures.reviewerId }),
    });
    expect(first.manifest.measurements?.permissionMemberCount).toBe(first.manifest.included.length);
    expect(first.manifest.measurements?.relevantMemberCount).toBe(first.relevant.length);
    expect(first.manifest.measurements?.organizationViewMemberCount).toBe(
      first.organizationView.length,
    );
    expect(first.relevant.length + first.organizationView.length).toBe(
      first.manifest.included.length,
    );

    const withheldObject = first.manifest.included[0]!;
    await withTransaction(harness.adminPool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      await tx.query(
        `insert into content.person_entitlement_exclusion
           (subject_id, organization_id, object_id, reason_class, reason, authorizer,
            created_by_action)
         values ($1,$2,$3,'third_party','supplier confidential', $1, $4)`,
        [fixtures.reviewerId, fixtures.organizationId, withheldObject.objectId, actionId],
      );
    });

    const second = await withTransaction(harness.adminPool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      await setTransactionContext(tx, {
        actorId: fixtures.reviewerId,
        actingRoleId: fixtures.reviewerRoleId,
        actionId,
        requestId: 'master-record-test-2',
      });
      return compileAndRecordMasterRecord(tx, {
        personId: fixtures.reviewerId,
        organizationId: fixtures.organizationId,
        effectiveClassification: 'restricted',
        recordedBy: fixtures.reviewerId,
        recordedByAction: actionId,
      });
    });
    expect(second.manifest.included.some((item) => item.objectId === withheldObject.objectId)).toBe(
      false,
    );
    expect(second.manifest.withheld.thirdPartyCounts['third_party']).toBe(1);

    const stored = await withTransaction(harness.adminPool, async (tx) => {
      const record = await latestMasterRecord(tx, fixtures.reviewerId, fixtures.organizationId);
      expect(record).toBeDefined();
      const items = await masterRecordItems(tx, String(record!['id']));
      const withholdings = await masterRecordWithholdings(tx, String(record!['id']));
      return { record, items, withholdings };
    });
    expect(stored.items.length).toBe(second.manifest.included.length);
    expect(stored.withholdings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason_class: 'third_party', object_id: null }),
      ]),
    );

    const heldObject = second.manifest.included.find(
      (member) => member.objectId !== withheldObject.objectId,
    );
    expect(heldObject).toBeDefined();
    await withTransaction(harness.adminPool, async (tx) => {
      await tx.query(
        `insert into core.retention_hold (object_id, reason, placed_by)
         values ($1, 'litigation hold', $2)`,
        [heldObject!.objectId, fixtures.reviewerId],
      );
    });
    const held = await withTransaction(harness.adminPool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      await setTransactionContext(tx, {
        actorId: fixtures.reviewerId,
        actingRoleId: fixtures.reviewerRoleId,
        actionId,
        requestId: 'master-record-test-hold',
      });
      return compileAndRecordMasterRecord(tx, {
        personId: fixtures.reviewerId,
        organizationId: fixtures.organizationId,
        effectiveClassification: 'restricted',
        recordedBy: fixtures.reviewerId,
        recordedByAction: actionId,
      });
    });
    expect(held.manifest.included.some((member) => member.objectId === heldObject!.objectId)).toBe(
      false,
    );
    expect(held.manifest.withheld.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectId: heldObject!.objectId,
          reasonClass: 'legal_hold',
          reason: 'litigation hold',
        }),
      ]),
    );
  });

  it('signs and verifies capability tokens without storing token cleartext', async () => {
    const actionId = await bootstrapAction();
    const record = await withTransaction(harness.adminPool, async (tx) => {
      return tx.one<{ id: string }>(
        `select id from content.master_record
          where person_id = $1 and organization_id = $2
          order by compiled_at desc limit 1`,
        [fixtures.reviewerId, fixtures.organizationId],
      );
    });
    const issued = await withTransaction(harness.adminPool, async (tx) =>
      issueMasterRecordLink(tx, {
        secret: '0123456789abcdef0123456789abcdef',
        masterRecordId: record.id,
        issuedBy: fixtures.reviewerId,
        issuedByAction: actionId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    expect(issued.token).not.toContain(issued.tokenDigest);
    expect(verifyMasterRecordLinkToken(issued.token, '0123456789abcdef0123456789abcdef')).toEqual(
      issued.claims,
    );
    expect(
      verifyMasterRecordLinkToken(`${issued.token}x`, '0123456789abcdef0123456789abcdef'),
    ).toBe(undefined);
  });

  it('serves once, logs every attempt, and refuses expired or revoked links', async () => {
    const actionId = await bootstrapAction();
    const secret = '0123456789abcdef0123456789abcdef';
    const record = await withTransaction(harness.adminPool, async (tx) =>
      tx.one<{ id: string }>(
        `select id from content.master_record
          where person_id = $1 and organization_id = $2
          order by compiled_at desc limit 1`,
        [fixtures.reviewerId, fixtures.organizationId],
      ),
    );
    const issued = await withTransaction(harness.adminPool, async (tx) =>
      issueMasterRecordLink(tx, {
        secret,
        masterRecordId: record.id,
        issuedBy: fixtures.reviewerId,
        issuedByAction: actionId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    const expired = await withTransaction(harness.adminPool, async (tx) =>
      issueMasterRecordLink(tx, {
        secret,
        masterRecordId: record.id,
        issuedBy: fixtures.reviewerId,
        issuedByAction: actionId,
        issuedAt: '2026-08-25T00:00:00.000Z',
        expiresAt: '2026-08-25T00:01:00.000Z',
      }),
    );
    const app = Fastify({ routerOptions: { maxParamLength: 512 } });
    const options = {
      pool: harness.pool,
      identify: async () => {
        throw new Error('capability route does not identify a caller');
      },
      store: undefined,
      masterRecordLinkSecret: secret,
      preflightInTransaction: async () => undefined,
      executeInTransaction: async () => {
        throw new Error('capability route does not execute an action');
      },
    } satisfies DocumentRoutesOptions;
    registerMasterRecordLinkRoute(app, options);
    await app.ready();
    try {
      const served = await app.inject({
        method: 'GET',
        url: `/master-record-links/${encodeURIComponent(issued.token)}`,
      });
      expect(served.statusCode).toBe(200);
      expect(served.json().items.length).toBeGreaterThan(0);

      await withTransaction(harness.adminPool, (tx) =>
        revokeMasterRecordLink(tx, {
          linkId: issued.id,
          revokedBy: fixtures.reviewerId,
          revokedByAction: actionId,
          reason: 'test revocation',
        }),
      );
      const revoked = await app.inject({
        method: 'GET',
        url: `/master-record-links/${encodeURIComponent(issued.token)}`,
      });
      expect(revoked.statusCode).toBe(410);
      expect(revoked.json()).toEqual({ error: 'link_revoked' });

      const expiredResponse = await app.inject({
        method: 'GET',
        url: `/master-record-links/${encodeURIComponent(expired.token)}`,
      });
      expect(expiredResponse.statusCode).toBe(410);
      expect(expiredResponse.json()).toEqual({ error: 'link_expired' });
    } finally {
      await app.close();
    }
    const accessResults = await withTransaction(harness.adminPool, async (tx) =>
      tx.query<{ result: string }>(
        `select result from content.master_record_link_access
          where link_id in ($1,$2) order by accessed_at`,
        [issued.id, expired.id],
      ),
    );
    expect(accessResults.map((row) => row.result)).toEqual(
      expect.arrayContaining(['served', 'revoked', 'expired']),
    );
  });

  it('records a permission withdrawal with time and reason instead of silent absence', async () => {
    const actionId = await unrecordedAction();
    const latest = await withTransaction(harness.adminPool, (tx) =>
      latestMasterRecord(tx, fixtures.reviewerId, fixtures.organizationId),
    );
    expect(latest).toBeDefined();
    const manifest = latest!['manifest'] as {
      included: readonly { objectId: string }[];
    };
    const candidate = manifest.included.find(
      (member) =>
        member.objectId !== fixtures.reviewerId && member.objectId !== fixtures.performerId,
    );
    expect(candidate).toBeDefined();

    await withTransaction(harness.adminPool, async (tx) => {
      await setTransactionContext(tx, {
        actorId: fixtures.reviewerId,
        actingRoleId: fixtures.reviewerRoleId,
        actionId,
        requestId: 'master-record-withdrawal-mutation',
      });
      await tx.query(
        `update core.object
            set organization_id = $2, row_version = row_version + 1,
                updated_at = now(), updated_by = $3
          where id = $1`,
        [candidate!.objectId, randomUUID(), fixtures.reviewerId],
      );
    });

    const withdrawn = await withTransaction(harness.pool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      await setTransactionContext(tx, {
        actorId: fixtures.reviewerId,
        actingRoleId: fixtures.reviewerRoleId,
        actionId,
        requestId: 'master-record-withdrawal-compile',
      });
      return compileAndRecordMasterRecord(tx, {
        personId: fixtures.reviewerId,
        organizationId: fixtures.organizationId,
        effectiveClassification: 'restricted',
        recordedBy: fixtures.reviewerId,
        recordedByAction: actionId,
        compiledAt: '2026-08-26T01:00:00.000Z',
      });
    });
    const removed = withdrawn.manifest.withdrawn.find(
      (member) => member.objectId === candidate!.objectId,
    );
    expect(removed).toMatchObject({
      objectId: candidate!.objectId,
      withdrawalReason: 'permission set no longer admits this object',
    });
    expect(removed?.withdrawnAt).toBe('2026-08-26T01:00:00.000Z');
  });
});
