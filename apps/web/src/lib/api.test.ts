import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  addDocument,
  get,
  getOperationalReadiness,
  parseAvailableActionsView,
  parseDocumentDetail,
  parseDocumentsResponse,
  parseHistoryView,
  parseProjectView,
  type Caller,
  type Decoder,
} from './api.js';

const originalApiUrl = process.env['KF_API_URL'];

function readinessReport(serviceStatus: 'ok' | 'failed', institutionalStatus: 'ok' | 'failed') {
  const serviceChecks = [
    {
      id: 'database_contract',
      scope: 'service',
      status: serviceStatus,
      detail:
        serviceStatus === 'ok'
          ? 'Configured service dependency is available.'
          : 'Configured service dependency is unavailable.',
    },
  ];
  const institutionalChecks = [
    {
      id: 'checkpoint_coverage',
      scope: 'institutional',
      status: institutionalStatus,
      detail:
        institutionalStatus === 'ok'
          ? 'Institutional checkpoint evidence is current.'
          : 'No audit checkpoint has ever been signed.',
      measured: { checkpoints: institutionalStatus === 'ok' ? 1 : 0 },
    },
  ];
  return {
    ready: serviceStatus === 'ok',
    checks: serviceChecks,
    service: { ready: serviceStatus === 'ok', checks: serviceChecks },
    institutional: {
      ready: institutionalStatus === 'ok',
      checks: institutionalChecks,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalApiUrl === undefined) delete process.env['KF_API_URL'];
  else process.env['KF_API_URL'] = originalApiUrl;
});

describe('web API caller boundary', () => {
  it('forwards bearer identity with explicitly selected authority context', async () => {
    process.env['KF_API_URL'] = 'https://api.example.test/';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ documents: [] }), { status: 200 }));
    const caller: Caller = {
      authentication: 'oidc',
      actorId: 'keycloak-subject',
      bearerToken: 'verified-access-token',
      actingRoleId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      maxClassification: 'internal',
    };

    await get('/documents', caller, parseDocumentsResponse);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/documents',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer verified-access-token',
          'x-kf-acting-role': caller.actingRoleId,
          'x-kf-organization': caller.organizationId,
          'x-kf-classification': caller.maxClassification,
        }),
      }),
    );
  });

  it('keeps fixed development identity visibly separate and sends no bearer token', async () => {
    process.env['KF_API_URL'] = 'http://localhost:4000';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ documents: [] }), { status: 200 }));
    const caller: Caller = {
      authentication: 'development',
      actorId: '01900000-0000-7000-8000-000000000010',
      actingRoleId: '01900000-0000-7000-8000-000000000011',
      organizationId: '01900000-0000-7000-8000-000000000012',
      maxClassification: 'internal',
    };

    await get('/documents', caller, parseDocumentsResponse);

    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['authorization']).toBeUndefined();
    expect(headers['x-kf-actor']).toBe(caller.actorId);
  });

  it.each([
    {
      name: 'project',
      decoder: parseProjectView,
      body: {
        id: 'project-1',
        enterprise_id: null,
        title: 'Compiler cutover',
        lifecycle_state: 'active',
        row_version: '3',
        project_code: 'KF-COMPILER',
        objective: 'Replace legacy documentation compiler without loss.',
        sponsor_id: 'actor-1',
        started_on: '2026-08-14',
        target_completion: null,
        packages: [
          {
            id: 'package-1',
            title: 'Compatibility oracle',
            lifecycle_state: 'accepted',
            sequence_no: 1,
            acceptance_criterion: 'LamQuant corpus matches.',
          },
        ],
        progress: { totalPackages: 1, disposedPackages: 1, fraction: 1 },
        unexpected: 'wrong field does not replace required field',
      },
      corrupt: (body: Record<string, unknown>) => ({
        ...body,
        progress: { totalPackages: 1, disposedPackages: 1, fraction: 0.5 },
      }),
    },
    {
      name: 'history',
      decoder: parseHistoryView,
      body: {
        objectId: 'project-1',
        events: [
          {
            seq: '1',
            action_type: 'create_project',
            actor_id: 'actor-1',
            acting_role_id: 'role-1',
            recorded_at: '2026-08-14T12:00:00.000Z',
            effective_at: '2026-08-14T12:00:00.000Z',
            reason: null,
            digest: 'a'.repeat(64),
          },
        ],
      },
      corrupt: (body: Record<string, unknown>) => ({ ...body, events: [{ seq: 1 }] }),
    },
    {
      name: 'available actions',
      decoder: parseAvailableActionsView,
      body: {
        objectId: 'project-1',
        objectType: 'initiative_project',
        state: 'active',
        actions: [
          {
            actionType: 'close_project_administrative',
            toStates: ['closed'],
            requiresChoice: false,
            reasonRequired: true,
          },
        ],
      },
      corrupt: (body: Record<string, unknown>) => ({
        ...body,
        actions: [{ actionType: 'close', toStates: 'closed' }],
      }),
    },
    {
      name: 'document list',
      decoder: parseDocumentsResponse,
      body: {
        documents: [
          {
            id: 'document-1',
            title: 'Document Constitution',
            documentNumber: 'OH-DOC-000002-1',
            revision: 'R01',
            documentClass: 'policy',
            lifecycleState: 'draft',
            rowVersion: '1',
            mediaType: 'text/markdown',
            sha256: 'a'.repeat(64),
            parsedBlockCount: 0,
          },
        ],
      },
      corrupt: (body: Record<string, unknown>) => ({
        ...body,
        documents: [{ id: 'document-1' }],
      }),
    },
  ] satisfies readonly {
    name: string;
    decoder: Decoder<unknown>;
    body: Record<string, unknown>;
    corrupt: (body: Record<string, unknown>) => Record<string, unknown>;
  }[])('validates $name successful responses', async ({ decoder, body, corrupt }) => {
    process.env['KF_API_URL'] = 'https://api.example.test';
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(corrupt(body)), { status: 200 }));
    const caller: Caller = {
      authentication: 'development',
      actorId: 'actor-1',
      actingRoleId: 'role-1',
      organizationId: 'organization-1',
      maxClassification: 'internal',
    };
    const wireDecoder: Decoder<unknown> = decoder;

    await expect(get('/fixture', caller, wireDecoder)).resolves.toEqual(body);
    await expect(get('/fixture', caller, wireDecoder)).rejects.toMatchObject({
      status: 502,
      code: 'invalid_api_response',
    });
  });

  it('decodes complete recorded document provenance and refuses incomplete evidence', async () => {
    process.env['KF_API_URL'] = 'https://api.example.test';
    const document = {
      id: 'document-1',
      title: 'Document Constitution',
      documentNumber: 'OH-DOC-000002-1',
      revision: 'R01',
      documentClass: 'policy',
      lifecycleState: 'draft',
      rowVersion: '1',
      owningRole: 'technical_authority',
      contentVersionId: 'artifact-version-1',
      mediaType: 'text/markdown',
      sha256: 'a'.repeat(64),
      sizeBytes: 42,
      parser: 'pandoc',
      parserVersion: '3.8',
      projectionContract: 'kf.pandoc-atoms.v2',
      conversionLoss: [],
      contentDigest: 'b'.repeat(64),
      parsedBlockCount: 1,
      parsedBlocks: [
        {
          ordinal: 1,
          kind: 'heading',
          level: 1,
          text: 'Authority',
          attributes: {},
          digest: 'c'.repeat(64),
        },
      ],
      sourceProvenance: {
        status: 'recorded',
        holderKind: 'fabric_native',
        fragmentId: 'fragment-1',
        fragmentRevisionId: 'fragment-revision-1',
        stableKey: 'openhuman.constitution.OH-DOC-000002-1',
        documentPolicy: 'controlled',
        holderId: 'holder-1',
        artifactVersionId: 'artifact-version-1',
        contentDigest: 'a'.repeat(64),
        mediaType: 'text/markdown',
        classification: 'internal',
        revisionState: 'active',
        revisionDigest: 'd'.repeat(64),
        holderRecordedAt: '2026-08-14T12:00:00.123Z',
        holderRecordedByAction: 'action-holder-1',
        revisionCreatedAt: '2026-08-14T12:00:01.456Z',
        revisionCreatedByAction: 'action-revision-1',
      },
    };
    const incomplete = structuredClone(document);
    delete (incomplete.sourceProvenance as Partial<typeof incomplete.sourceProvenance>)
      .revisionCreatedByAction;
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(document), { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(incomplete), { status: 200 }));
    const caller: Caller = {
      authentication: 'development',
      actorId: 'actor-1',
      actingRoleId: 'role-1',
      organizationId: 'organization-1',
      maxClassification: 'internal',
    };

    await expect(get('/documents/document-1', caller, parseDocumentDetail)).resolves.toEqual(
      document,
    );
    for (const status of ['not_recorded', 'ambiguous'] as const) {
      expect(parseDocumentDetail({ ...document, sourceProvenance: { status } })).toEqual({
        ...document,
        sourceProvenance: { status },
      });
    }
    await expect(get('/documents/document-1', caller, parseDocumentDetail)).rejects.toMatchObject({
      status: 502,
      code: 'invalid_api_response',
    });
  });

  it('refuses Holder evidence concealed under an unresolved provenance status', async () => {
    process.env['KF_API_URL'] = 'https://api.example.test';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'document-1',
          title: 'Document Constitution',
          documentNumber: 'OH-DOC-000002-1',
          revision: 'R01',
          documentClass: 'policy',
          lifecycleState: 'draft',
          rowVersion: '1',
          owningRole: 'technical_authority',
          contentVersionId: 'artifact-version-1',
          mediaType: 'text/markdown',
          sha256: 'a'.repeat(64),
          sizeBytes: 42,
          parser: null,
          parserVersion: null,
          projectionContract: null,
          conversionLoss: [],
          contentDigest: null,
          parsedBlockCount: 0,
          parsedBlocks: [],
          sourceProvenance: { status: 'ambiguous', holderId: 'concealed-holder' },
        }),
        { status: 200 },
      ),
    );
    const caller: Caller = {
      authentication: 'development',
      actorId: 'actor-1',
      actingRoleId: 'role-1',
      organizationId: 'organization-1',
      maxClassification: 'internal',
    };

    await expect(get('/documents/document-1', caller, parseDocumentDetail)).rejects.toMatchObject({
      status: 502,
      code: 'invalid_api_response',
    });
  });

  it.each([
    {
      name: 'action outcome',
      invoke: (caller: Caller) => act('create_project', { idempotencyKey: 'attempt-1' }, caller),
      body: { actionId: 'action-1', replayed: false, objectIds: ['project-1'], auditDigest: 'a' },
    },
    {
      name: 'document import outcome',
      invoke: (caller: Caller) =>
        addDocument(
          {
            title: 'Document Constitution',
            documentNumber: 'OH-DOC-000002-1',
            revision: 'R01',
            documentClass: 'policy',
            owningRole: 'technical_authority',
            fileName: 'constitution.md',
            mediaType: 'text/markdown',
            contentBase64: 'IyBDb25zdGl0dXRpb24=',
            idempotencyKey: 'attempt-2',
          },
          caller,
        ),
      body: {
        id: 'document-1',
        artifactId: 'artifact-1',
        sha256: 'a'.repeat(64),
        replayed: false,
      },
    },
  ])('refuses malformed successful $name', async ({ invoke, body }) => {
    process.env['KF_API_URL'] = 'https://api.example.test';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ...body, replayed: 'false' }), { status: 200 }),
    );
    const caller: Caller = {
      authentication: 'development',
      actorId: 'actor-1',
      actingRoleId: 'role-1',
      organizationId: 'organization-1',
      maxClassification: 'internal',
    };

    await expect(invoke(caller)).rejects.toMatchObject({
      status: 502,
      code: 'invalid_api_response',
    });
  });

  it('retains a fail-closed readiness report returned with HTTP 503', async () => {
    process.env['KF_API_URL'] = 'https://api.example.test';
    const report = readinessReport('failed', 'ok');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(report), { status: 503 }));

    await expect(getOperationalReadiness()).resolves.toEqual(report);
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/readiness', {
      cache: 'no-store',
    });
  });

  it('accepts institutional blockers without converting service readiness into failure', async () => {
    process.env['KF_API_URL'] = 'https://api.example.test';
    const report = readinessReport('ok', 'failed');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(report), { status: 200 }),
    );

    await expect(getOperationalReadiness()).resolves.toEqual(report);
  });

  it('refuses HTTP status that follows institutional failure instead of service readiness', async () => {
    process.env['KF_API_URL'] = 'https://api.example.test';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(readinessReport('ok', 'failed')), { status: 503 }),
    );

    await expect(getOperationalReadiness()).rejects.toMatchObject({
      status: 503,
      code: 'readiness_unavailable',
    });
  });

  it('refuses a successful but malformed readiness response', async () => {
    process.env['KF_API_URL'] = 'https://api.example.test';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ready: true, checks: [{ id: 'database', status: 'ok' }] }), {
        status: 200,
      }),
    );

    await expect(getOperationalReadiness()).rejects.toMatchObject({
      status: 502,
      code: 'invalid_readiness_response',
    });
  });

  it.each([
    {
      ...readinessReport('ok', 'ok'),
      ready: false,
    },
    {
      ...readinessReport('ok', 'ok'),
      service: { ...readinessReport('ok', 'ok').service, ready: false },
    },
    {
      ...readinessReport('ok', 'ok'),
      checks: [],
    },
    {
      ...readinessReport('ok', 'ok'),
      checks: [
        {
          ...readinessReport('ok', 'ok').checks[0],
          measured: { contradictoryAliasFact: 1 },
        },
      ],
    },
    {
      ...readinessReport('ok', 'ok'),
      service: {
        ready: true,
        checks: [
          {
            id: 'database_contract',
            scope: 'institutional',
            status: 'ok',
            detail: 'Configured service dependency is available.',
          },
        ],
      },
    },
    {
      ...readinessReport('ok', 'ok'),
      institutional: {
        ready: true,
        checks: [
          {
            id: 'checkpoint_coverage',
            scope: 'institutional',
            status: 'ok',
            detail: 'Institutional checkpoint evidence is current.',
            measured: { lag: true },
          },
        ],
      },
    },
  ])('refuses empty or internally inconsistent readiness report %#', async (report) => {
    process.env['KF_API_URL'] = 'https://api.example.test';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(report), { status: 200 }),
    );

    await expect(getOperationalReadiness()).rejects.toMatchObject({
      status: 502,
      code: 'invalid_readiness_response',
    });
  });
});
