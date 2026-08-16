import { auditChainDigest } from '@kf/canonicalization';
import { InMemoryObjectStore, digestOf } from '@kf/artifacts';
import { describe, expect, it } from 'vitest';
import type { Tx } from '@kf/database';
import { legacyArtifactMaterialization } from './repository.js';

const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-7333-8333-333333333333';
const ROLE_ID = '44444444-4444-7444-8444-444444444444';
const ACTION_ID = '55555555-5555-7555-8555-555555555555';
const ARTIFACT_ID = '66666666-6666-7666-8666-666666666666';
const VERSION_ID = '77777777-7777-7777-8777-777777777777';
const EFFECTIVE_AT = '2026-08-12T03:30:08.279Z';

function legacyDigest(actionId: string): string {
  return digestOf(Buffer.from(`kf-action-legacy-v1:${actionId}`));
}

function auditedAction(targetId: string) {
  const prevDigest = '0'.repeat(64);
  const beforeDigest = null;
  const afterDigest = 'a'.repeat(64);
  const auditDigest = auditChainDigest(prevDigest, {
    action_id: ACTION_ID,
    action_type: 'attach_evidence',
    actor_id: ACTOR_ID,
    acting_role_id: ROLE_ID,
    object_ids: [targetId],
    effective_at: EFFECTIVE_AT,
    before_digest: beforeDigest,
    after_digest: afterDigest,
  });
  return {
    actionId: ACTION_ID,
    requestDigest: legacyDigest(ACTION_ID),
    resultStatus: 'applied',
    resultAuditDigest: auditDigest,
    actionType: 'attach_evidence',
    actorId: ACTOR_ID,
    actingRoleId: ROLE_ID,
    targetIds: [targetId],
    effectiveAt: EFFECTIVE_AT,
    beforeDigest,
    afterDigest,
    prevDigest,
    auditDigest,
  };
}

describe('dogfood legacy artifact recovery evidence', () => {
  it('requires applied action/audit bindings and verifies pinned stored bytes', async () => {
    const bytes = Buffer.from('# exact legacy bytes\n');
    const sha256 = digestOf(bytes);
    const key = `document-imports/${sha256}`;
    const store = new InMemoryObjectStore();
    const stored = await store.put(key, bytes, 'text/markdown');
    const tx = {
      async maybeOne(sql: string, parameters?: readonly unknown[]) {
        expect(sql).toContain('join core.action_migration019_legacy legacy');
        expect(sql).toContain("action.result_status = 'applied'");
        expect(sql).toContain("action.result ->> 'audit_digest' = event.digest");
        expect(sql).toContain('event.actor_id = action.actor_id');
        expect(sql).toContain('event.acting_role_id = action.acting_role_id');
        expect(sql).toContain('event.action_type = action.action_type');
        expect(sql).toContain('event.effective_at = action.effective_at');
        expect(sql).toContain('event.object_id = first_target.id');
        expect(sql).toContain('select 1 from content.document_parse parse');
        expect(sql).toContain('parse.created_by_action = action.id');
        expect(parameters?.[10]).toBe(true);
        return {
          ...auditedAction(ARTIFACT_ID),
          artifactId: ARTIFACT_ID,
          versionId: VERSION_ID,
          storageUri: key,
          storageVersion: stored.versionId ?? null,
        };
      },
    } as unknown as Tx;

    await expect(
      legacyArtifactMaterialization(tx, store, ORGANIZATION_ID, ACTOR_ID, 'dogfood:key', {
        title: 'constitution.md',
        artifactKind: 'policy',
        sha256,
        sizeBytes: bytes.length,
        mediaType: 'text/markdown',
        storageUri: key,
        revisionLabel: 'R01',
        requiresDocumentParse: true,
      }),
    ).resolves.toEqual({ artifactId: ARTIFACT_ID, versionId: VERSION_ID });
  });

  it('does not recognize a failed legacy action even when its synthetic digest matches', async () => {
    const bytes = Buffer.from('# failed action bytes\n');
    const sha256 = digestOf(bytes);
    const key = `document-imports/${sha256}`;
    const store = new InMemoryObjectStore();
    const stored = await store.put(key, bytes, 'text/markdown');
    const tx = {
      async maybeOne() {
        return {
          ...auditedAction(ARTIFACT_ID),
          resultStatus: 'failed',
          artifactId: ARTIFACT_ID,
          versionId: VERSION_ID,
          storageUri: key,
          storageVersion: stored.versionId ?? null,
        };
      },
    } as unknown as Tx;

    await expect(
      legacyArtifactMaterialization(tx, store, ORGANIZATION_ID, ACTOR_ID, 'dogfood:key', {
        title: 'constitution.md',
        artifactKind: 'policy',
        sha256,
        sizeBytes: bytes.length,
        mediaType: 'text/markdown',
        storageUri: key,
        revisionLabel: 'R01',
        requiresDocumentParse: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('fails closed when the exact pinned storage version no longer matches its digest', async () => {
    const bytes = Buffer.from('# original bytes\n');
    const sha256 = digestOf(bytes);
    const key = `document-imports/${sha256}`;
    const store = new InMemoryObjectStore();
    const stored = await store.put(key, bytes, 'text/markdown');
    store.tamper(key, Buffer.from('# tampered bytes\n'));
    const tx = {
      async maybeOne() {
        return {
          ...auditedAction(ARTIFACT_ID),
          artifactId: ARTIFACT_ID,
          versionId: VERSION_ID,
          storageUri: key,
          storageVersion: stored.versionId ?? null,
        };
      },
    } as unknown as Tx;

    await expect(
      legacyArtifactMaterialization(tx, store, ORGANIZATION_ID, ACTOR_ID, 'dogfood:key', {
        title: 'constitution.md',
        artifactKind: 'policy',
        sha256,
        sizeBytes: bytes.length,
        mediaType: 'text/markdown',
        storageUri: key,
        revisionLabel: 'R01',
        requiresDocumentParse: true,
      }),
    ).rejects.toThrow('cannot reuse legacy artifact');
  });
});
