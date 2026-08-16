import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ActionRequest } from '@kf/actions';
import { InMemoryObjectStore, digestOf } from '@kf/artifacts';
import { auditChainDigest } from '@kf/canonicalization';
import type { Tx } from '@kf/database';
import type {
  DogfoodActionContext,
  DogfoodExecute,
  DogfoodIdentity,
  StagedSource,
} from './contracts.js';
import { loadDogfoodDocuments } from './load-documents.js';

const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-7333-8333-333333333333';
const ROLE_ID = '44444444-4444-7444-8444-444444444444';
const ARTIFACT_ACTION_ID = '55555555-5555-7555-8555-555555555555';
const DOCUMENT_ACTION_ID = '66666666-6666-7666-8666-666666666666';
const ARTIFACT_ID = '77777777-7777-7777-8777-777777777777';
const VERSION_ID = '88888888-8888-7888-8888-888888888888';
const OTHER_VERSION_ID = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
const FRAGMENT_ID = '99999999-9999-7999-8999-999999999999';
const FRAGMENT_REVISION_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const HOLDER_ID = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const DOCUMENT_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const SOURCE_BYTES = Buffer.from('# Constitution\n');
const SHA256 = digestOf(SOURCE_BYTES);

function legacyDigest(actionId: string): string {
  return createHash('sha256').update(`kf-action-legacy-v1:${actionId}`).digest('hex');
}

function auditedAction(actionId: string, actionType: string, targetId: string) {
  const prevDigest = '0'.repeat(64);
  const effectiveAt = '2026-08-12T03:30:08.279Z';
  const beforeDigest = null;
  const afterDigest = 'e'.repeat(64);
  const auditDigest = auditChainDigest(prevDigest, {
    action_id: actionId,
    action_type: actionType,
    actor_id: ACTOR_ID,
    acting_role_id: ROLE_ID,
    object_ids: [targetId],
    effective_at: effectiveAt,
    before_digest: beforeDigest,
    after_digest: afterDigest,
  });
  return {
    actionId,
    requestDigest: legacyDigest(actionId),
    resultStatus: 'applied',
    resultAuditDigest: auditDigest,
    actionType,
    actorId: ACTOR_ID,
    actingRoleId: ROLE_ID,
    targetIds: [targetId],
    effectiveAt,
    beforeDigest,
    afterDigest,
    prevDigest,
    auditDigest,
  };
}

describe('dogfood document legacy materialization recovery', () => {
  it('reuses exact audited pre-semantic artifacts and documents without weakening dispatcher replay', async () => {
    const store = new InMemoryObjectStore();
    const stored = await store.put(`document-imports/${SHA256}`, SOURCE_BYTES, 'text/markdown');
    const tx = {
      async maybeOne(sql: string) {
        if (sql.includes('/* dogfood.legacy-artifact-materialization */')) {
          return {
            ...auditedAction(ARTIFACT_ACTION_ID, 'attach_evidence', ARTIFACT_ID),
            artifactId: ARTIFACT_ID,
            versionId: VERSION_ID,
            storageUri: `document-imports/${SHA256}`,
            storageVersion: stored.versionId ?? null,
          };
        }
        if (sql.includes('/* dogfood.current-fragment-source */')) {
          return {
            objectId: FRAGMENT_ID,
            holderId: HOLDER_ID,
            revisionHolderId: HOLDER_ID,
            holderKind: 'fabric_native',
            artifactVersionId: VERSION_ID,
            contentDigest: SHA256,
            revisionId: FRAGMENT_REVISION_ID,
            mediaType: 'text/markdown',
            classification: 'internal',
          };
        }
        if (sql.includes('/* dogfood.legacy-controlled-document-materialization */')) {
          return {
            ...auditedAction(DOCUMENT_ACTION_ID, 'add_controlled_document', DOCUMENT_ID),
            documentId: DOCUMENT_ID,
          };
        }
        throw new Error(`unexpected maybeOne query: ${sql}`);
      },
      async one(sql: string) {
        throw new Error(`unexpected one query: ${sql}`);
      },
      async query(sql: string) {
        throw new Error(`unexpected query: ${sql}`);
      },
    } as unknown as Tx;
    const execute: DogfoodExecute = async () => {
      throw new Error('legacy materialization must not enter semantic action replay');
    };
    const identity: DogfoodIdentity = {
      organizationId: ORGANIZATION_ID,
      actorId: ACTOR_ID,
      actingRoleId: ROLE_ID,
    };
    const common: DogfoodActionContext = {
      ...identity,
      maxClassification: 'restricted',
      targetIds: [],
      requestId: 'legacy-document-recovery-test',
    };
    const source: StagedSource = {
      entry: {
        file: 'constitution.md',
        title: 'Document Constitution',
        documentNumber: 'OH-DOC-TEST-001',
        revision: 'R01',
        documentClass: 'policy',
        owningRole: 'technical_authority',
      },
      bytes: SOURCE_BYTES,
      mediaType: 'text/markdown',
      sha256: SHA256,
      key: `document-imports/${SHA256}`,
    };

    const result = await loadDogfoodDocuments(tx, store, execute, identity, common, [source]);

    expect(result.fragmentRevisionIds).toEqual([FRAGMENT_REVISION_ID]);
    expect(result.loaded).toEqual([
      {
        documentNumber: 'OH-DOC-TEST-001',
        revision: 'R01',
        documentId: DOCUMENT_ID,
        artifactId: ARTIFACT_ID,
        fragmentId: FRAGMENT_ID,
        fragmentRevisionId: FRAGMENT_REVISION_ID,
        sha256: SHA256,
        replayed: true,
      },
    ]);
  });

  it('revises a fragment whose Holder names a different artifact version with identical bytes', async () => {
    const revisionActionId = 'ffffffff-ffff-7fff-8fff-ffffffffffff';
    const nextRevisionId = '12121212-1212-7212-8212-121212121212';
    const requests: ActionRequest[] = [];
    const store = new InMemoryObjectStore();
    const stored = await store.put(`document-imports/${SHA256}`, SOURCE_BYTES, 'text/markdown');
    const tx = {
      async maybeOne(sql: string) {
        if (sql.includes('/* dogfood.legacy-artifact-materialization */')) {
          return {
            ...auditedAction(ARTIFACT_ACTION_ID, 'attach_evidence', ARTIFACT_ID),
            artifactId: ARTIFACT_ID,
            versionId: VERSION_ID,
            storageUri: `document-imports/${SHA256}`,
            storageVersion: stored.versionId ?? null,
          };
        }
        if (sql.includes('/* dogfood.current-fragment-source */')) {
          return {
            objectId: FRAGMENT_ID,
            holderId: HOLDER_ID,
            revisionHolderId: HOLDER_ID,
            holderKind: 'fabric_native',
            artifactVersionId: OTHER_VERSION_ID,
            contentDigest: SHA256,
            revisionId: FRAGMENT_REVISION_ID,
            mediaType: 'text/markdown',
            classification: 'internal',
          };
        }
        if (sql.includes('/* dogfood.legacy-controlled-document-materialization */')) {
          return {
            ...auditedAction(DOCUMENT_ACTION_ID, 'add_controlled_document', DOCUMENT_ID),
            documentId: DOCUMENT_ID,
          };
        }
        throw new Error(`unexpected maybeOne query: ${sql}`);
      },
      async one(sql: string) {
        if (sql.includes('content.authored_fragment_revision')) {
          return { objectId: FRAGMENT_ID, revisionId: nextRevisionId };
        }
        throw new Error(`unexpected one query: ${sql}`);
      },
      async query(sql: string) {
        throw new Error(`unexpected query: ${sql}`);
      },
    } as unknown as Tx;
    const execute: DogfoodExecute = async (_tx, request) => {
      requests.push(request);
      return {
        actionId: revisionActionId,
        status: 'applied',
        objectIds: [FRAGMENT_ID],
        replayed: false,
        auditDigest: 'audit',
      };
    };
    const identity: DogfoodIdentity = {
      organizationId: ORGANIZATION_ID,
      actorId: ACTOR_ID,
      actingRoleId: ROLE_ID,
    };
    const common: DogfoodActionContext = {
      ...identity,
      maxClassification: 'restricted',
      targetIds: [],
      requestId: 'artifact-version-holder-mismatch-test',
    };
    const source: StagedSource = {
      entry: {
        file: 'constitution.md',
        title: 'Document Constitution',
        documentNumber: 'OH-DOC-TEST-001',
        revision: 'R01',
        documentClass: 'policy',
        owningRole: 'technical_authority',
      },
      bytes: SOURCE_BYTES,
      mediaType: 'text/markdown',
      sha256: SHA256,
      key: `document-imports/${SHA256}`,
    };

    const result = await loadDogfoodDocuments(tx, store, execute, identity, common, [source]);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      actionType: 'revise_authored_fragment',
      targetIds: [FRAGMENT_ID],
      payload: {
        previous_revision_id: FRAGMENT_REVISION_ID,
        previous_holder_id: HOLDER_ID,
        holder: { artifact_version_id: VERSION_ID, content_digest: SHA256 },
      },
    });
    expect(result.loaded[0]).toMatchObject({
      fragmentRevisionId: nextRevisionId,
      replayed: false,
    });
  });

  it('fails closed when controlled-document action returns no object id', async () => {
    const store = new InMemoryObjectStore();
    const stored = await store.put(`document-imports/${SHA256}`, SOURCE_BYTES, 'text/markdown');
    const tx = {
      async maybeOne(sql: string) {
        if (sql.includes('/* dogfood.legacy-artifact-materialization */')) {
          return {
            ...auditedAction(ARTIFACT_ACTION_ID, 'attach_evidence', ARTIFACT_ID),
            artifactId: ARTIFACT_ID,
            versionId: VERSION_ID,
            storageUri: `document-imports/${SHA256}`,
            storageVersion: stored.versionId ?? null,
          };
        }
        if (sql.includes('/* dogfood.current-fragment-source */')) {
          return {
            objectId: FRAGMENT_ID,
            holderId: HOLDER_ID,
            revisionHolderId: HOLDER_ID,
            holderKind: 'fabric_native',
            artifactVersionId: VERSION_ID,
            contentDigest: SHA256,
            revisionId: FRAGMENT_REVISION_ID,
            mediaType: 'text/markdown',
            classification: 'internal',
          };
        }
        if (sql.includes('/* dogfood.legacy-controlled-document-materialization */')) {
          return undefined;
        }
        throw new Error(`unexpected maybeOne query: ${sql}`);
      },
      async one(sql: string) {
        throw new Error(`unexpected one query: ${sql}`);
      },
      async query(sql: string) {
        throw new Error(`unexpected query: ${sql}`);
      },
    } as unknown as Tx;
    const execute: DogfoodExecute = async (_tx, request) => {
      expect(request.actionType).toBe('add_controlled_document');
      return {
        actionId: DOCUMENT_ACTION_ID,
        status: 'applied',
        objectIds: [],
        replayed: true,
        auditDigest: 'audit',
      };
    };

    await expect(
      loadDogfoodDocuments(
        tx,
        store,
        execute,
        {
          organizationId: ORGANIZATION_ID,
          actorId: ACTOR_ID,
          actingRoleId: ROLE_ID,
        },
        {
          organizationId: ORGANIZATION_ID,
          actorId: ACTOR_ID,
          actingRoleId: ROLE_ID,
          maxClassification: 'restricted',
          targetIds: [],
          requestId: 'missing-document-id-test',
        },
        [
          {
            entry: {
              file: 'constitution.md',
              title: 'Document Constitution',
              documentNumber: 'OH-DOC-TEST-001',
              revision: 'R01',
              documentClass: 'policy',
              owningRole: 'technical_authority',
            },
            bytes: SOURCE_BYTES,
            mediaType: 'text/markdown',
            sha256: SHA256,
            key: `document-imports/${SHA256}`,
          },
        ],
      ),
    ).rejects.toThrow('add_controlled_document returned no document id');
  });
});
