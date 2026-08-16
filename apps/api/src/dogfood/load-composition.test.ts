import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ActionRequest, ActionResult } from '@kf/actions';
import { InMemoryObjectStore, digestOf } from '@kf/artifacts';
import { auditChainDigest } from '@kf/canonicalization';
import type { Tx } from '@kf/database';
import type {
  DogfoodActionContext,
  DogfoodExecute,
  DogfoodIdentity,
  StagedManifest,
} from './contracts.js';
import { loadDogfoodComposition } from './load-composition.js';

const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222';
const MANIFEST_ARTIFACT_ID = '33333333-3333-7333-8333-333333333333';
const MANIFEST_VERSION_ID = '44444444-4444-7444-8444-444444444444';
const COMPOSITION_ID = '55555555-5555-7555-8555-555555555555';
const CURRENT_REVISION_ID = '66666666-6666-7666-8666-666666666666';
const RECORDED_REVISION_ID = '77777777-7777-7777-8777-777777777777';
const CURRENT_HOLDER_ID = '88888888-8888-7888-8888-888888888888';
const REVISION_HOLDER_ID = '99999999-9999-7999-8999-999999999999';
const FRAGMENT_REVISION_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const ACTOR_ID = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const CURRENT_ROLE_ID = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
const LEGACY_ROLE_ID = 'ffffffff-ffff-7fff-8fff-ffffffffffff';
const MANIFEST_BYTES = Buffer.from('{}');
const MANIFEST_SHA256 = digestOf(MANIFEST_BYTES);

function legacyDigest(actionId: string): string {
  return createHash('sha256').update(`kf-action-legacy-v1:${actionId}`).digest('hex');
}

function auditedArtifactAction(actionId: string) {
  const prevDigest = '0'.repeat(64);
  const effectiveAt = '2026-08-12T03:30:08.279Z';
  const beforeDigest = null;
  const afterDigest = 'b'.repeat(64);
  const auditDigest = auditChainDigest(prevDigest, {
    action_id: actionId,
    action_type: 'attach_evidence',
    actor_id: ACTOR_ID,
    acting_role_id: LEGACY_ROLE_ID,
    object_ids: [MANIFEST_ARTIFACT_ID],
    effective_at: effectiveAt,
    before_digest: beforeDigest,
    after_digest: afterDigest,
  });
  return {
    actionId,
    requestDigest: legacyDigest(actionId),
    resultStatus: 'applied',
    resultAuditDigest: auditDigest,
    actionType: 'attach_evidence',
    actorId: ACTOR_ID,
    actingRoleId: LEGACY_ROLE_ID,
    targetIds: [MANIFEST_ARTIFACT_ID],
    effectiveAt,
    beforeDigest,
    afterDigest,
    prevDigest,
    auditDigest,
  };
}

function actionResult(
  actionId: string,
  objectIds: readonly string[],
  replayed: boolean,
): ActionResult {
  return { actionId, status: 'applied', objectIds, replayed, auditDigest: 'audit' };
}

describe('dogfood composition Holder alignment', () => {
  it('refuses to call a terminal revision current when its Holder differs from subject Holder', async () => {
    const store = new InMemoryObjectStore();
    const tx = {
      async one(sql: string) {
        if (sql.includes('content.artifact_version')) return { id: MANIFEST_VERSION_ID };
        if (sql.includes('content.composition_revision')) {
          return { objectId: COMPOSITION_ID, revisionId: RECORDED_REVISION_ID };
        }
        throw new Error(`unexpected one query: ${sql}`);
      },
      async maybeOne(sql: string) {
        if (sql.includes('/* dogfood.legacy-artifact-materialization */')) return undefined;
        expect(sql).toContain('/* dogfood.current-composition-source */');
        expect(sql).toContain('revision_holder.id as "revisionHolderId"');
        expect(sql).toContain('revision_holder.recorded_by_action = r.created_by_action');
        expect(sql).not.toContain('r.holder_id');
        return {
          objectId: COMPOSITION_ID,
          holderId: CURRENT_HOLDER_ID,
          revisionHolderId: REVISION_HOLDER_ID,
          holderKind: 'fabric_native',
          artifactVersionId: MANIFEST_VERSION_ID,
          contentDigest: MANIFEST_SHA256,
          revisionId: CURRENT_REVISION_ID,
          classification: 'internal',
        };
      },
      async query() {
        return [{ ordinal: 1, inputRole: 'fragment', fragmentRevisionId: FRAGMENT_REVISION_ID }];
      },
    } as unknown as Tx;
    const requests: ActionRequest[] = [];
    const execute: DogfoodExecute = async (_tx, request) => {
      requests.push(request);
      return request.actionType === 'attach_evidence'
        ? actionResult('bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', [MANIFEST_ARTIFACT_ID], true)
        : actionResult('cccccccc-cccc-7ccc-8ccc-cccccccccccc', [COMPOSITION_ID], false);
    };
    const identity: DogfoodIdentity = {
      organizationId: ORGANIZATION_ID,
      actorId: ACTOR_ID,
      actingRoleId: CURRENT_ROLE_ID,
    };
    const common: DogfoodActionContext = {
      ...identity,
      maxClassification: 'restricted',
      targetIds: [],
      requestId: 'dogfood-holder-alignment-test',
    };
    const manifest: StagedManifest = {
      bytes: MANIFEST_BYTES,
      sha256: MANIFEST_SHA256,
      key: `document-imports/${MANIFEST_SHA256}`,
      fileName: 'document-constitution.json',
    };

    const result = await loadDogfoodComposition(tx, store, execute, identity, common, manifest, [
      FRAGMENT_REVISION_ID,
    ]);

    expect(requests.map((request) => request.actionType)).toEqual([
      'attach_evidence',
      'revise_document_composition',
    ]);
    expect(requests[1]).toMatchObject({
      targetIds: [COMPOSITION_ID],
      payload: {
        previous_revision_id: CURRENT_REVISION_ID,
        previous_holder_id: CURRENT_HOLDER_ID,
      },
    });
    expect(result.compositionRevisionId).toBe(RECORDED_REVISION_ID);
    expect(result.replayed).toBe(false);
  });

  it('reuses an exact audited pre-semantic manifest materialization', async () => {
    const artifactActionId = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
    const store = new InMemoryObjectStore();
    const stored = await store.put(
      `document-imports/${MANIFEST_SHA256}`,
      MANIFEST_BYTES,
      'application/json',
    );
    const tx = {
      async maybeOne(sql: string) {
        if (sql.includes('/* dogfood.legacy-artifact-materialization */')) {
          return {
            ...auditedArtifactAction(artifactActionId),
            artifactId: MANIFEST_ARTIFACT_ID,
            versionId: MANIFEST_VERSION_ID,
            storageUri: `document-imports/${MANIFEST_SHA256}`,
            storageVersion: stored.versionId ?? null,
          };
        }
        if (sql.includes('/* dogfood.current-composition-source */')) {
          expect(sql).toContain('revision_holder.id as "revisionHolderId"');
          expect(sql).toContain('revision_holder.recorded_by_action = r.created_by_action');
          expect(sql).not.toContain('r.holder_id');
          return {
            objectId: COMPOSITION_ID,
            holderId: CURRENT_HOLDER_ID,
            revisionHolderId: CURRENT_HOLDER_ID,
            holderKind: 'fabric_native',
            artifactVersionId: MANIFEST_VERSION_ID,
            contentDigest: MANIFEST_SHA256,
            revisionId: CURRENT_REVISION_ID,
            classification: 'internal',
          };
        }
        throw new Error(`unexpected maybeOne query: ${sql}`);
      },
      async one(sql: string) {
        throw new Error(`unexpected one query: ${sql}`);
      },
      async query(sql: string) {
        if (sql.includes('content.composition_input')) {
          return [{ ordinal: 1, inputRole: 'fragment', fragmentRevisionId: FRAGMENT_REVISION_ID }];
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    } as unknown as Tx;
    const execute: DogfoodExecute = async () => {
      throw new Error('legacy materialization must not enter semantic action replay');
    };
    const identity: DogfoodIdentity = {
      organizationId: ORGANIZATION_ID,
      actorId: ACTOR_ID,
      actingRoleId: CURRENT_ROLE_ID,
    };
    const common: DogfoodActionContext = {
      ...identity,
      maxClassification: 'restricted',
      targetIds: [],
      requestId: 'legacy-composition-recovery-test',
    };
    const manifest: StagedManifest = {
      bytes: MANIFEST_BYTES,
      sha256: MANIFEST_SHA256,
      key: `document-imports/${MANIFEST_SHA256}`,
      fileName: 'document-constitution.json',
    };

    const result = await loadDogfoodComposition(tx, store, execute, identity, common, manifest, [
      FRAGMENT_REVISION_ID,
    ]);

    expect(result).toEqual({
      compositionId: COMPOSITION_ID,
      compositionRevisionId: CURRENT_REVISION_ID,
      manifestArtifactId: MANIFEST_ARTIFACT_ID,
      manifestSha256: MANIFEST_SHA256,
      replayed: true,
    });
  });

  it('revises an otherwise matching composition that contains an extra non-fragment input', async () => {
    const artifactActionId = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
    const revisionActionId = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
    const requests: ActionRequest[] = [];
    const store = new InMemoryObjectStore();
    const stored = await store.put(
      `document-imports/${MANIFEST_SHA256}`,
      MANIFEST_BYTES,
      'application/json',
    );
    const tx = {
      async maybeOne(sql: string) {
        if (sql.includes('/* dogfood.legacy-artifact-materialization */')) {
          return {
            ...auditedArtifactAction(artifactActionId),
            artifactId: MANIFEST_ARTIFACT_ID,
            versionId: MANIFEST_VERSION_ID,
            storageUri: `document-imports/${MANIFEST_SHA256}`,
            storageVersion: stored.versionId ?? null,
          };
        }
        if (sql.includes('/* dogfood.current-composition-source */')) {
          return {
            objectId: COMPOSITION_ID,
            holderId: CURRENT_HOLDER_ID,
            revisionHolderId: CURRENT_HOLDER_ID,
            holderKind: 'fabric_native',
            artifactVersionId: MANIFEST_VERSION_ID,
            contentDigest: MANIFEST_SHA256,
            revisionId: CURRENT_REVISION_ID,
            classification: 'internal',
          };
        }
        throw new Error(`unexpected maybeOne query: ${sql}`);
      },
      async one(sql: string) {
        if (sql.includes('content.composition_revision')) {
          return { objectId: COMPOSITION_ID, revisionId: RECORDED_REVISION_ID };
        }
        throw new Error(`unexpected one query: ${sql}`);
      },
      async query(sql: string) {
        if (sql.includes('content.composition_input')) {
          return [
            { ordinal: 1, inputRole: 'fragment', fragmentRevisionId: FRAGMENT_REVISION_ID },
            { ordinal: 2, inputRole: 'resource', fragmentRevisionId: null },
          ];
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    } as unknown as Tx;
    const execute: DogfoodExecute = async (_tx, request) => {
      requests.push(request);
      return actionResult(revisionActionId, [COMPOSITION_ID], false);
    };
    const identity: DogfoodIdentity = {
      organizationId: ORGANIZATION_ID,
      actorId: ACTOR_ID,
      actingRoleId: CURRENT_ROLE_ID,
    };
    const common: DogfoodActionContext = {
      ...identity,
      maxClassification: 'restricted',
      targetIds: [],
      requestId: 'composition-extra-input-test',
    };
    const manifest: StagedManifest = {
      bytes: MANIFEST_BYTES,
      sha256: MANIFEST_SHA256,
      key: `document-imports/${MANIFEST_SHA256}`,
      fileName: 'document-constitution.json',
    };

    const result = await loadDogfoodComposition(tx, store, execute, identity, common, manifest, [
      FRAGMENT_REVISION_ID,
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      actionType: 'revise_document_composition',
      targetIds: [COMPOSITION_ID],
      payload: {
        previous_revision_id: CURRENT_REVISION_ID,
        previous_holder_id: CURRENT_HOLDER_ID,
      },
    });
    expect(result.compositionRevisionId).toBe(RECORDED_REVISION_ID);
    expect(result.replayed).toBe(false);
  });
});
