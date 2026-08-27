import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDocumentActionAtoms,
  latestMasterRecord,
  masterRecordItems,
  masterRecordWithholdings,
} from '@kf/documents';
import { compileAndRecordMasterRecord } from '../../packages/documents/src/master-record-repository.js';
import {
  issueMasterRecordLink,
  verifyMasterRecordLinkToken,
} from '../../packages/documents/src/master-record-links.js';
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
});
