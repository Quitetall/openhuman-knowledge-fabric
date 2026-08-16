import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Caller } from './client.js';
import { getDocumentDownload, postDocumentProposal } from './document-operations.js';

const caller: Caller = {
  authentication: 'development',
  actorId: 'actor-1',
  actingRoleId: 'role-1',
  organizationId: 'organization-1',
  maxClassification: 'internal',
};

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['KF_API_URL'];
});

describe('document operation API client', () => {
  it('posts exact proposal preconditions without changing operation fields', async () => {
    process.env['KF_API_URL'] = 'https://api.example.test';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          proposalId: 'proposal-1',
          actionId: 'action-1',
          replayed: false,
          auditDigest: 'a'.repeat(64),
        }),
        { status: 201 },
      ),
    );
    const input = {
      proposalId: 'proposal-1',
      basisId: 'basis-1',
      basisDigest: 'b'.repeat(64),
      targetObjectId: 'target-1',
      baseRevisionId: 'revision-1',
      targetRowVersion: '7',
      proposalKind: 'source_patch' as const,
      operation: {
        operation: 'replace_fragment_source' as const,
        media_type: 'text/markdown',
        classification: 'internal' as const,
        holder_id: 'holder-2',
        previous_holder_id: 'holder-1',
        holder: {
          kind: 'fabric_native' as const,
          artifact_version_id: 'artifact-2',
          content_digest: 'c'.repeat(64),
        },
      },
      idempotencyKey: 'document-proposal-1',
      reason: 'Proposed source replacement',
    };

    await expect(postDocumentProposal('document-1', input, caller)).resolves.toMatchObject({
      proposalId: 'proposal-1',
      actionId: 'action-1',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(input);
  });

  it('returns an authenticated immutable download response without consuming its stream', async () => {
    process.env['KF_API_URL'] = 'https://api.example.test';
    const response = new Response('exact bytes', {
      headers: { 'content-type': 'text/plain', etag: '"sha256:abc"' },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);

    const downloaded = await getDocumentDownload('/documents/document-1/source', caller);

    expect(downloaded).toBe(response);
    await expect(downloaded.text()).resolves.toBe('exact bytes');
  });
});
