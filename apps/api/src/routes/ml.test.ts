import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { ActionRequest, ActionResult } from '@kf/actions';
import type { Pool, Tx } from '@kf/database';
import { CallerRejected, type IdentifyCaller } from './actions.js';
import { registerMlRoutes } from './ml.js';

const RUN_AUTHORITY_ID = 'run-authority';
const RUN_REVISION_ID = 'revision-1';
const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222';
const SHA = 'a'.repeat(64);
const SIGNATURE =
  'efn88vev/bfME4h9l1ZqTF+mcn8PLz9fy33s0I3rhtmVgc1cmoSnK3hRNj19OkioP9N+Qljp6+MjbpA5EIVABQ==';
const METRIC_AUTHORITY_ID = 'metric-definition-loss';
const METRIC_REVISION_ID = 'revision-1';
const ALIAS_ID = 'clinical.encoder';
const PROMOTION_RECEIPT_ID = '66666666-6666-7666-8666-666666666666';
const SIGNING_KEY_REGISTRY_ID = '77777777-7777-7777-8777-777777777777';
const PUBLIC_KEY_SPKI = 'MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=';
const PUBLIC_KEY_DIGEST = '06e3fd8fda29bb60ab59557de61edb0aecdb231134be30e75b455f8e1b792fa9';
const EVIDENCE_SET_DIGEST = '9275e80e30f5b54e3e7dc9302601394cf733af647a9afe365576ac94ed0693d1';
const PROMOTION_RECEIPT_DIGEST = 'f3b62abd0705c27c9157ad6d15ca6c389437b1d64d89fe7f49cf69d1ae06d99e';

interface QueryCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function refColumns(prefix: string, authorityId: string, kind: string) {
  return {
    [`${prefix}_kind`]: kind,
    [`${prefix}_authority_id`]: authorityId,
    [`${prefix}_revision_id`]: 'revision-1',
    [`${prefix}_sha256`]: SHA,
    [`${prefix}_classification_id`]: 'internal',
    [`${prefix}_policy_id`]: 'ml-default',
  };
}

function canonicalRefColumns(prefix: string, authorityId: string, kind: string) {
  return {
    [`${prefix}_organization_id`]: ORGANIZATION_ID,
    ...refColumns(prefix, authorityId, kind),
  };
}

function governedAliasRows(sql: string): Record<string, unknown>[] {
  if (sql.includes('/* ml.governed-alias */')) {
    return [
      {
        promotion_receipt_id: PROMOTION_RECEIPT_ID,
        organization_id: ORGANIZATION_ID,
        alias_id: ALIAS_ID,
        run_seal_sha256: '2'.repeat(64),
        evidence_manifest_sha256: EVIDENCE_SET_DIGEST,
        risk_tier: 'regulated',
        promoted_at: new Date('2026-08-14T14:00:00.000Z'),
        promoted_at_has_canonical_precision: true,
        signing_key_id: 'ml-promotion-key-1',
        receipt_sha256: PROMOTION_RECEIPT_DIGEST,
        signature: SIGNATURE,
        ...canonicalRefColumns('candidate', 'candidate-authority', 'candidate'),
        ...canonicalRefColumns('policy', 'metric-policy-authority', 'metric_policy'),
        ...canonicalRefColumns('technical', 'technical-decision', 'evidence'),
        ...canonicalRefColumns('quality', 'quality-decision', 'evidence'),
      },
    ];
  }
  if (sql.includes('/* ml.governed-alias-evidence */')) {
    return [
      {
        ordinal: 1,
        ...canonicalRefColumns('evidence', 'technical-decision', 'evidence'),
      },
      {
        ordinal: 2,
        ...canonicalRefColumns('evidence', 'quality-decision', 'evidence'),
      },
    ];
  }
  if (sql.includes('/* ml.governed-alias-key */')) {
    return [
      {
        organization_id: ORGANIZATION_ID,
        key_registry_id: SIGNING_KEY_REGISTRY_ID,
        key_id: 'ml-promotion-key-1',
        algorithm: 'Ed25519',
        public_key_spki_der_base64: PUBLIC_KEY_SPKI,
        public_key_sha256: PUBLIC_KEY_DIGEST,
        rotates_key_registry_id: null,
        valid_from: new Date('2026-08-01T00:00:00.000Z'),
        // Expiry is prospective for signing. This key remains trusted for a receipt signed
        // inside its window even though it is no longer eligible to sign new receipts.
        valid_until: new Date('2026-08-14T14:00:00.001Z'),
        registered_at: new Date('2026-08-01T00:00:00.000Z'),
        revocation_reason_code: null,
        revoked_at: null,
      },
    ];
  }
  return fixtureRows(sql);
}

function fixtureRows(sql: string): Record<string, unknown>[] {
  if (sql.includes('/* ml.run-lineage */')) {
    return [
      {
        lineage_id: '33333333-3333-7333-8333-333333333333',
        lineage_sha256: 'b'.repeat(64),
        lineage_recorded_at: new Date('2026-08-14T12:00:00.000Z'),
        ...refColumns('run', 'run-authority', 'run'),
        ...refColumns('code', 'code-authority', 'code'),
        ...refColumns('recipe', 'recipe-authority', 'recipe'),
        ...refColumns('environment', 'environment-authority', 'environment'),
        ...refColumns('metric_policy', 'metric-policy-authority', 'metric_policy'),
      },
    ];
  }
  if (sql.includes('/* ml.lineage-members */')) {
    return [
      {
        member_role: 'input',
        ordinal: 1,
        ...refColumns('member', 'input-authority', 'input'),
      },
      {
        member_role: 'output',
        ordinal: 1,
        ...refColumns('member', 'candidate-authority', 'candidate'),
      },
      {
        member_role: 'parent_model',
        ordinal: 1,
        ...refColumns('member', 'parent-authority', 'parent_model'),
      },
    ];
  }
  if (sql.includes('/* ml.metric-events */')) {
    return [
      {
        sequence_no: '41',
        recorded_at: new Date('2026-08-14T12:01:00.000Z'),
        status: 'provisional',
        metric_id: 'validation.loss',
        value_kind: 'number',
        unit_id: 'ratio',
        numeric_value: 0.125,
        enum_value: null,
        timestamp_value: null,
        event_sha256: 'c'.repeat(64),
      },
      {
        sequence_no: '42',
        recorded_at: new Date('2026-08-14T12:02:00.000Z'),
        status: 'provisional',
        metric_id: 'gate.outcome',
        value_kind: 'safe_enum',
        unit_id: null,
        numeric_value: null,
        enum_value: 'pass',
        timestamp_value: null,
        event_sha256: 'd'.repeat(64),
      },
      {
        sequence_no: '43',
        recorded_at: new Date('2026-08-14T12:03:00.000Z'),
        status: 'provisional',
        metric_id: 'run.completed_at',
        value_kind: 'timestamp',
        unit_id: null,
        numeric_value: null,
        enum_value: null,
        timestamp_value: new Date('2026-08-14T12:02:59.000Z'),
        event_sha256: 'e'.repeat(64),
      },
    ];
  }
  if (sql.includes('/* ml.metric-segments */')) {
    return [
      {
        ordinal: 2,
        first_sequence: '41',
        last_sequence: '64',
        event_count: '24',
        metadata_sha256: 'f'.repeat(64),
        ...refColumns('segment', 'segment-authority', 'segment'),
      },
    ];
  }
  if (sql.includes('/* ml.run-seal */')) {
    return [
      {
        lineage_sha256: 'b'.repeat(64),
        segment_manifest_sha256: '1'.repeat(64),
        event_count: '64',
        sealed_at: new Date('2026-08-14T13:00:00.000Z'),
        signing_key_id: 'ml-seal-key-1',
        seal_sha256: '2'.repeat(64),
        recorded_at: new Date('2026-08-14T13:01:00.000Z'),
      },
    ];
  }
  if (sql.includes('/* ml.promotions */')) {
    return [
      {
        alias_id: 'clinical.encoder',
        risk_tier: 'regulated',
        promoted_at: new Date('2026-08-14T14:00:00.000Z'),
        signing_key_id: 'ml-promotion-key-1',
        receipt_sha256: '3'.repeat(64),
        signature: SIGNATURE,
        governed_receipt_sha256: '3'.repeat(64),
        revoked_at: null,
        reason_code: null,
        ...refColumns('candidate', 'candidate-authority', 'candidate'),
        ...refColumns('policy', 'metric-policy-authority', 'metric_policy'),
        ...refColumns('technical', 'technical-decision', 'evidence'),
        ...refColumns('quality', 'quality-decision', 'evidence'),
      },
    ];
  }
  return [];
}

function databaseBoundary(
  rowsFor: (sql: string, params: readonly unknown[]) => Record<string, unknown>[] = fixtureRows,
  schemaAvailable = true,
) {
  const calls: QueryCall[] = [];
  const client = {
    query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      return {
        rows: sql.includes('/* ml.schema-contract */')
          ? [{ available: schemaAvailable }]
          : rowsFor(sql, params),
      };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
  return { pool, calls };
}

function caller(): IdentifyCaller {
  return vi.fn(async () => ({
    actorId: '44444444-4444-7444-8444-444444444444',
    actingRoleId: '55555555-5555-7555-8555-555555555555',
    organizationId: ORGANIZATION_ID,
    maxClassification: 'internal',
    authentication: { authenticatedAt: undefined, assuranceLevel: undefined, methods: [] },
  }));
}

/**
 * The write path a read-route test must never take.
 *
 * `registerMlRoutes` requires an `executeInTransaction`, and every GET-route test below was
 * constructed without one — invisible for as long as test files were outside `tsc`, because
 * nothing on a read path ever calls it.
 *
 * It THROWS rather than returning a plausible result. If a route that only reads ever starts
 * dispatching an action, that is a change to the authority surface and it should fail loudly
 * here, not be absorbed by a stub that quietly answered.
 */
const refuseWrites = async (_tx: Tx, _request: ActionRequest): Promise<ActionResult> => {
  throw new Error('a read-only ML route dispatched an action');
};

function actionExecutor(options: { replayed?: boolean; error?: unknown } = {}) {
  return vi.fn(async (_tx: Tx, _request: ActionRequest): Promise<ActionResult> => {
    if (options.error !== undefined) throw options.error;
    return {
      actionId: '88888888-8888-7888-8888-888888888888',
      status: 'applied',
      replayed: options.replayed ?? false,
      objectIds: [ORGANIZATION_ID],
      auditDigest: '8'.repeat(64),
    };
  });
}

function runUrl(query = ''): string {
  return `/ml/runs/${RUN_AUTHORITY_ID}/revisions/${RUN_REVISION_ID}${query}`;
}

function metricEventUrl(): string {
  return `${runUrl()}/metrics/${METRIC_AUTHORITY_ID}/revisions/${METRIC_REVISION_ID}/events`;
}

function metricEventBody() {
  return {
    idempotencyKey: 'trainer-run-41',
    sequence: 41,
    recordedAt: '2026-08-14T12:01:00.000Z',
    value: { kind: 'number', number: 0.125 },
  };
}

function governedAliasUrl(aliasId = ALIAS_ID): string {
  return `/ml/governed-aliases/${encodeURIComponent(aliasId)}`;
}

describe('GET /ml/governed-aliases/:aliasId', () => {
  it('returns complete canonical receipt and current trusted verification key under RLS', async () => {
    const db = databaseBoundary(governedAliasRows);
    const app = Fastify({ logger: false });
    await registerMlRoutes(app, {
      pool: db.pool,
      identify: caller(),
      executeInTransaction: refuseWrites,
    });

    const response = await app.inject({ method: 'GET', url: governedAliasUrl() });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      schemaVersion: 'kf.ml.governed-alias.v1',
      status: 'active',
      organizationId: ORGANIZATION_ID,
      aliasId: ALIAS_ID,
      receipt: {
        schemaVersion: 'kf.ml.promotion-receipt.v1',
        issuer: 'knowledge-fabric',
        organizationId: ORGANIZATION_ID,
        aliasId: ALIAS_ID,
        candidate: {
          organizationId: ORGANIZATION_ID,
          kind: 'candidate',
          authorityId: 'candidate-authority',
          revisionId: 'revision-1',
          sha256: SHA,
          classificationId: 'internal',
          policyId: 'ml-default',
        },
        runSealDigest: '2'.repeat(64),
        policy: {
          organizationId: ORGANIZATION_ID,
          kind: 'metric_policy',
          authorityId: 'metric-policy-authority',
          revisionId: 'revision-1',
          sha256: SHA,
          classificationId: 'internal',
          policyId: 'ml-default',
        },
        evidence: [
          {
            organizationId: ORGANIZATION_ID,
            kind: 'evidence',
            authorityId: 'technical-decision',
            revisionId: 'revision-1',
            sha256: SHA,
            classificationId: 'internal',
            policyId: 'ml-default',
          },
          {
            organizationId: ORGANIZATION_ID,
            kind: 'evidence',
            authorityId: 'quality-decision',
            revisionId: 'revision-1',
            sha256: SHA,
            classificationId: 'internal',
            policyId: 'ml-default',
          },
        ],
        evidenceSetDigest: EVIDENCE_SET_DIGEST,
        riskTier: 'regulated',
        technicalAuthorityDecision: {
          organizationId: ORGANIZATION_ID,
          kind: 'evidence',
          authorityId: 'technical-decision',
          revisionId: 'revision-1',
          sha256: SHA,
          classificationId: 'internal',
          policyId: 'ml-default',
        },
        qualityAuthorityDecision: {
          organizationId: ORGANIZATION_ID,
          kind: 'evidence',
          authorityId: 'quality-decision',
          revisionId: 'revision-1',
          sha256: SHA,
          classificationId: 'internal',
          policyId: 'ml-default',
        },
        promotedAt: '2026-08-14T14:00:00.000Z',
        signingKeyId: 'ml-promotion-key-1',
        receiptDigest: PROMOTION_RECEIPT_DIGEST,
        signature: SIGNATURE,
      },
      verificationKey: {
        keyRegistryId: SIGNING_KEY_REGISTRY_ID,
        keyId: 'ml-promotion-key-1',
        algorithm: 'Ed25519',
        publicKeySpkiDerBase64: PUBLIC_KEY_SPKI,
        publicKeyDigest: PUBLIC_KEY_DIGEST,
        rotatesKeyRegistryId: null,
        validFrom: '2026-08-01T00:00:00.000Z',
        validUntil: '2026-08-14T14:00:00.001Z',
        registeredAt: '2026-08-01T00:00:00.000Z',
        trustState: 'trusted_for_receipt',
        revocation: null,
      },
    });

    const aliasQuery = db.calls.find(({ sql }) => sql.includes('/* ml.governed-alias */'));
    expect(aliasQuery?.sql).toContain('from ml.governed_alias');
    expect(aliasQuery?.sql).not.toContain('order by receipt.promoted_at');
    expect(aliasQuery?.params).toEqual([ALIAS_ID]);
    expect(
      db.calls.find(({ sql }) => sql.includes('/* ml.governed-alias-evidence */'))?.params,
    ).toEqual([PROMOTION_RECEIPT_ID]);
    expect(db.calls.find(({ sql }) => sql.includes('/* ml.governed-alias-key */'))?.params).toEqual(
      [ORGANIZATION_ID, 'ml-promotion-key-1', '2026-08-14T14:00:00.000Z'],
    );
    expect(db.calls.some(({ sql }) => /\b(?:insert|update|delete)\b/i.test(sql))).toBe(false);
    expect(
      db.calls.find(
        ({ sql }) => sql === 'set transaction isolation level repeatable read, read only',
      ),
    ).toEqual({
      sql: 'set transaction isolation level repeatable read, read only',
      params: [],
    });
    await app.close();
  });

  it('returns indistinguishable unassigned state when latest receipt is revoked and never falls back', async () => {
    const db = databaseBoundary((sql) =>
      sql.includes('/* ml.governed-alias */') ? [] : governedAliasRows(sql),
    );
    const app = Fastify({ logger: false });
    await registerMlRoutes(app, {
      pool: db.pool,
      identify: caller(),
      executeInTransaction: refuseWrites,
    });

    const response = await app.inject({ method: 'GET', url: governedAliasUrl() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      schemaVersion: 'kf.ml.governed-alias.v1',
      status: 'unassigned',
      organizationId: ORGANIZATION_ID,
      aliasId: ALIAS_ID,
    });
    const aliasQuery = db.calls.find(({ sql }) => sql.includes('/* ml.governed-alias */'));
    expect(aliasQuery?.sql).toContain('from ml.governed_alias');
    expect(aliasQuery?.sql).not.toContain('promotion_revocation');
    expect(db.calls.some(({ sql }) => sql.includes('/* ml.governed-alias-key */'))).toBe(false);
    await app.close();
  });

  it.each([
    ['missing', () => []],
    [
      'revoked',
      (sql: string) =>
        governedAliasRows(sql).map((row) =>
          sql.includes('/* ml.governed-alias-key */')
            ? {
                ...row,
                revocation_reason_code: 'key_compromise',
                revoked_at: new Date('2026-08-15T00:00:00.000Z'),
              }
            : row,
        ),
    ],
    [
      'outside receipt validity window',
      (sql: string) =>
        governedAliasRows(sql).map((row) =>
          sql.includes('/* ml.governed-alias-key */')
            ? { ...row, valid_until: new Date('2026-08-14T13:00:00.000Z') }
            : row,
        ),
    ],
    [
      'owned by another organization',
      (sql: string) =>
        governedAliasRows(sql).map((row) =>
          sql.includes('/* ml.governed-alias-key */')
            ? { ...row, organization_id: '88888888-8888-4888-8888-888888888888' }
            : row,
        ),
    ],
    [
      'registered under another key identifier',
      (sql: string) =>
        governedAliasRows(sql).map((row) =>
          sql.includes('/* ml.governed-alias-key */')
            ? { ...row, key_id: 'different-promotion-key' }
            : row,
        ),
    ],
  ])('fails closed when verification key is %s', async (_caseName, keyRows) => {
    const db = databaseBoundary((sql) =>
      sql.includes('/* ml.governed-alias-key */') ? keyRows(sql) : governedAliasRows(sql),
    );
    const app = Fastify({ logger: false });
    await registerMlRoutes(app, {
      pool: db.pool,
      identify: caller(),
      executeInTransaction: refuseWrites,
    });

    const response = await app.inject({ method: 'GET', url: governedAliasUrl() });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: 'governed_alias_unverifiable',
      message: 'governed alias verification material is unavailable',
    });
    expect(response.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it.each([
    ['signature', { signature: Buffer.alloc(64).toString('base64') }],
    ['receipt digest', { receipt_sha256: '4'.repeat(64) }],
    ['evidence-set digest', { evidence_manifest_sha256: '8'.repeat(64) }],
  ])(
    'fails closed without leaking detail when canonical receipt %s is tampered',
    async (_case, tamper) => {
      const db = databaseBoundary((sql) =>
        sql.includes('/* ml.governed-alias */')
          ? governedAliasRows(sql).map((row) => ({ ...row, ...tamper }))
          : governedAliasRows(sql),
      );
      const app = Fastify({ logger: false });
      await registerMlRoutes(app, {
      pool: db.pool,
      identify: caller(),
      executeInTransaction: refuseWrites,
    });

      const response = await app.inject({ method: 'GET', url: governedAliasUrl() });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: 'governed_alias_unverifiable',
        message: 'governed alias verification material is unavailable',
      });
      expect(JSON.stringify(response.json())).not.toMatch(/signature|digest|evidence|key/i);
      await app.close();
    },
  );

  it('decodes and rejects aliases outside governed registry grammar before database access', async () => {
    const db = databaseBoundary(governedAliasRows);
    const app = Fastify({ logger: false });
    await registerMlRoutes(app, {
      pool: db.pool,
      identify: caller(),
      executeInTransaction: refuseWrites,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/ml/governed-aliases/clinical%2Fencoder',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_governed_alias',
      message: 'governed alias must be an opaque lowercase registry identifier',
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(db.calls).toEqual([]);
    await app.close();
  });

  it('uses caller organization RLS and cannot distinguish another organization from no alias', async () => {
    const otherOrganization = '88888888-8888-4888-8888-888888888888';
    const identify: IdentifyCaller = vi.fn(async () => ({
      ...(await caller()({ headers: {} })),
      organizationId: otherOrganization,
    }));
    const db = databaseBoundary((sql) =>
      sql.includes('/* ml.governed-alias */') ? [] : governedAliasRows(sql),
    );
    const app = Fastify({ logger: false });
    await registerMlRoutes(app, { pool: db.pool, identify, executeInTransaction: refuseWrites });

    const response = await app.inject({ method: 'GET', url: governedAliasUrl() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      schemaVersion: 'kf.ml.governed-alias.v1',
      status: 'unassigned',
      organizationId: otherOrganization,
      aliasId: ALIAS_ID,
    });
    expect(
      db.calls.find(({ sql }) => sql === 'select core.set_access_context($1, $2)')?.params,
    ).toEqual([otherOrganization, 'internal']);
    await app.close();
  });
});

describe('GET /ml/runs/:authorityId/revisions/:revisionId', () => {
  it('returns a privacy-minimal, typed and paginated run projection under RLS context', async () => {
    const db = databaseBoundary();
    const app = Fastify({ logger: false });
    await registerMlRoutes(app, {
      pool: db.pool,
      identify: caller(),
      executeInTransaction: refuseWrites,
    });

    const response = await app.inject({
      method: 'GET',
      url: runUrl('?afterSequence=40&limit=2&memberLimit=2&segmentLimit=2&promotionLimit=2'),
      headers: {
        'x-kf-actor': 'actor',
        'x-kf-acting-role': 'role',
        'x-kf-organization': ORGANIZATION_ID,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      schemaVersion: 'kf.ml.run-projection.v1',
      run: {
        kind: 'run',
        authorityId: 'run-authority',
        revisionId: 'revision-1',
        sha256: SHA,
        classificationId: 'internal',
        policyId: 'ml-default',
      },
      lineage: {
        lineageDigest: 'b'.repeat(64),
        recordedAt: '2026-08-14T12:00:00.000Z',
        code: {
          kind: 'code',
          authorityId: 'code-authority',
          revisionId: 'revision-1',
          sha256: SHA,
          classificationId: 'internal',
          policyId: 'ml-default',
        },
        recipe: {
          kind: 'recipe',
          authorityId: 'recipe-authority',
          revisionId: 'revision-1',
          sha256: SHA,
          classificationId: 'internal',
          policyId: 'ml-default',
        },
        environment: {
          kind: 'environment',
          authorityId: 'environment-authority',
          revisionId: 'revision-1',
          sha256: SHA,
          classificationId: 'internal',
          policyId: 'ml-default',
        },
        metricPolicy: {
          kind: 'metric_policy',
          authorityId: 'metric-policy-authority',
          revisionId: 'revision-1',
          sha256: SHA,
          classificationId: 'internal',
          policyId: 'ml-default',
        },
        members: {
          items: [
            {
              role: 'input',
              ordinal: 1,
              reference: {
                kind: 'input',
                authorityId: 'input-authority',
                revisionId: 'revision-1',
                sha256: SHA,
                classificationId: 'internal',
                policyId: 'ml-default',
              },
            },
            {
              role: 'output',
              ordinal: 1,
              reference: {
                kind: 'candidate',
                authorityId: 'candidate-authority',
                revisionId: 'revision-1',
                sha256: SHA,
                classificationId: 'internal',
                policyId: 'ml-default',
              },
            },
          ],
          page: { limit: 2, afterMember: null, nextAfterMember: 'output:1' },
        },
      },
      metrics: {
        events: [
          {
            sequence: '41',
            recordedAt: '2026-08-14T12:01:00.000Z',
            status: 'provisional',
            metricId: 'validation.loss',
            unitId: 'ratio',
            value: { kind: 'number', number: 0.125 },
            eventDigest: 'c'.repeat(64),
          },
          {
            sequence: '42',
            recordedAt: '2026-08-14T12:02:00.000Z',
            status: 'provisional',
            metricId: 'gate.outcome',
            unitId: null,
            value: { kind: 'safe_enum', enumId: 'pass' },
            eventDigest: 'd'.repeat(64),
          },
        ],
        page: { limit: 2, afterSequence: '40', nextAfterSequence: '42' },
      },
      segments: {
        items: [
          {
            reference: {
              kind: 'segment',
              authorityId: 'segment-authority',
              revisionId: 'revision-1',
              sha256: SHA,
              classificationId: 'internal',
              policyId: 'ml-default',
            },
            ordinal: 2,
            firstSequence: '41',
            lastSequence: '64',
            eventCount: '24',
            metadataDigest: 'f'.repeat(64),
          },
        ],
        page: { limit: 2, afterOrdinal: 0, nextAfterOrdinal: null },
      },
      seal: {
        lineageDigest: 'b'.repeat(64),
        segmentManifestDigest: '1'.repeat(64),
        eventCount: '64',
        sealedAt: '2026-08-14T13:00:00.000Z',
        signingKeyId: 'ml-seal-key-1',
        sealDigest: '2'.repeat(64),
        recordedAt: '2026-08-14T13:01:00.000Z',
      },
      promotions: {
        receipts: [
          {
            aliasId: 'clinical.encoder',
            candidate: {
              kind: 'candidate',
              authorityId: 'candidate-authority',
              revisionId: 'revision-1',
              sha256: SHA,
              classificationId: 'internal',
              policyId: 'ml-default',
            },
            policy: {
              kind: 'metric_policy',
              authorityId: 'metric-policy-authority',
              revisionId: 'revision-1',
              sha256: SHA,
              classificationId: 'internal',
              policyId: 'ml-default',
            },
            riskTier: 'regulated',
            technicalAuthorityDecision: {
              kind: 'evidence',
              authorityId: 'technical-decision',
              revisionId: 'revision-1',
              sha256: SHA,
              classificationId: 'internal',
              policyId: 'ml-default',
            },
            qualityAuthorityDecision: {
              kind: 'evidence',
              authorityId: 'quality-decision',
              revisionId: 'revision-1',
              sha256: SHA,
              classificationId: 'internal',
              policyId: 'ml-default',
            },
            promotedAt: '2026-08-14T14:00:00.000Z',
            signingKeyId: 'ml-promotion-key-1',
            receiptDigest: '3'.repeat(64),
            signature: SIGNATURE,
            status: 'recorded',
            revocation: null,
          },
        ],
        page: { limit: 2, afterReceiptDigest: null, nextAfterReceiptDigest: null },
      },
    });

    const statements = db.calls.filter(
      ({ sql }) => sql !== 'begin' && sql !== 'commit' && sql !== 'rollback',
    );
    expect(statements[0]).toEqual({
      sql: 'set transaction isolation level repeatable read, read only',
      params: [],
    });
    expect(statements[1]).toEqual({
      sql: 'select core.set_access_context($1, $2)',
      params: [ORGANIZATION_ID, 'internal'],
    });
    const lineageQuery = statements.find(({ sql }) => sql.includes('/* ml.run-lineage */'));
    expect(lineageQuery?.params).toEqual([RUN_AUTHORITY_ID, RUN_REVISION_ID]);
    const memberQuery = statements.find(({ sql }) => sql.includes('/* ml.lineage-members */'));
    expect(memberQuery?.params).toEqual(['33333333-3333-7333-8333-333333333333', 0, 0, 3]);
    const eventQuery = statements.find(({ sql }) => sql.includes('/* ml.metric-events */'));
    expect(eventQuery?.params).toEqual(['33333333-3333-7333-8333-333333333333', '40', 3]);
    const segmentQuery = statements.find(({ sql }) => sql.includes('/* ml.metric-segments */'));
    expect(segmentQuery?.params).toEqual(['33333333-3333-7333-8333-333333333333', 0, 3]);
    const promotionQuery = statements.find(({ sql }) => sql.includes('/* ml.promotions */'));
    expect(promotionQuery?.params).toEqual(['33333333-3333-7333-8333-333333333333', null, 3]);
    expect(JSON.stringify(response.json())).not.toMatch(
      /subject|session|sample|label|free.?text|file.?path|object.?store|idempotency/i,
    );

    await app.close();
  });

  it('does not disclose unexpected identity failures or open a database transaction', async () => {
    const db = databaseBoundary();
    const identify: IdentifyCaller = vi.fn(async () => {
      throw new Error('subject row at /private/patient-42 failed');
    });
    const app = Fastify({ logger: false });
    await registerMlRoutes(app, { pool: db.pool, identify, executeInTransaction: refuseWrites });

    const response = await app.inject({ method: 'GET', url: runUrl() });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: 'internal_error' });
    expect(JSON.stringify(response.json())).not.toMatch(/subject|patient|private/i);
    expect(db.calls).toEqual([]);
    await app.close();
  });

  it('returns a controlled caller refusal as 401 without opening a transaction', async () => {
    const db = databaseBoundary();
    const identify: IdentifyCaller = vi.fn(async () => {
      throw new CallerRejected('x-kf-actor is required');
    });
    const app = Fastify({ logger: false });
    await registerMlRoutes(app, { pool: db.pool, identify, executeInTransaction: refuseWrites });

    const response = await app.inject({ method: 'GET', url: runUrl() });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: 'caller_unidentified',
      message: 'x-kf-actor is required',
    });
    expect(db.calls).toEqual([]);
    await app.close();
  });

  it('rejects ambiguous or out-of-range pagination before opening a transaction', async () => {
    const db = databaseBoundary();
    const app = Fastify({ logger: false });
    await registerMlRoutes(app, {
      pool: db.pool,
      identify: caller(),
      executeInTransaction: refuseWrites,
    });

    const [
      ambiguous,
      oversized,
      negativeCursor,
      oversizedMembers,
      malformedMember,
      negativeOrdinal,
      malformedReceipt,
    ] = await Promise.all([
      app.inject({ method: 'GET', url: runUrl('?limit=1&limit=2') }),
      app.inject({ method: 'GET', url: runUrl('?limit=501') }),
      app.inject({ method: 'GET', url: runUrl('?afterSequence=-1') }),
      app.inject({ method: 'GET', url: runUrl('?memberLimit=501') }),
      app.inject({ method: 'GET', url: runUrl('?afterMember=input:-1') }),
      app.inject({ method: 'GET', url: runUrl('?afterOrdinal=-1') }),
      app.inject({ method: 'GET', url: runUrl('?afterReceiptDigest=not-a-digest') }),
    ]);

    expect(ambiguous.statusCode).toBe(400);
    expect(oversized.statusCode).toBe(400);
    expect(negativeCursor.statusCode).toBe(400);
    expect(oversizedMembers.statusCode).toBe(400);
    expect(malformedMember.statusCode).toBe(400);
    expect(negativeOrdinal.statusCode).toBe(400);
    expect(malformedReceipt.statusCode).toBe(400);
    expect(db.calls).toEqual([]);
    await app.close();
  });

  it('rejects run references outside the registry opaque-token grammar', async () => {
    const db = databaseBoundary();
    const app = Fastify({ logger: false });
    await registerMlRoutes(app, {
      pool: db.pool,
      identify: caller(),
      executeInTransaction: refuseWrites,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/ml/runs/patient%20name/revisions/revision-1',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_run_reference',
      message: 'run authority and revision must be opaque registry identifiers',
    });
    expect(db.calls).toEqual([]);
    await app.close();
  });

  it('returns not found when RLS makes the run invisible', async () => {
    const db = databaseBoundary((sql) =>
      sql.includes('/* ml.run-lineage */') ? [] : fixtureRows(sql),
    );
    const app = Fastify({ logger: false });
    await registerMlRoutes(app, {
      pool: db.pool,
      identify: caller(),
      executeInTransaction: refuseWrites,
    });

    const response = await app.inject({ method: 'GET', url: runUrl() });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
    const statements = db.calls.filter(
      ({ sql }) => sql !== 'begin' && sql !== 'commit' && sql !== 'rollback',
    );
    expect(statements.map(({ sql }) => sql)).toHaveLength(4);
    expect(statements[0]?.sql).toBe('set transaction isolation level repeatable read, read only');
    expect(statements[1]?.sql).toBe('select core.set_access_context($1, $2)');
    expect(statements[2]?.sql).toContain('/* ml.schema-contract */');
    expect(statements[3]?.sql).toContain('/* ml.run-lineage */');
    await app.close();
  });

  it('refuses projection when required ML schema contract is unavailable', async () => {
    const db = databaseBoundary(fixtureRows, false);
    const app = Fastify({ logger: false });
    await registerMlRoutes(app, {
      pool: db.pool,
      identify: caller(),
      executeInTransaction: refuseWrites,
    });

    const response = await app.inject({ method: 'GET', url: runUrl() });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'ml_schema_unavailable' });
    expect(db.calls.some(({ sql }) => sql.includes('/* ml.run-lineage */'))).toBe(false);
    await app.close();
  });

  it('projects timestamp metrics without inventing a seal or promotion', async () => {
    const db = databaseBoundary((sql) => {
      if (sql.includes('/* ml.metric-events */')) return fixtureRows(sql).slice(2, 3);
      if (
        sql.includes('/* ml.metric-segments */') ||
        sql.includes('/* ml.run-seal */') ||
        sql.includes('/* ml.promotions */')
      ) {
        return [];
      }
      return fixtureRows(sql);
    });
    const app = Fastify({ logger: false });
    await registerMlRoutes(app, {
      pool: db.pool,
      identify: caller(),
      executeInTransaction: refuseWrites,
    });

    const response = await app.inject({ method: 'GET', url: runUrl() });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.metrics).toEqual({
      events: [
        {
          sequence: '43',
          recordedAt: '2026-08-14T12:03:00.000Z',
          status: 'provisional',
          metricId: 'run.completed_at',
          unitId: null,
          value: { kind: 'timestamp', timestamp: '2026-08-14T12:02:59.000Z' },
          eventDigest: 'e'.repeat(64),
        },
      ],
      page: { limit: 100, afterSequence: '0', nextAfterSequence: null },
    });
    expect(body.seal).toBeNull();
    expect(body.promotions).toEqual({
      receipts: [],
      page: { limit: 100, afterReceiptDigest: null, nextAfterReceiptDigest: null },
    });
    await app.close();
  });

  it('does not disclose database failures to callers', async () => {
    const db = databaseBoundary((sql) => {
      if (sql.includes('/* ml.run-lineage */')) {
        throw new Error('subject row at /private/patient-42 failed');
      }
      return fixtureRows(sql);
    });
    const app = Fastify({ logger: false });
    await registerMlRoutes(app, {
      pool: db.pool,
      identify: caller(),
      executeInTransaction: refuseWrites,
    });

    const response = await app.inject({ method: 'GET', url: runUrl() });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: 'internal_error' });
    expect(JSON.stringify(response.json())).not.toMatch(/subject|patient|private/i);
    await app.close();
  });

  it.each([
    [
      'an unknown run aggregate kind',
      (sql: string, row: Record<string, unknown>) =>
        sql.includes('/* ml.run-lineage */') ? { ...row, run_kind: 'dataset' } : row,
    ],
    [
      'a run identity that disagrees with the requested authority',
      (sql: string, row: Record<string, unknown>) =>
        sql.includes('/* ml.run-lineage */') ? { ...row, run_authority_id: 'another-run' } : row,
    ],
    [
      'a lineage role and aggregate-kind mismatch',
      (sql: string, row: Record<string, unknown>) =>
        sql.includes('/* ml.lineage-members */') && row['member_role'] === 'input'
          ? { ...row, member_kind: 'candidate' }
          : row,
    ],
    [
      'a partially null quality-authority reference',
      (sql: string, row: Record<string, unknown>) =>
        sql.includes('/* ml.promotions */')
          ? { ...row, quality_kind: null, quality_authority_id: 'quality-decision' }
          : row,
    ],
    [
      'a promotion receipt without Quality Authority evidence',
      (sql: string, row: Record<string, unknown>) =>
        sql.includes('/* ml.promotions */')
          ? {
              ...row,
              quality_kind: null,
              quality_authority_id: null,
              quality_revision_id: null,
              quality_sha256: null,
              quality_classification_id: null,
              quality_policy_id: null,
            }
          : row,
    ],
    [
      'a seal that names another lineage digest',
      (sql: string, row: Record<string, unknown>) =>
        sql.includes('/* ml.run-seal */') ? { ...row, lineage_sha256: '0'.repeat(64) } : row,
    ],
    [
      'a noncanonical microsecond timestamp from a custom database parser',
      (sql: string, row: Record<string, unknown>) =>
        sql.includes('/* ml.run-lineage */')
          ? { ...row, lineage_recorded_at: '2026-08-14T12:00:00.000001Z' }
          : row,
    ],
    [
      'a year-zero timestamp decoded as a Date',
      (sql: string, row: Record<string, unknown>) =>
        sql.includes('/* ml.run-lineage */')
          ? { ...row, lineage_recorded_at: new Date('0000-08-14T12:00:00.000Z') }
          : row,
    ],
    [
      'an extended-year timestamp decoded as a Date',
      (sql: string, row: Record<string, unknown>) =>
        sql.includes('/* ml.run-lineage */')
          ? { ...row, lineage_recorded_at: new Date('+010000-08-14T12:00:00.000Z') }
          : row,
    ],
  ])('fails closed when database returns %s', async (_caseName, mutate) => {
    const db = databaseBoundary((sql) => fixtureRows(sql).map((row) => mutate(sql, row)));
    const app = Fastify({ logger: false });
    await registerMlRoutes(app, {
      pool: db.pool,
      identify: caller(),
      executeInTransaction: refuseWrites,
    });

    const response = await app.inject({ method: 'GET', url: runUrl() });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: 'internal_error' });
    expect(JSON.stringify(response.json())).not.toMatch(/dataset|quality-decision|candidate/i);
    await app.close();
  });

  it('reports receipt-local state without claiming a governed alias resolution through RLS', async () => {
    const db = databaseBoundary((sql) => {
      if (!sql.includes('/* ml.promotions */')) return fixtureRows(sql);
      const active = fixtureRows(sql)[0]!;
      return [
        {
          ...active,
          alias_id: 'clinical.revoked',
          receipt_sha256: '4'.repeat(64),
          governed_receipt_sha256: null,
          revoked_at: new Date('2026-08-14T15:00:00.000Z'),
          reason_code: 'policy_violation',
        },
        {
          ...active,
          alias_id: 'clinical.superseded',
          receipt_sha256: '5'.repeat(64),
          governed_receipt_sha256: null,
        },
        active,
      ];
    });
    const app = Fastify({ logger: false });
    await registerMlRoutes(app, {
      pool: db.pool,
      identify: caller(),
      executeInTransaction: refuseWrites,
    });

    const response = await app.inject({ method: 'GET', url: runUrl() });
    const promotions = response.json().promotions.receipts;

    expect(response.statusCode).toBe(200);
    expect(promotions.map(({ status }: { status: string }) => status)).toEqual([
      'revoked',
      'recorded',
      'recorded',
    ]);
    expect(promotions[0]).toMatchObject({
      qualityAuthorityDecision: {
        kind: 'evidence',
        authorityId: 'quality-decision',
      },
      revocation: {
        reasonCode: 'policy_violation',
        revokedAt: '2026-08-14T15:00:00.000Z',
      },
    });
    const promotionQuery = db.calls.find(({ sql }) => sql.includes('/* ml.promotions */'));
    expect(promotionQuery?.sql).not.toContain('governed_alias');
    await app.close();
  });
});

describe('POST /ml/runs/:authorityId/revisions/:revisionId/metrics/:metricAuthorityId/revisions/:metricRevisionId/events', () => {
  function ingestionRows(sql: string, params: readonly unknown[] = []): Record<string, unknown>[] {
    if (sql.includes('/* ml.ingest-run */')) {
      return [
        {
          lineage_id: '33333333-3333-7333-8333-333333333333',
          run_organization_id: ORGANIZATION_ID,
          ...refColumns('run', RUN_AUTHORITY_ID, 'run'),
        },
      ];
    }
    if (sql.includes('/* ml.ingest-definition */')) {
      return [
        {
          definition_id: '66666666-6666-7666-8666-666666666666',
          definition_organization_id: ORGANIZATION_ID,
          metric_id: 'validation.loss',
          value_kind: 'number',
          unit_id: 'ratio',
          allowed_enum_ids: [],
          ...refColumns('definition', METRIC_AUTHORITY_ID, 'metric_definition'),
        },
      ];
    }
    if (sql.includes('/* ml.ingest-receipt */')) {
      return [
        {
          id: '77777777-7777-7777-8777-777777777777',
          sequence_no: '41',
          recorded_at: new Date('2026-08-14T12:01:00.000Z'),
          status: 'provisional',
          event_sha256: typeof params[3] === 'string' ? params[3] : '9'.repeat(64),
        },
      ];
    }
    return [];
  }

  it('validates and appends one typed metric event under caller RLS context', async () => {
    const db = databaseBoundary(ingestionRows);
    const executeInTransaction = actionExecutor();
    const app = Fastify({ logger: false });
    await registerMlRoutes(app, { pool: db.pool, identify: caller(), executeInTransaction });

    const response = await app.inject({
      method: 'POST',
      url: metricEventUrl(),
      payload: metricEventBody(),
    });

    expect(executeInTransaction).toHaveBeenCalledOnce();
    const actionRequest = executeInTransaction.mock.calls[0]![1];
    const eventDigest = actionRequest.payload?.['eventDigest'];
    expect(eventDigest).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      schemaVersion: 'kf.ml.metric-event-receipt.v1',
      replayed: false,
      run: { authorityId: RUN_AUTHORITY_ID, revisionId: RUN_REVISION_ID },
      metricDefinition: {
        authorityId: METRIC_AUTHORITY_ID,
        revisionId: METRIC_REVISION_ID,
        metricId: 'validation.loss',
      },
      event: {
        sequence: '41',
        recordedAt: '2026-08-14T12:01:00.000Z',
        status: 'provisional',
        value: { kind: 'number', number: 0.125 },
        eventDigest,
      },
    });

    expect(actionRequest).toEqual({
      actionType: 'append_ml_metric_event',
      actorId: '44444444-4444-7444-8444-444444444444',
      actingRoleId: '55555555-5555-7555-8555-555555555555',
      targetIds: [ORGANIZATION_ID],
      payload: {
        runLineageId: '33333333-3333-7333-8333-333333333333',
        metricDefinitionId: '66666666-6666-7666-8666-666666666666',
        idempotencyKey: 'trainer-run-41',
        sequence: 41,
        recordedAt: '2026-08-14T12:01:00.000Z',
        value: { kind: 'number', number: 0.125 },
        eventDigest,
      },
      idempotencyKey: `ml-event:${eventDigest as string}`,
      organizationId: ORGANIZATION_ID,
      maxClassification: 'internal',
      requestId: expect.any(String),
    });

    const statements = db.calls.filter(
      ({ sql }) => sql !== 'begin' && sql !== 'commit' && sql !== 'rollback',
    );
    expect(statements[0]).toEqual({
      sql: 'select core.set_access_context($1, $2)',
      params: [ORGANIZATION_ID, 'internal'],
    });
    expect(statements.some(({ sql }) => sql.includes('set_transaction_context'))).toBe(false);
    expect(statements.find(({ sql }) => sql.includes('/* ml.ingest-run */'))?.params).toEqual([
      RUN_AUTHORITY_ID,
      RUN_REVISION_ID,
    ]);
    expect(
      statements.find(({ sql }) => sql.includes('/* ml.ingest-definition */'))?.params,
    ).toEqual([METRIC_AUTHORITY_ID, METRIC_REVISION_ID]);
    const receipt = statements.find(({ sql }) => sql.includes('/* ml.ingest-receipt */'));
    expect(receipt?.params).toEqual([
      '33333333-3333-7333-8333-333333333333',
      '66666666-6666-7666-8666-666666666666',
      'trainer-run-41',
      eventDigest,
    ]);
    expect(JSON.stringify(response.json())).not.toMatch(
      /organization|subject|session|sample|label|free.?text|file.?path|object.?store/i,
    );
    await app.close();
  });

  it('returns exact database replay as 200 without inventing a second event', async () => {
    const db = databaseBoundary(ingestionRows);
    const executeInTransaction = actionExecutor({ replayed: true });
    const app = Fastify({ logger: false });
    await registerMlRoutes(app, { pool: db.pool, identify: caller(), executeInTransaction });

    const response = await app.inject({
      method: 'POST',
      url: metricEventUrl(),
      payload: metricEventBody(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ replayed: true });
    expect(executeInTransaction).toHaveBeenCalledOnce();
    expect(db.calls.filter(({ sql }) => sql.includes('/* ml.ingest-receipt */'))).toHaveLength(1);
    await app.close();
  });

  it('logs a stored metric receipt integrity failure and returns a generic server error', async () => {
    const db = databaseBoundary((sql, params) =>
      ingestionRows(sql, params).map((row) =>
        sql.includes('/* ml.ingest-receipt */')
          ? { ...row, sequence_no: '42', status: 'finalized' }
          : row,
      ),
    );
    const executeInTransaction = actionExecutor();
    const app = Fastify({ logger: false });
    const logError = vi.spyOn(app.log, 'error');
    await registerMlRoutes(app, { pool: db.pool, identify: caller(), executeInTransaction });

    const response = await app.inject({
      method: 'POST',
      url: metricEventUrl(),
      payload: metricEventBody(),
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: 'internal_error',
      requestId: expect.any(String),
    });
    expect(JSON.stringify(response.json())).not.toMatch(/stored|receipt|sequence|finalized/i);
    expect(logError).toHaveBeenCalledOnce();
    expect(executeInTransaction).toHaveBeenCalledOnce();
    await app.close();
  });

  it('rejects malformed, open, or mismatched metric values before append', async () => {
    const db = databaseBoundary(ingestionRows);
    const executeInTransaction = actionExecutor();
    const app = Fastify({ logger: false });
    await registerMlRoutes(app, { pool: db.pool, identify: caller(), executeInTransaction });

    const [extra, badTimestamp, badKind] = await Promise.all([
      app.inject({
        method: 'POST',
        url: metricEventUrl(),
        payload: { ...metricEventBody(), subjectId: 'patient-42' },
      }),
      app.inject({
        method: 'POST',
        url: metricEventUrl(),
        payload: { ...metricEventBody(), recordedAt: '2026-08-14T12:01:00Z' },
      }),
      app.inject({
        method: 'POST',
        url: metricEventUrl(),
        payload: { ...metricEventBody(), value: { kind: 'safe_enum', enumId: 'pass' } },
      }),
    ]);

    expect(extra.statusCode).toBe(400);
    expect(badTimestamp.statusCode).toBe(400);
    expect(badKind.statusCode).toBe(400);
    expect(badKind.json()).toMatchObject({ error: 'invalid_metric_event' });
    expect(executeInTransaction).not.toHaveBeenCalled();
    expect(db.calls.filter(({ sql }) => sql.includes('/* ml.ingest-receipt */'))).toHaveLength(0);
    await app.close();
  });

  it('rejects structurally invalid metric input before opening a database transaction', async () => {
    const db = databaseBoundary(ingestionRows);
    const executeInTransaction = actionExecutor();
    const app = Fastify({ logger: false });
    await registerMlRoutes(app, { pool: db.pool, identify: caller(), executeInTransaction });

    const response = await app.inject({
      method: 'POST',
      url: metricEventUrl(),
      payload: { ...metricEventBody(), sequence: '41' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_metric_event' });
    expect(db.calls).toHaveLength(0);
    expect(executeInTransaction).not.toHaveBeenCalled();
    await app.close();
  });

  it('uses non-disclosing not-found responses for invisible run or metric references', async () => {
    const db = databaseBoundary((sql) => {
      if (sql.includes('/* ml.ingest-definition */')) return [];
      return ingestionRows(sql);
    });
    const executeInTransaction = actionExecutor();
    const app = Fastify({ logger: false });
    await registerMlRoutes(app, { pool: db.pool, identify: caller(), executeInTransaction });

    const response = await app.inject({
      method: 'POST',
      url: metricEventUrl(),
      payload: metricEventBody(),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
    expect(executeInTransaction).not.toHaveBeenCalled();
    expect(db.calls.filter(({ sql }) => sql.includes('/* ml.ingest-receipt */'))).toHaveLength(0);
    await app.close();
  });

  it('maps a sealed-run refusal to conflict without leaking database details', async () => {
    const db = databaseBoundary(ingestionRows);
    const executeInTransaction = actionExecutor({
      error: Object.assign(new Error('sealed run cannot accept new metric events'), {
        code: '23514',
      }),
    });
    const app = Fastify({ logger: false });
    await registerMlRoutes(app, { pool: db.pool, identify: caller(), executeInTransaction });

    const response = await app.inject({
      method: 'POST',
      url: metricEventUrl(),
      payload: metricEventBody(),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'run_sealed',
      message: 'sealed runs cannot accept new metric events',
    });
    await app.close();
  });
});
