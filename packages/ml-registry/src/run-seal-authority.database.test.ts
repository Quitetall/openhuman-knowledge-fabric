import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digest } from '@kf/canonicalization';
import { withTransaction, type Tx } from '@kf/database';
import {
  createMetricSegment,
  createRunLineage,
  signRunSeal,
  type AggregateKind,
  type AggregateReference,
  type MetricSegment,
  type SignedRunSeal,
} from './index.js';
import {
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from '../../../tests/database/harness.js';

const OTHER_ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222';
const SEALED_AT = '2026-08-15T08:30:00.000Z';
const WORKLOAD = 'spiffe:kf.internal:blut:sealer';
const MIGRATION_PATH = join(
  import.meta.dirname,
  '../../../database/migrations/20260814001300_ml_run_seal_authority.sql',
);

let harness: Harness;
let fixtures: Fixtures;

interface StoredReference {
  readonly id: string;
  readonly reference: AggregateReference;
}

interface PreparedRun {
  readonly lineageId: string;
  readonly lineage: ReturnType<typeof createRunLineage>;
  readonly segment: MetricSegment;
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function migrationSection(sql: string, section: 'up' | 'down'): string {
  const marker = `-- migrate:${section}`;
  const start = sql.indexOf(marker);
  const end = section === 'up' ? sql.indexOf('-- migrate:down', start + marker.length) : sql.length;
  if (start < 0 || end < 0) throw new Error(`migration has no ${section} section`);
  return sql.slice(start + marker.length, end);
}

async function insertReference(
  tx: Tx,
  kind: AggregateKind,
  authorityId: string,
  organizationId: string = fixtures.organizationId,
): Promise<StoredReference> {
  const reference: AggregateReference = {
    organizationId,
    kind,
    authorityId,
    revisionId: 'revision-1',
    sha256: sha(`aggregate:${organizationId}:${kind}:${authorityId}`),
    classificationId: 'internal',
    policyId: 'ml-default',
  };
  const row = await tx.one<{ id: string }>(
    `insert into ml.aggregate_reference
       (organization_id, aggregate_kind, authority_id, revision_id, sha256,
        classification_id, policy_id)
     values ($1,$2,$3,$4,$5,$6,$7)
     returning id`,
    [
      reference.organizationId,
      reference.kind,
      reference.authorityId,
      reference.revisionId,
      reference.sha256,
      reference.classificationId,
      reference.policyId,
    ],
  );
  return { id: row.id, reference };
}

async function prepareRun(
  tx: Tx,
  suffix: string,
  options: {
    readonly eventSequences?: readonly number[];
    readonly segmentEventDigests?: readonly string[];
    readonly segmentLastSequence?: number;
    readonly storedLineageDigest?: string;
    readonly storedSegmentDigest?: string;
  } = {},
): Promise<PreparedRun> {
  const run = await insertReference(tx, 'run', `run-${suffix}`);
  const code = await insertReference(tx, 'code', `code-${suffix}`);
  const recipe = await insertReference(tx, 'recipe', `recipe-${suffix}`);
  const environment = await insertReference(tx, 'environment', `environment-${suffix}`);
  const policy = await insertReference(tx, 'metric_policy', `policy-${suffix}`);
  const input = await insertReference(tx, 'input', `input-${suffix}`);
  const output = await insertReference(tx, 'output', `output-${suffix}`);
  const parent = await insertReference(tx, 'parent_model', `parent-${suffix}`);
  const definitionReference = await insertReference(
    tx,
    'metric_definition',
    `metric-definition-${suffix}`,
  );
  const segmentReference = await insertReference(tx, 'segment', `segment-${suffix}`);
  const lineage = createRunLineage({
    run: run.reference,
    code: code.reference,
    recipe: recipe.reference,
    environment: environment.reference,
    metricPolicy: policy.reference,
    inputs: [input.reference],
    outputs: [output.reference],
    parentModels: [parent.reference],
  });
  const lineageRow = await tx.one<{ id: string }>(
    `insert into ml.run_lineage
       (run_ref_id, code_ref_id, recipe_ref_id, environment_ref_id,
        metric_policy_ref_id, lineage_sha256)
     values ($1,$2,$3,$4,$5,$6)
     returning id`,
    [
      run.id,
      code.id,
      recipe.id,
      environment.id,
      policy.id,
      options.storedLineageDigest ?? digest(lineage),
    ],
  );
  await tx.query(
    `insert into ml.run_lineage_input (run_lineage_id, ordinal, aggregate_ref_id)
     values ($1,1,$2)`,
    [lineageRow.id, input.id],
  );
  await tx.query(
    `insert into ml.run_lineage_output (run_lineage_id, ordinal, aggregate_ref_id)
     values ($1,1,$2)`,
    [lineageRow.id, output.id],
  );
  await tx.query(
    `insert into ml.run_lineage_parent_model (run_lineage_id, ordinal, aggregate_ref_id)
     values ($1,1,$2)`,
    [lineageRow.id, parent.id],
  );

  const definition = await tx.one<{ id: string }>(
    `insert into ml.metric_definition
       (definition_ref_id, metric_id, value_kind, unit_id, allowed_enum_ids)
     values ($1,'validation.loss','number','ratio','{}')
     returning id`,
    [definitionReference.id],
  );
  const authorization = await tx.one<{ id: string }>(
    `insert into ml.metric_write_authorization
       (organization_id, actor_id, acting_role_id, run_lineage_id,
        metric_definition_id, metric_policy_ref_id, authorization_sha256, authorized_at,
        schema_version)
     values ($1,$2,$3,$4,$5,$6,$7,'2026-08-15T08:00:00.000Z',1)
     returning id`,
    [
      fixtures.organizationId,
      fixtures.performerId,
      fixtures.performerRoleId,
      lineageRow.id,
      definition.id,
      policy.id,
      sha(`authorization:${suffix}`),
    ],
  );
  const eventSequences = options.eventSequences ?? [1];
  const eventDigests = eventSequences.map((sequence) => sha(`event:${suffix}:${sequence}`));
  for (const sequence of eventSequences) {
    await tx.query(
      `insert into ml.metric_event
         (run_lineage_id, metric_definition_id, metric_write_authorization_id,
          idempotency_key, sequence_no, recorded_at, numeric_value, event_sha256)
       values ($1,$2,$3,$4,$5,'2026-08-15T08:10:00.000Z',$6,$7)`,
      [
        lineageRow.id,
        definition.id,
        authorization.id,
        `event-${suffix}-${sequence}`,
        sequence,
        sequence / 10,
        eventDigests[eventSequences.indexOf(sequence)],
      ],
    );
  }

  const lastSequence = options.segmentLastSequence ?? eventSequences.length;
  const segment = createMetricSegment({
    segment: segmentReference.reference,
    run: run.reference,
    ordinal: 1,
    firstSequence: 1,
    lastSequence,
    eventCount: lastSequence,
    eventDigests: options.segmentEventDigests ?? eventDigests,
  });
  await tx.query(
    `insert into ml.metric_segment
       (segment_ref_id, run_lineage_id, ordinal, first_sequence, last_sequence,
        event_count, schema_version, event_manifest, event_manifest_sha256, metadata_sha256)
     values ($1,$2,1,1,$3,$3,2,$4::text[],$5,$6)`,
    [
      segmentReference.id,
      lineageRow.id,
      lastSequence,
      segment.eventDigests,
      segment.eventManifestDigest,
      options.storedSegmentDigest ?? segment.metadataDigest,
    ],
  );
  return { lineageId: lineageRow.id, lineage, segment };
}

async function registerRunSealKey(
  tx: Tx,
  keyId: string,
  publicKey: KeyObject,
  options: {
    readonly workload?: string;
    readonly validFrom?: string;
    readonly validUntil?: string | null;
    readonly rotatesKeyRegistryId?: string | null;
  } = {},
): Promise<string> {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const row = await tx.one<{ id: string }>(
    `insert into ml.run_seal_signing_key
       (organization_id, workload_identity_ref, key_id, algorithm,
        public_key_spki_der_base64, public_key_sha256, rotates_key_registry_id,
        valid_from, valid_until, registered_at)
     values ($1,$2,$3,'Ed25519',$4,$5,$6,$7,$8,'2026-08-15T00:00:00.000Z')
     returning id`,
    [
      fixtures.organizationId,
      options.workload ?? WORKLOAD,
      keyId,
      der.toString('base64'),
      createHash('sha256').update(der).digest('hex'),
      options.rotatesKeyRegistryId ?? null,
      options.validFrom ?? '2020-01-01T00:00:00.000Z',
      options.validUntil === undefined ? '2099-01-01T00:00:00.000Z' : options.validUntil,
    ],
  );
  return row.id;
}

function signedSeal(prepared: PreparedRun, keyId: string, privateKey: KeyObject, at = SEALED_AT) {
  return signRunSeal(
    { lineage: prepared.lineage, segments: [prepared.segment], sealedAt: at },
    { id: keyId, privateKey },
  );
}

async function appendSeal(
  prepared: PreparedRun,
  seal: SignedRunSeal,
  options: {
    readonly organizationId?: string;
    readonly contextOrganizationId?: string;
    readonly workload?: string;
    readonly sealedAt?: string;
    readonly signingKeyId?: string;
    readonly sealDigest?: string;
    readonly signature?: string;
  } = {},
) {
  const organizationId = options.organizationId ?? fixtures.organizationId;
  return withTransaction(harness.adminPool, async (tx) => {
    await tx.query('set local role kf_ml_promoter');
    await tx.query('select core.set_access_context($1, $2)', [
      options.contextOrganizationId ?? fixtures.organizationId,
      'restricted',
    ]);
    return tx.one<{ id: string; seal_sha256: string; signing_key_registry_id: string }>(
      `select * from ml.append_signed_run_seal($1,$2,$3,$4,$5,$6,$7)`,
      [
        organizationId,
        prepared.lineageId,
        options.workload ?? WORKLOAD,
        options.sealedAt ?? seal.sealedAt,
        options.signingKeyId ?? seal.signingKeyId,
        options.sealDigest ?? seal.sealDigest,
        options.signature ?? seal.signature,
      ],
    );
  });
}

beforeAll(async () => {
  harness = await startHarness();
  fixtures = await seedFixtures(harness.adminPool);
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

describe('database-verified BLUT run-seal authority', () => {
  it('rebuilds the exact TypeScript JCS records and verifies the canonical Ed25519 signature', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyId = 'blut-run-seal-success';
    const prepared = await withTransaction(harness.adminPool, async (tx) => {
      const run = await prepareRun(tx, 'success');
      const keyRegistryId = await registerRunSealKey(tx, keyId, publicKey);
      return { ...run, keyRegistryId };
    });
    const seal = signedSeal(prepared, keyId, privateKey);

    const appended = await appendSeal(prepared, seal);
    expect(appended).toEqual({
      id: expect.any(String),
      seal_sha256: seal.sealDigest,
      signing_key_registry_id: prepared.keyRegistryId,
    });

    const stored = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{
        lineage_sha256: string;
        segment_manifest: string[];
        segment_manifest_sha256: string;
        event_manifest_sha256: string;
        event_count: string;
        sealed_at: Date;
        signing_key_id: string;
        signing_key_registry_id: string;
        seal_sha256: string;
      }>('select * from ml.run_seal where id = $1', [appended.id]),
    );
    expect(stored).toEqual(
      expect.objectContaining({
        lineage_sha256: digest(prepared.lineage),
        segment_manifest: [prepared.segment.metadataDigest],
        segment_manifest_sha256: digest([prepared.segment.metadataDigest]),
        event_manifest_sha256: prepared.segment.eventManifestDigest,
        event_count: '1',
        signing_key_id: keyId,
        signing_key_registry_id: prepared.keyRegistryId,
        seal_sha256: seal.sealDigest,
      }),
    );
    expect(stored.sealed_at.toISOString()).toBe(SEALED_AT);
  });

  it('rejects cross-organization, wrong-workload, unknown-key, malformed, and tampered claims', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyId = 'blut-run-seal-adversarial';
    const prepared = await withTransaction(harness.adminPool, async (tx) => {
      const run = await prepareRun(tx, 'adversarial');
      // No ordinary expiry: the infinity case below must be rejected by canonical timestamp
      // admission rather than incidentally missing the key's validity window.
      await registerRunSealKey(tx, keyId, publicKey, { validUntil: null });
      return run;
    });
    const seal = signedSeal(prepared, keyId, privateKey);

    await expect(
      appendSeal(prepared, seal, { contextOrganizationId: OTHER_ORGANIZATION_ID }),
    ).rejects.toThrow(/outside current access context/i);
    await expect(
      appendSeal(prepared, seal, {
        organizationId: OTHER_ORGANIZATION_ID,
        contextOrganizationId: OTHER_ORGANIZATION_ID,
      }),
    ).rejects.toThrow(/cross-organization/i);
    await expect(
      appendSeal(prepared, seal, { workload: 'spiffe:kf.internal:blut:other' }),
    ).rejects.toThrow(/exact workload/i);
    await expect(appendSeal(prepared, seal, { sealDigest: 'f'.repeat(64) })).rejects.toThrow(
      /digest does not match/i,
    );
    await expect(
      appendSeal(prepared, seal, { signature: Buffer.alloc(64).toString('base64') }),
    ).rejects.toThrow(/signature verification failed/i);
    await expect(
      appendSeal(prepared, seal, { sealedAt: '2026-08-15T08:30:00.000001Z' }),
    ).rejects.toThrow(/canonical millisecond instant/i);
    await expect(appendSeal(prepared, seal, { sealedAt: 'infinity' })).rejects.toThrow(
      /finite four-digit-year canonical millisecond/i,
    );
    await expect(
      appendSeal(prepared, seal, { sealedAt: '10000-01-01T00:00:00.000Z' }),
    ).rejects.toThrow(/finite four-digit-year canonical millisecond/i);

    const unknownPair = generateKeyPairSync('ed25519');
    const unknownSeal = signedSeal(prepared, 'unregistered-run-seal-key', unknownPair.privateKey);
    await expect(appendSeal(prepared, unknownSeal)).rejects.toThrow(/exact workload/i);
  });

  it('rejects stale lineage/segment digests and metric-event gaps before key verification', async () => {
    const keyPair = generateKeyPairSync('ed25519');
    const badLineage = await withTransaction(harness.adminPool, async (tx) => {
      const badLineage = await prepareRun(tx, 'bad-lineage', {
        storedLineageDigest: '0'.repeat(64),
      });
      await registerRunSealKey(tx, 'blut-run-seal-basis-checks', keyPair.publicKey);
      return badLineage;
    });
    await expect(
      withTransaction(harness.adminPool, (tx) =>
        prepareRun(tx, 'bad-segment', { storedSegmentDigest: '1'.repeat(64) }),
      ),
    ).rejects.toThrow(/metric-segment v2 digest/i);
    await expect(
      withTransaction(harness.adminPool, (tx) =>
        prepareRun(tx, 'event-gap', {
          eventSequences: [1, 3],
          segmentLastSequence: 3,
          segmentEventDigests: [sha('event:event-gap:1'), '2'.repeat(64), sha('event:event-gap:3')],
        }),
      ),
    ).rejects.toThrow(/event digest manifest/i);

    await expect(
      appendSeal(
        badLineage,
        signedSeal(badLineage, 'blut-run-seal-basis-checks', keyPair.privateKey),
      ),
    ).rejects.toThrow(/run-lineage digest/i);
  });

  it('rejects a segment manifest that names different event bytes for the same sequence range', async () => {
    await expect(
      withTransaction(harness.adminPool, (tx) =>
        prepareRun(tx, 'event-manifest-mismatch', {
          segmentEventDigests: ['f'.repeat(64)],
        }),
      ),
    ).rejects.toThrow(/event digest manifest/i);
  });

  it('blocks revoked and expired keys while accepting an owner-registered rotation', async () => {
    const oldPair = generateKeyPairSync('ed25519');
    const newPair = generateKeyPairSync('ed25519');
    const expiredPair = generateKeyPairSync('ed25519');
    const prepared = await withTransaction(harness.adminPool, async (tx) => {
      const oldRun = await prepareRun(tx, 'rotation-old');
      const newRun = await prepareRun(tx, 'rotation-new');
      const expiredRun = await prepareRun(tx, 'expired');
      const oldRegistryId = await registerRunSealKey(tx, 'blut-run-seal-old', oldPair.publicKey);
      await registerRunSealKey(tx, 'blut-run-seal-new', newPair.publicKey, {
        rotatesKeyRegistryId: oldRegistryId,
      });
      await registerRunSealKey(tx, 'blut-run-seal-expired', expiredPair.publicKey, {
        validFrom: '2020-01-01T00:00:00.000Z',
        validUntil: '2025-01-01T00:00:00.000Z',
      });
      await tx.query(
        `insert into ml.run_seal_signing_key_revocation
           (signing_key_registry_id, reason_code, revoked_at)
         values ($1,'key_rotation','2026-08-15T08:00:00.000Z')`,
        [oldRegistryId],
      );
      return { oldRun, newRun, expiredRun };
    });

    await expect(
      appendSeal(
        prepared.oldRun,
        signedSeal(prepared.oldRun, 'blut-run-seal-old', oldPair.privateKey),
      ),
    ).rejects.toThrow(/active owner-registered key/i);
    await expect(
      appendSeal(
        prepared.expiredRun,
        signedSeal(
          prepared.expiredRun,
          'blut-run-seal-expired',
          expiredPair.privateKey,
          '2024-08-15T12:30:00.000Z',
        ),
      ),
    ).rejects.toThrow(/active owner-registered key/i);
    await expect(
      appendSeal(
        prepared.newRun,
        signedSeal(prepared.newRun, 'blut-run-seal-new', newPair.privateKey),
      ),
    ).resolves.toEqual(expect.objectContaining({ seal_sha256: expect.any(String) }));
  });

  it('linearizes a winning key revocation before the post-lock append read', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyId = 'blut-run-seal-revocation-race';
    const prepared = await withTransaction(harness.adminPool, async (tx) => {
      const run = await prepareRun(tx, 'revocation-race');
      const keyRegistryId = await registerRunSealKey(tx, keyId, publicKey);
      return { ...run, keyRegistryId };
    });
    const seal = signedSeal(prepared, keyId, privateKey);
    const revoker = await harness.adminPool.connect();
    const promoter = await harness.adminPool.connect();
    try {
      await revoker.query('begin');
      await revoker.query(
        `insert into ml.run_seal_signing_key_revocation
           (signing_key_registry_id, reason_code, revoked_at)
         values ($1,'key_compromise','2026-08-15T08:20:00.000Z')`,
        [prepared.keyRegistryId],
      );

      await promoter.query('begin');
      await promoter.query('set local role kf_ml_promoter');
      await promoter.query('select core.set_access_context($1, $2)', [
        fixtures.organizationId,
        'restricted',
      ]);
      const appendOutcome = promoter
        .query(`select * from ml.append_signed_run_seal($1,$2,$3,$4,$5,$6,$7)`, [
          fixtures.organizationId,
          prepared.lineageId,
          WORKLOAD,
          seal.sealedAt,
          seal.signingKeyId,
          seal.sealDigest,
          seal.signature,
        ])
        .then(
          () => 'resolved' as const,
          (error: unknown) => error,
        );
      const initial = await Promise.race([
        appendOutcome,
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 150)),
      ]);
      expect(initial).toBe('blocked');

      await revoker.query('commit');
      const outcome = await appendOutcome;
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/active owner-registered key/i);
      await promoter.query('rollback');
    } finally {
      await revoker.query('rollback').catch(() => undefined);
      await promoter.query('rollback').catch(() => undefined);
      revoker.release();
      promoter.release();
    }

    const count = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{ count: string }>(
        'select count(*)::text as count from ml.run_seal where run_lineage_id = $1',
        [prepared.lineageId],
      ),
    );
    expect(count.count).toBe('0');
  });

  it('rejects isolation levels that cannot provide a fresh post-lock revocation read', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyId = 'blut-run-seal-repeatable-read';
    const prepared = await withTransaction(harness.adminPool, async (tx) => {
      const run = await prepareRun(tx, 'repeatable-read');
      await registerRunSealKey(tx, keyId, publicKey);
      return run;
    });
    const seal = signedSeal(prepared, keyId, privateKey);
    const promoter = await harness.adminPool.connect();
    try {
      await promoter.query('begin isolation level repeatable read');
      await promoter.query('set local role kf_ml_promoter');
      await promoter.query('select core.set_access_context($1, $2)', [
        fixtures.organizationId,
        'restricted',
      ]);
      await expect(
        promoter.query(`select * from ml.append_signed_run_seal($1,$2,$3,$4,$5,$6,$7)`, [
          fixtures.organizationId,
          prepared.lineageId,
          WORKLOAD,
          seal.sealedAt,
          seal.signingKeyId,
          seal.sealDigest,
          seal.signature,
        ]),
      ).rejects.toThrow(/requires READ COMMITTED.*fresh post-lock/i);
    } finally {
      await promoter.query('rollback').catch(() => undefined);
      promoter.release();
    }
  });

  it('forces organization RLS, preserves auditor/backup reads, and exposes only the append seam', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyId = 'blut-run-seal-rls';
    const prepared = await withTransaction(harness.adminPool, async (tx) => {
      const run = await prepareRun(tx, 'rls');
      const keyRegistryId = await registerRunSealKey(tx, keyId, publicKey);
      return { ...run, keyRegistryId };
    });
    await appendSeal(prepared, signedSeal(prepared, keyId, privateKey));

    const visible = async (organizationId: string) =>
      withTransaction(harness.pool, async (tx) => {
        await tx.query('select core.set_access_context($1, $2)', [organizationId, 'restricted']);
        return tx.one<{ keys: number; revocations: number; seals: number }>(
          `select
             (select count(*)::integer from ml.run_seal_signing_key
               where id = $1) as keys,
             (select count(*)::integer from ml.run_seal_signing_key_revocation) as revocations,
             (select count(*)::integer from ml.run_seal
               where run_lineage_id = $2) as seals`,
          [prepared.keyRegistryId, prepared.lineageId],
        );
      });
    const sameOrganization = await visible(fixtures.organizationId);
    expect(sameOrganization.keys).toBe(1);
    expect(sameOrganization.revocations).toBeGreaterThan(0);
    expect(sameOrganization.seals).toBe(1);
    await expect(visible(OTHER_ORGANIZATION_ID)).resolves.toEqual({
      keys: 0,
      revocations: 0,
      seals: 0,
    });

    const authority = await withTransaction(harness.adminPool, async (tx) => {
      const rls = await tx.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `select relname, relrowsecurity, relforcerowsecurity
           from pg_class
          where oid in ('ml.run_seal_signing_key'::regclass,
                        'ml.run_seal_signing_key_revocation'::regclass)
          order by relname`,
      );
      const privileges = await tx.one<{
        promoterExecute: boolean;
        appExecute: boolean;
        promoterRawInsert: boolean;
        promoterKeyInsert: boolean;
      }>(
        `select
           has_function_privilege(
             'kf_ml_promoter',
             'ml.append_signed_run_seal(uuid,uuid,text,timestamptz,text,text,text)',
             'EXECUTE'
           ) as "promoterExecute",
           has_function_privilege(
             'kf_app',
             'ml.append_signed_run_seal(uuid,uuid,text,timestamptz,text,text,text)',
             'EXECUTE'
           ) as "appExecute",
           has_table_privilege('kf_ml_promoter','ml.run_seal','INSERT')
             as "promoterRawInsert",
           has_table_privilege('kf_ml_promoter','ml.run_seal_signing_key','INSERT')
             as "promoterKeyInsert"`,
      );
      const preservationAccess = async (role: 'kf_auditor' | 'kf_backup') => {
        await tx.query(`set local role ${role}`);
        const result = await tx.one<{
          keys: number;
          revocations: number;
          seals: number;
          canWriteKeys: boolean;
          canWriteRevocations: boolean;
        }>(
          `select
           (select count(*)::integer from ml.run_seal_signing_key) as keys,
           (select count(*)::integer from ml.run_seal_signing_key_revocation) as revocations,
           (select count(*)::integer from ml.run_seal) as seals,
           has_table_privilege(current_user,'ml.run_seal_signing_key',
             'INSERT,UPDATE,DELETE,TRUNCATE') as "canWriteKeys",
           has_table_privilege(current_user,'ml.run_seal_signing_key_revocation',
             'INSERT,UPDATE,DELETE,TRUNCATE') as "canWriteRevocations"`,
        );
        await tx.query('reset role');
        return result;
      };
      return {
        rls,
        privileges,
        auditor: await preservationAccess('kf_auditor'),
        backup: await preservationAccess('kf_backup'),
      };
    });
    expect(authority.rls).toEqual([
      {
        relname: 'run_seal_signing_key',
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
      {
        relname: 'run_seal_signing_key_revocation',
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
    ]);
    expect(authority.privileges).toEqual({
      promoterExecute: true,
      appExecute: false,
      promoterRawInsert: false,
      promoterKeyInsert: false,
    });
    for (const preservationRole of [authority.auditor, authority.backup]) {
      expect(preservationRole.keys).toBeGreaterThan(0);
      expect(preservationRole.revocations).toBeGreaterThan(0);
      expect(preservationRole.seals).toBeGreaterThan(0);
      expect(preservationRole.canWriteKeys).toBe(false);
      expect(preservationRole.canWriteRevocations).toBe(false);
    }
  });

  it('fails the authority migration closed when any pre-authority run seal exists', async () => {
    const migration = readFileSync(MIGRATION_PATH, 'utf8');
    await expect(
      withTransaction(harness.adminPool, async (tx) => {
        await tx.query(migrationSection(migration, 'down'));
        await tx.query(migrationSection(migration, 'up'));
      }),
    ).rejects.toThrow(/requires an empty ml\.run_seal table/i);
  });
});
