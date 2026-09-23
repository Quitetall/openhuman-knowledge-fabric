/**
 * `pnpm dogfood:load` re-run against a database loaded before the evidence storage key became
 * organization-scoped (2026-09-23) replays what it recorded instead of dying on
 * `idempotency_conflict`. The request digests here are computed by the dispatcher's own
 * function, so "identical to what was recorded" means what the dispatcher means by it.
 */

import { describe, expect, it } from 'vitest';
import { semanticActionRequestDigest, type ActionRequest } from '@kf/actions';
import type { Tx } from '@kf/database';
import { artifactKindForDocumentClass, evidenceStorageKey } from '@kf/documents';
import { DOGFOOD_RESET_COMMAND, legacyEvidenceKey, replayableEvidenceKey } from './repository.js';

const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222';
const SHA256 = 'a'.repeat(64);

function request(storageUri: string, title = 'Constitution.docx'): ActionRequest {
  return {
    organizationId: ORGANIZATION_ID,
    actorId: '33333333-3333-7333-8333-333333333333',
    actingRoleId: '44444444-4444-7444-8444-444444444444',
    maxClassification: 'restricted',
    targetIds: [],
    requestId: 'document-constitution-dogfood',
    actionType: 'attach_evidence',
    idempotencyKey: `dogfood:DOC-1:R01:${SHA256}:artifact`,
    payload: {
      title,
      artifact_kind: 'document',
      sha256: SHA256,
      size_bytes: 10,
      media_type: 'application/octet-stream',
      storage_uri: storageUri,
    },
  } as ActionRequest;
}

/** A ledger that recorded `recorded` under the loader's idempotency key, or nothing. */
function ledger(recorded?: ActionRequest): Tx {
  return {
    async maybeOne(sql: string, parameters: readonly unknown[]) {
      expect(sql).toContain('/* dogfood.prior-attach-evidence */');
      expect(parameters).toEqual([ORGANIZATION_ID, request('').idempotencyKey]);
      return recorded === undefined
        ? undefined
        : { requestDigest: semanticActionRequestDigest(recorded) };
    },
  } as unknown as Tx;
}

const scoped = evidenceStorageKey('document-imports', ORGANIZATION_ID, SHA256);

describe('the storage key a dogfood re-run sends', () => {
  it('is the scoped key on a fresh database', async () => {
    await expect(replayableEvidenceKey(ledger(), request(scoped), SHA256)).resolves.toBe(scoped);
  });

  it('is the scoped key when that is what was recorded', async () => {
    await expect(
      replayableEvidenceKey(ledger(request(scoped)), request(scoped), SHA256),
    ).resolves.toBe(scoped);
  });

  it('is the legacy key when the recorded act differs from today’s ONLY by the key', async () => {
    // Sending this makes the request byte-identical to the recorded one, so the dispatcher
    // replays it: no new act, no new object, and KF-ART-KEY — which governs new acts — is moot.
    const recorded = request(legacyEvidenceKey(SHA256));
    await expect(replayableEvidenceKey(ledger(recorded), request(scoped), SHA256)).resolves.toBe(
      `document-imports/${SHA256}`,
    );
  });

  it('refuses, naming the reset command, when the recorded act differs in anything else', async () => {
    const recorded = request(legacyEvidenceKey(SHA256), 'Somebody else’s title.docx');
    await expect(replayableEvidenceKey(ledger(recorded), request(scoped), SHA256)).rejects.toThrow(
      DOGFOOD_RESET_COMMAND,
    );
  });
});

describe('the dogfood loader sends it', () => {
  it('re-attaches a source loaded before key scoping under its recorded key', async () => {
    const { loadArtifact } = await import('./load-documents/artifact.js');
    const bytes = Buffer.from('# Constitution\n');
    const { digestOf, InMemoryObjectStore } = await import('@kf/artifacts');
    const sha256 = digestOf(bytes);
    const identity = {
      organizationId: ORGANIZATION_ID,
      actorId: '33333333-3333-7333-8333-333333333333',
      actingRoleId: '44444444-4444-7444-8444-444444444444',
    };
    const common = {
      ...identity,
      maxClassification: 'restricted',
      targetIds: [],
      requestId: 'document-constitution-dogfood',
    };
    const entry = {
      file: 'Constitution.md',
      title: 'Constitution',
      documentNumber: 'DOC-1',
      revision: 'R01',
      documentClass: 'policy',
      owningRole: 'steward',
    };
    // What the loader recorded before 2026-09-23: the same request with the unscoped key.
    const recorded = {
      ...common,
      actionType: 'attach_evidence',
      idempotencyKey: `dogfood:DOC-1:R01:${sha256}:artifact`,
      payload: {
        title: 'Constitution.md',
        artifact_kind: artifactKindForDocumentClass('policy'),
        sha256,
        size_bytes: bytes.length,
        media_type: 'text/markdown',
        storage_uri: legacyEvidenceKey(sha256),
        revision_label: 'R01',
      },
    } as unknown as ActionRequest;
    const tx = {
      async maybeOne(sql: string) {
        if (sql.includes('/* dogfood.legacy-artifact-materialization */')) return undefined;
        if (sql.includes('/* dogfood.prior-attach-evidence */')) {
          return { requestDigest: semanticActionRequestDigest(recorded) };
        }
        throw new Error(`unexpected maybeOne: ${sql}`);
      },
      async one() {
        return { id: 'version-id' };
      },
    } as unknown as Tx;
    const sent: ActionRequest[] = [];
    const loaded = await loadArtifact(
      tx,
      new InMemoryObjectStore(),
      async (_tx, sentRequest) => {
        sent.push(sentRequest);
        return {
          actionId: 'action-id',
          status: 'applied',
          objectIds: ['artifact-id'],
          replayed: true,
          auditDigest: 'audit',
        };
      },
      identity,
      common,
      {
        entry,
        bytes,
        mediaType: 'text/markdown',
        sha256,
        key: evidenceStorageKey('document-imports', ORGANIZATION_ID, sha256),
      },
    );
    expect(sent).toHaveLength(1);
    expect(semanticActionRequestDigest(sent[0]!)).toBe(semanticActionRequestDigest(recorded));
    expect(loaded).toEqual({ artifactId: 'artifact-id', versionId: 'version-id', replayed: true });
  });
});
