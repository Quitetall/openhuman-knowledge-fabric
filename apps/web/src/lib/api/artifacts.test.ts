import { afterEach, describe, expect, it, vi } from 'vitest';
import { artifactDerivation, artifactFile, getArtifactText } from './artifacts.js';
import type { Caller } from './client.js';
import { parseObjectView } from './object-views.js';

const PDF = '01a0d661-9046-7739-a1a9-789267c99d1a';
const TEXT = '01a0d661-935b-70eb-a39c-27f09ed5ad0a';
const CALLER: Caller = {
  authentication: 'oidc',
  actorId: 'subject',
  bearerToken: 'token',
  actingRoleId: '01900000-0000-7000-8000-000000000001',
  organizationId: '01900000-0000-7000-8000-000000000002',
  maxClassification: 'internal',
};

function version(no: number, extra: Record<string, unknown> = {}) {
  return {
    id: `v${no}`,
    sha256: String(no).repeat(64),
    media_type: 'application/pdf',
    size_bytes: 5822,
    version_no: no,
    revision_label: null,
    ...extra,
  };
}

function view(subjectId: string, versions: unknown, edges: unknown[]) {
  return parseObjectView({
    result: {
      projectionDigest: 'p'.repeat(64),
      source: { corpusDigest: 'c'.repeat(64) },
      sections: [
        {
          id: 'subject',
          members: [
            {
              objectId: subjectId,
              objectType: 'artifact',
              classification: 'internal',
              contentDigest: 'd'.repeat(64),
              itemState: 'included',
              title: 'Artifact',
              content: { 'content.artifact_version': versions },
            },
          ],
        },
      ],
      edges,
    },
    facets: {},
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('artifact file', () => {
  it('reads the newest retained version from the projection', () => {
    const file = artifactFile(
      view(PDF, [version(1), version(3, { revision_label: 'extracted:ocr' }), version(2)], [])
        .subject,
    );
    expect(file).toEqual({
      mediaType: 'application/pdf',
      sizeBytes: 5822,
      sha256: '3'.repeat(64),
      versionNo: 3,
      revisionLabel: 'extracted:ocr',
    });
  });

  it('has no file when no version row is well formed, and none for other object types', () => {
    expect(artifactFile(view(PDF, [{ media_type: 'application/pdf' }], []).subject)).toBe(
      undefined,
    );
    expect(
      artifactFile({ ...view(PDF, [version(1)], []).subject, objectType: 'nonconformity' }),
    ).toBeUndefined();
  });

  it('finds the extraction pair from derived_from edges in either direction', () => {
    const edge = { sourceId: TEXT, targetId: PDF, relationType: 'derived_from' };
    expect(artifactDerivation(view(PDF, [], [edge]))).toEqual({ extractedTextId: TEXT });
    expect(artifactDerivation(view(TEXT, [], [edge]))).toEqual({ extractedFromId: PDF });
    expect(artifactDerivation(view(PDF, [], [{ ...edge, relationType: 'supersedes' }]))).toEqual(
      {},
    );
  });
});

describe('artifact text', () => {
  it('reads plain text through the authorized source route', async () => {
    vi.stubEnv('KF_API_URL', 'http://api.example.test');
    const fetch = vi.fn(
      async (_url: string) =>
        new Response('Notification de suspension — contrat', {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(getArtifactText(TEXT, CALLER)).resolves.toEqual({
      text: 'Notification de suspension — contrat',
      truncated: false,
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(`http://api.example.test/documents/${TEXT}/source`);
  });

  it('cuts at the byte limit without inventing a character at the cut', async () => {
    vi.stubEnv('KF_API_URL', 'http://api.example.test');
    // "é" is two bytes; a limit of 3 falls inside the second one.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('éé', { headers: { 'content-type': 'text/plain' } })),
    );
    await expect(getArtifactText(TEXT, CALLER, 3)).resolves.toEqual({
      text: 'é',
      truncated: true,
    });
  });

  it('refuses to render anything the API does not label plain text', async () => {
    vi.stubEnv('KF_API_URL', 'http://api.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('%PDF-1.4', { headers: { 'content-type': 'application/pdf' } }),
      ),
    );
    await expect(getArtifactText(PDF, CALLER)).rejects.toThrow(/not plain text/);
  });

  it('surfaces the API refusal rather than an empty text', async () => {
    vi.stubEnv('KF_API_URL', 'http://api.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: 'not_found', message: 'No such artifact' }, { status: 404 }),
      ),
    );
    await expect(getArtifactText(PDF, CALLER)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });
});
