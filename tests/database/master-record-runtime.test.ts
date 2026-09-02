import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { generateKeyPairSync, randomUUID, sign as edSign } from 'node:crypto';
import {
  createDocumentActionAtoms,
  deriveMasterRecordSections,
  latestMasterRecord,
  masterRecordItems,
  masterRecordWithholdings,
  type MasterRecordManifest,
} from '@kf/documents';
import {
  compileAndRecordMasterRecord,
  enumeratePermissionSet,
  enumeratePermittedSet,
} from '../../packages/documents/src/master-record-repository.js';
import {
  issueMasterRecordLink,
  revokeMasterRecordLink,
  verifyMasterRecordLinkToken,
} from '../../packages/documents/src/master-record-links.js';
import { registerMasterRecordRoute } from '../../apps/api/src/routes/documents/master-record-route.js';
import { registerMasterRecordLinkRoute } from '../../apps/api/src/routes/documents/master-record-link-route.js';
import type { DocumentRoutesOptions } from '../../apps/api/src/routes/documents/contracts.js';
import { InMemoryObjectStore } from '@kf/artifacts';
import {
  authoritySigningKeyMaterial,
  contentSha256,
  createSecureObjectActionAtoms,
  externalAuthorityRef,
  externalRevisionRef,
  policyDecisionRef,
  workloadIdentityRef,
} from '@kf/integration';
import { createFabricDispatcher } from '@kf/orchestrator';
import { drainOutbox } from '../../apps/worker/src/outbox.js';
import { setAccessContext, setTransactionContext, withTransaction } from '@kf/database';
import {
  createObject,
  bindContext,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

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

  it('keeps entitlement subtractive: one person is withheld while another remains open', async () => {
    const objectId = await createObject(harness.adminPool, fixtures, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Person-scoped entitlement probe',
      createdBy: fixtures.reviewerId,
    });
    const actionId = await unrecordedAction();
    await withTransaction(harness.adminPool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      await tx.query(
        `insert into content.person_entitlement_exclusion
           (subject_id, organization_id, object_id, reason_class, reason, authorizer,
            created_by_action)
         values ($1, $2, $3, 'exclusion', 'person-specific need-to-know', $1, $4)`,
        [fixtures.reviewerId, fixtures.organizationId, objectId, actionId],
      );
    });

    const membersFor = async (personId: string): Promise<readonly string[]> =>
      withTransaction(harness.pool, async (tx) => {
        await setAccessContext(tx, {
          organizationId: fixtures.organizationId,
          maxClassification: 'restricted',
        });
        return (await enumeratePermittedSet(tx, personId, fixtures.organizationId)).map(
          (member) => member.objectId,
        );
      });
    const reviewerMembers = await membersFor(fixtures.reviewerId);
    const performerMembers = await membersFor(fixtures.performerId);
    expect(reviewerMembers).not.toContain(objectId);
    expect(performerMembers).toContain(objectId);

    const atoms = createDocumentActionAtoms({
      store: new InMemoryObjectStore(),
      parser: {
        async parse() {
          return undefined;
        },
      },
    });
    const execute = createFabricDispatcher(harness.pool, atoms);
    const reviewerRecord = await execute({
      actionType: 'compile_master_record',
      actorId: fixtures.reviewerId,
      actingRoleId: fixtures.reviewerRoleId,
      targetIds: [fixtures.reviewerId],
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `entitlement-reviewer-${randomUUID()}`,
      reason: 'compile person-scoped exclusion proof',
    });
    const performerRecord = await execute({
      actionType: 'compile_master_record',
      actorId: fixtures.performerId,
      actingRoleId: fixtures.performerRoleId,
      targetIds: [fixtures.performerId],
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `entitlement-performer-${randomUUID()}`,
      reason: 'compile default-open entitlement proof',
    });
    expect(reviewerRecord.status).toBe('applied');
    expect(performerRecord.status).toBe('applied');

    const [reviewerManifest, performerManifest] = await Promise.all([
      withTransaction(harness.adminPool, (tx) =>
        latestMasterRecord(tx, fixtures.reviewerId, fixtures.organizationId),
      ),
      withTransaction(harness.adminPool, (tx) =>
        latestMasterRecord(tx, fixtures.performerId, fixtures.organizationId),
      ),
    ]);
    expect(
      (reviewerManifest?.['manifest'] as { included: readonly { objectId: string }[] }).included,
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ objectId })]));
    expect(
      (reviewerManifest?.['manifest'] as { withheld: { items: readonly unknown[] } }).withheld
        .items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectId,
          reasonClass: 'exclusion',
          reason: 'person-specific need-to-know',
        }),
      ]),
    );
    expect(
      (performerManifest?.['manifest'] as { included: readonly { objectId: string }[] }).included,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ objectId })]));
  });

  it('includes immutable artifact versions referenced by a typed document row', async () => {
    const artifactId = await createObject(harness.adminPool, fixtures, {
      type: 'artifact',
      domain: 'content',
      state: 'draft',
      title: 'Master-record payload artifact',
      createdBy: fixtures.reviewerId,
    });
    const documentId = await createObject(harness.adminPool, fixtures, {
      type: 'controlled_document',
      domain: 'quality',
      state: 'draft',
      title: 'Document with immutable bytes',
      createdBy: fixtures.reviewerId,
    });
    const actionId = await unrecordedAction();
    const versionId = randomUUID();
    const sha256 = 'a'.repeat(64);
    await withTransaction(harness.adminPool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      await setTransactionContext(tx, {
        actorId: fixtures.reviewerId,
        actingRoleId: fixtures.reviewerRoleId,
        actionId,
        requestId: 'master-record-artifact-payload',
      });
      await tx.query(
        `insert into content.artifact (id, artifact_kind, source_system)
         values ($1, 'report', 'object_store')`,
        [artifactId],
      );
      await tx.query(
        `insert into content.artifact_version
           (id, artifact_id, version_no, revision_label, sha256, size_bytes, media_type,
            storage_uri, storage_version, created_by, created_by_action)
         values ($1, $2, 1, 'R01', $3, 12, 'text/plain',
                 's3://kf/master-record-artifact', 'object-version-1', $4, $5)`,
        [versionId, artifactId, sha256, fixtures.reviewerId, actionId],
      );
      await tx.query(
        `insert into quality.controlled_document
           (id, document_class, document_number, revision, owning_role, content_version)
         values ($1, 'report', 'OH-MR-PAYLOAD-001', 'R01', 'technical_authority', $2)`,
        [documentId, versionId],
      );
    });

    const members = await withTransaction(harness.pool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      return enumeratePermissionSet(tx, fixtures.organizationId);
    });
    const document = members.find((member) => member.objectId === documentId);
    expect(document?.content).toMatchObject({
      'quality.controlled_document': expect.objectContaining({ content_version: versionId }),
      'content.artifact_version': expect.arrayContaining([
        expect.objectContaining({ id: versionId, sha256, storage_version: 'object-version-1' }),
      ]),
    });
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
    expect(first.manifest.format).toBe('kf-master-record-v2');
    expect(first.manifest.included.length).toBeGreaterThan(0);
    const subjectMember = first.manifest.included.find(
      (member) => member.objectId === fixtures.reviewerId,
    );
    expect(subjectMember?.content).toMatchObject({
      'core.object': expect.objectContaining({ id: fixtures.reviewerId }),
      'org.person': expect.objectContaining({ id: fixtures.reviewerId }),
    });
    expect(first.manifest.measurements?.permissionMemberCount).toBe(first.manifest.included.length);
    // Sectioning is derived (ADR 0013): it lives beside the manifest, never inside it.
    expect(first.sections.relevantMemberCount).toBe(first.sections.relevant.length);
    expect(first.sections.organizationViewMemberCount).toBe(first.sections.organizationView.length);
    expect(first.sections.relevanceFanoutByAnchorType).toEqual(expect.any(Object));
    expect(first.sections.relevanceFanoutByPropagationClass).toEqual(expect.any(Object));
    expect(first.sections.relevant.length + first.sections.organizationView.length).toBe(
      first.manifest.included.length,
    );
    expect('sections' in first.manifest).toBe(false);
    expect(first.manifest.corpusDigest).toMatch(/^[0-9a-f]{64}$/);

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
    const subsetObjectId = await withTransaction(harness.adminPool, async (tx) =>
      tx.one<{ object_id: string }>(
        `select object_id
           from content.master_record_item
          where master_record_id = $1 and item_state = 'included'
          order by object_id limit 1`,
        [record.id],
      ),
    );
    const derived = await withTransaction(harness.adminPool, async (tx) =>
      issueMasterRecordLink(tx, {
        secret,
        masterRecordId: record.id,
        issuedBy: fixtures.reviewerId,
        issuedByAction: actionId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        scope: {
          kind: 'derived_subset',
          subjectId: fixtures.reviewerId,
          recipientId: fixtures.reviewerId,
          objectIds: [subsetObjectId.object_id],
          purpose: 'M8 bounded self subset',
        },
      }),
    );
    const delivery = await drainOutbox(harness.adminPool);
    expect(delivery.failed).toBe(0);
    const receipt = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{ delivery_status: string; payload_digest: string; recorded_at: Date }>(
        `select delivery_status, payload_digest, recorded_at
           from content.master_record_delivery_receipt
          where link_id = $1 and action_id = $2`,
        [issued.id, actionId],
      ),
    );
    expect(receipt.delivery_status).toBe('delivered');
    expect(receipt.payload_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.recorded_at).toBeInstanceOf(Date);
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
    const app = Fastify({ routerOptions: { maxParamLength: 2048 } });
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

      const subset = await app.inject({
        method: 'GET',
        url: `/master-record-links/${encodeURIComponent(derived.token)}`,
      });
      expect(subset.statusCode, subset.body).toBe(200);
      expect(subset.json()).toMatchObject({
        subset: true,
        scope: expect.objectContaining({
          kind: 'derived_subset',
          objectIds: [subsetObjectId.object_id],
        }),
        items: [expect.objectContaining({ object_id: subsetObjectId.object_id })],
      });
      expect(subset.json().record.manifest).toBeUndefined();

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

  it('releases an entitlement exclusion only through the typed action seam', async () => {
    const actionId = await unrecordedAction();
    const objectId = await withTransaction(harness.pool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      const row = await tx.one<{ id: string }>(
        `select id from core.object
          where organization_id = $1 and object_type <> 'person'
          order by id limit 1`,
        [fixtures.organizationId],
      );
      return row.id;
    });
    expect(objectId).toBeDefined();
    const clearanceDelay = await withTransaction(harness.adminPool, async (tx) => {
      const row = await tx.one<{ milliseconds: number }>(
        `select ceil(greatest(0, extract(epoch from max(valid_from) - clock_timestamp()) * 1000))::int
           as milliseconds
           from org.person_clearance
          where subject_id = $1 and organization_id = $2`,
        [fixtures.reviewerId, fixtures.organizationId],
      );
      return row.milliseconds;
    });
    if (clearanceDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, clearanceDelay + 25));
    }
    const exclusionId = randomUUID();
    await withTransaction(harness.adminPool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      await tx.query(
        `insert into content.person_entitlement_exclusion
           (id, subject_id, organization_id, object_id, reason_class, reason, authorizer,
            created_by_action)
         values ($1,$2,$3,$4,'exclusion','temporary need-to-know', $2, $5)`,
        [exclusionId, fixtures.reviewerId, fixtures.organizationId, objectId, actionId],
      );
    });

    const atoms = createDocumentActionAtoms({
      store: new InMemoryObjectStore(),
      parser: {
        async parse() {
          return undefined;
        },
      },
    });
    const execute = createFabricDispatcher(harness.adminPool, atoms);
    const released = await execute({
      actionType: 'release_person_entitlement_exclusion',
      actorId: fixtures.reviewerId,
      actingRoleId: fixtures.reviewerRoleId,
      targetIds: [objectId!],
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `release-exclusion-${exclusionId}`,
      payload: { exclusion_id: exclusionId },
      reason: 'need-to-know review complete',
    });
    expect(released.status).toBe('applied');

    const row = await withTransaction(harness.adminPool, async (tx) => {
      const exclusion = await tx.one<{ released_at: Date; released_by_action: string }>(
        `select released_at, released_by_action
           from content.person_entitlement_exclusion where id = $1`,
        [exclusionId],
      );
      const action = await tx.one<{ effective_at: Date }>(
        'select effective_at from core.action where id = $1',
        [released.actionId],
      );
      return { exclusion, action };
    });
    expect(row.exclusion.released_at.toISOString()).toBe(row.action.effective_at.toISOString());
    expect(row.exclusion.released_by_action).toBe(released.actionId);

    await expect(
      withTransaction(harness.adminPool, (tx) =>
        tx.query(
          `update content.person_entitlement_exclusion
              set reason = 'rewritten'
            where id = $1`,
          [exclusionId],
        ),
      ),
    ).rejects.toThrow(/append-only|permitted update/i);

    await expect(
      execute({
        actionType: 'release_person_entitlement_exclusion',
        actorId: fixtures.reviewerId,
        actingRoleId: fixtures.reviewerRoleId,
        targetIds: [objectId!],
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
        idempotencyKey: `release-exclusion-again-${exclusionId}`,
        payload: { exclusion_id: exclusionId },
        reason: 'duplicate release must refuse',
      }),
    ).rejects.toMatchObject({ failure: 'precondition_failed' });
  });

  it('records a permission withdrawal with time and reason instead of silent absence', async () => {
    const actionId = await unrecordedAction();
    const latest = await withTransaction(harness.adminPool, (tx) =>
      latestMasterRecord(tx, fixtures.reviewerId, fixtures.organizationId),
    );
    expect(latest).toBeDefined();
    const manifest = latest!['manifest'] as {
      included: readonly { objectId: string; objectType: string }[];
    };
    const candidate = manifest.included.find(
      (member) =>
        member.objectId !== fixtures.reviewerId &&
        member.objectId !== fixtures.performerId &&
        !['organization', 'person', 'role_assignment'].includes(member.objectType),
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

  it('uses a signed secure-object tombstone reason when withdrawn content leaves the set', async () => {
    const subjectId = await createObject(harness.adminPool, fixtures, {
      type: 'person',
      domain: 'organization',
      state: 'active',
      title: 'Tombstone subject',
      createdBy: fixtures.reviewerId,
    });
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, fixtures);
      await tx.query(
        `insert into org.person (id, display_name, organization)
         values ($1, 'Tombstone subject', $2)`,
        [subjectId, fixtures.organizationId],
      );
      // Access is a grant (ADR 0016): a person with no role and no grant has an empty corpus.
      // The subject holds no role, so an organization-scoped read grant gives them one.
      await tx.query(
        `insert into org.access_grant
           (organization_id, principal_kind, principal_id, capability, scope_object_id,
            granted_by, granted_by_action, reason)
         values ($1, 'person', $2, 'read', $1, $3, $4, 'fixture: organization-wide read')`,
        [fixtures.organizationId, subjectId, fixtures.reviewerId, fixtures.clearanceActionId],
      );
    });

    const artifactId = await createObject(harness.adminPool, fixtures, {
      type: 'artifact',
      domain: 'content',
      state: 'draft',
      title: 'Tombstone artifact',
      createdBy: fixtures.reviewerId,
    });
    const documentId = await createObject(harness.adminPool, fixtures, {
      type: 'controlled_document',
      domain: 'quality',
      state: 'draft',
      title: 'Tombstone document',
      createdBy: fixtures.reviewerId,
    });
    const contentDigest = contentSha256('b'.repeat(64));
    const versionId = randomUUID();
    const setupAction = await unrecordedAction();
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, fixtures);
      await tx.query(
        `insert into content.artifact (id, artifact_kind, source_system)
         values ($1, 'report', 'object_store')`,
        [artifactId],
      );
      await tx.query(
        `insert into content.artifact_version
           (id, artifact_id, version_no, revision_label, sha256, size_bytes, media_type,
            storage_uri, storage_version, created_by, created_by_action)
         values ($1, $2, 1, 'R01', $3, 9, 'text/plain',
                 's3://kf/tombstone-document', 'object-version-1', $4, $5)`,
        [versionId, artifactId, contentDigest, fixtures.reviewerId, setupAction],
      );
      await tx.query(
        `insert into quality.controlled_document
           (id, document_class, document_number, revision, owning_role, content_version)
         values ($1, 'report', 'OH-MR-TOMBSTONE-001', 'R01', 'technical_authority', $2)`,
        [documentId, versionId],
      );
    });

    const documentAtoms = createDocumentActionAtoms({
      store: new InMemoryObjectStore(),
      parser: {
        async parse() {
          return undefined;
        },
      },
    });
    const compile = createFabricDispatcher(harness.pool, documentAtoms);
    const first = await compile({
      actionType: 'compile_master_record',
      actorId: fixtures.reviewerId,
      actingRoleId: fixtures.reviewerRoleId,
      targetIds: [subjectId],
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `tombstone-compile-before-${randomUUID()}`,
      reason: 'compile before secure-object withdrawal',
    });
    expect(first.status).toBe('applied');
    const prior = await withTransaction(harness.adminPool, (tx) =>
      latestMasterRecord(tx, subjectId, fixtures.organizationId),
    );
    expect(
      (prior?.['manifest'] as { included: readonly { objectId: string }[] }).included.some(
        (member) => member.objectId === documentId,
      ),
    ).toBe(true);

    const qualityRoleId = await createObject(harness.adminPool, fixtures, {
      type: 'role_assignment',
      domain: 'organization',
      state: 'active',
      title: 'Tombstone quality authority assignment',
      createdBy: fixtures.reviewerId,
    });
    const systemRoleId = await createObject(harness.adminPool, fixtures, {
      type: 'role_assignment',
      domain: 'organization',
      state: 'active',
      title: 'Tombstone system administrator assignment',
      createdBy: fixtures.reviewerId,
    });
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, fixtures);
      await tx.query(
        `insert into org.role_assignment (id, subject_id, role_id, scope_id)
         values ($1, $3, 'quality_authority', $2),
                ($4, $3, 'system_administrator', $2)`,
        [qualityRoleId, fixtures.organizationId, fixtures.reviewerId, systemRoleId],
      );
    });

    const authorityRef = externalAuthorityRef('authority:master-record-tombstone');
    const revisionRef = externalRevisionRef(`revision:master-record-${randomUUID()}`);
    const workloadIdentity = workloadIdentityRef('workload:master-record-test');
    const policyDecision = policyDecisionRef('policy-decision:master-record-test');
    const keyPair = generateKeyPairSync('ed25519');
    const keyMaterial = authoritySigningKeyMaterial(keyPair.publicKey);
    const keyId = `master-record-tombstone-${randomUUID()}`;
    const secure = createFabricDispatcher(
      harness.pool,
      undefined,
      createSecureObjectActionAtoms({
        authoritySigner: {
          sign: ({ canonicalTombstoneBytes }) =>
            edSign(null, canonicalTombstoneBytes, keyPair.privateKey),
        },
      }),
    );
    await secure({
      actionType: 'register_secure_object_authority_key',
      actorId: fixtures.reviewerId,
      actingRoleId: systemRoleId,
      targetIds: [fixtures.organizationId],
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `tombstone-key-${randomUUID()}`,
      reason: 'register tombstone verification key',
      payload: {
        organizationId: fixtures.organizationId,
        authorityRef,
        keyId,
        publicKeySpkiDerBase64: keyMaterial.publicKeySpkiDerBase64,
        publicKeySha256: keyMaterial.publicKeySha256,
        rotatesKeyRegistryId: null,
        validUntil: null,
      },
    });
    const key = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{ id: string }>(
        `select id from secure_object.authority_signing_key
          where organization_id = $1 and key_id = $2`,
        [fixtures.organizationId, keyId],
      ),
    );
    await secure({
      actionType: 'request_secure_object_erasure',
      actorId: fixtures.reviewerId,
      actingRoleId: qualityRoleId,
      targetIds: [fixtures.organizationId],
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `tombstone-request-${randomUUID()}`,
      reason: 'request exact artifact erasure',
      payload: {
        organizationId: fixtures.organizationId,
        classificationId: 'restricted',
        authorityRef,
        revisionRef,
        externalContentSha256: contentDigest,
        purpose: 'authorized_erasure',
        workloadIdentityRef: workloadIdentity,
        policyDecisionRef: policyDecision,
      },
    });
    const request = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{ id: string }>(
        `select id from secure_object.erasure_request
          where organization_id = $1 and external_revision_ref = $2`,
        [fixtures.organizationId, revisionRef],
      ),
    );
    await secure({
      actionType: 'record_secure_object_erasure',
      actorId: fixtures.reviewerId,
      actingRoleId: qualityRoleId,
      targetIds: [fixtures.organizationId],
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `tombstone-record-${randomUUID()}`,
      reason: 'record externally signed exact erasure',
      payload: {
        requestId: request.id,
        authorityRef,
        revisionRef,
        externalContentSha256: contentDigest,
        purpose: 'authorized_erasure',
        workloadIdentityRef: workloadIdentity,
        policyDecisionRef: policyDecision,
        signingKeyRegistryId: key.id,
      },
    });

    const moveAction = await unrecordedAction();
    await withTransaction(harness.adminPool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      await setTransactionContext(tx, {
        actorId: fixtures.reviewerId,
        actingRoleId: fixtures.reviewerRoleId,
        actionId: moveAction,
        requestId: 'master-record-tombstone-withdraw',
      });
      await tx.query(
        `update core.object
            set organization_id = $2, row_version = row_version + 1,
                updated_at = now(), updated_by = $3
          where id = $1`,
        [documentId, randomUUID(), fixtures.reviewerId],
      );
    });

    const second = await compile({
      actionType: 'compile_master_record',
      actorId: fixtures.reviewerId,
      actingRoleId: fixtures.reviewerRoleId,
      targetIds: [subjectId],
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `tombstone-compile-after-${randomUUID()}`,
      reason: 'compile after secure-object withdrawal',
    });
    expect(second.status).toBe('applied');
    const record = await withTransaction(harness.adminPool, (tx) =>
      latestMasterRecord(tx, subjectId, fixtures.organizationId),
    );
    const withdrawn = (
      record?.['manifest'] as {
        withdrawn: readonly { objectId: string; withdrawalReason?: string }[];
      }
    ).withdrawn.find((member) => member.objectId === documentId);
    expect(withdrawn).toMatchObject({
      objectId: documentId,
      withdrawalReason: 'secure-object erasure (policy-decision:master-record-test)',
    });
  });

  it('opens organization-view members from one authorized master-record read', async () => {
    const probe = await createObject(harness.adminPool, fixtures, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Organization view read probe',
      createdBy: fixtures.reviewerId,
    });
    const anchoredProbe = await createObject(harness.adminPool, fixtures, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Anchor fan-out persistence probe',
      createdBy: fixtures.reviewerId,
    });
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, fixtures, fixtures.reviewerId);
      await tx.query(
        `insert into core.relation (relation_type, source_id, target_id, created_by)
         values ('produces', $1, $2, $3)`,
        [fixtures.reviewerId, anchoredProbe, fixtures.reviewerId],
      );
    });
    const atoms = createDocumentActionAtoms({
      store: new InMemoryObjectStore(),
      parser: {
        async parse() {
          return undefined;
        },
      },
    });
    const execute = createFabricDispatcher(harness.pool, atoms);
    const compiled = await execute({
      actionType: 'compile_master_record',
      actorId: fixtures.reviewerId,
      actingRoleId: fixtures.reviewerRoleId,
      targetIds: [fixtures.reviewerId],
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `org-view-compile-${randomUUID()}`,
      reason: 'compile organization-view access probe',
    });
    expect(compiled.status).toBe('applied');

    // Fan-out is a property of the sectioning, which is derived from the current graph
    // (ADR 0013) — it is measured on the same persisted claim, not stored inside it.
    const sections = await withTransaction(harness.adminPool, async (tx) => {
      const record = await latestMasterRecord(tx, fixtures.reviewerId, fixtures.organizationId);
      return deriveMasterRecordSections(tx, record?.['manifest'] as MasterRecordManifest);
    });
    expect(sections.relevanceFanoutByAnchorType).toEqual(
      expect.objectContaining({ produces: expect.any(Number) }),
    );

    const app = Fastify({ logger: false });
    registerMasterRecordRoute(app, {
      pool: harness.pool,
      identify: async () => ({
        actorId: fixtures.reviewerId,
        actingRoleId: fixtures.reviewerRoleId,
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
        authentication: {
          authenticatedAt: undefined,
          assuranceLevel: undefined,
          methods: [],
        },
      }),
      store: undefined,
      preflightInTransaction: async () => undefined,
      executeInTransaction: async () => {
        throw new Error('organization-view read does not execute an action');
      },
    });
    await app.ready();
    try {
      const response = await app.inject({ method: 'GET', url: '/master-record' });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as {
        items: readonly {
          object_id: string;
          section: string;
          content_payload: Record<string, unknown>;
        }[];
      };
      const organizationItem = body.items.find(
        (item) => item.object_id === probe && item.section === 'org_view',
      );
      expect(organizationItem).toMatchObject({
        object_id: probe,
        section: 'org_view',
        content_payload: expect.any(Object),
      });
    } finally {
      await app.close();
    }
  });
});
