import { createHash, generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalBytes, digest } from '@kf/canonicalization';
import { withTransaction, type Tx } from '@kf/database';
import { createFabricDispatcher } from '@kf/orchestrator';
import {
  MetricEventJournal,
  signPromotionReceipt,
  signPromotionRevocation,
  type AggregateKind,
  type AggregateReference,
  type MlPromotionRiskTier,
} from './index.js';
import {
  bindContext,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from '../../../tests/database/harness.js';

const OTHER_ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222';
const SHA = 'a'.repeat(64);
const SIGNATURE = Buffer.alloc(64).toString('base64');
const FIXTURE_RUN_SEAL_SPKI = Buffer.concat([
  Buffer.from('302a300506032b6570032100', 'hex'),
  Buffer.alloc(32, 9),
]);

let harness: Harness;
let fixtures: Fixtures;
let fixtureRunSealKeyRegistryId: string;
let qualityAuthorityRoleId: string;
let sameHumanQualityAuthorityRoleId: string;

interface PromotionAuthorityFixtureInput {
  readonly aliasId: string;
  readonly riskTier: MlPromotionRiskTier;
  readonly promotedAt: string;
  readonly includeQuality: boolean;
  readonly sameHumanApprovers?: boolean;
}

function aggregateReference(kind: AggregateKind, authorityId: string): AggregateReference {
  return {
    organizationId: fixtures.organizationId,
    kind,
    authorityId,
    revisionId: 'revision-1',
    sha256: SHA,
    classificationId: 'internal',
    policyId: 'ml-default',
  };
}

async function registerPromotionKey(
  tx: Tx,
  keyId: string,
  publicKey: KeyObject,
  rotatesKeyRegistryId: string | null = null,
): Promise<string> {
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  const row = await tx.one<{ id: string }>(
    `insert into ml.promotion_signing_key
       (organization_id, key_id, algorithm, public_key_spki_der_base64,
        public_key_sha256, rotates_key_registry_id, valid_from, registered_at)
     values ($1, $2, 'Ed25519', $3, $4, $5, '2026-08-14T00:00:00.000Z',
             date_trunc('milliseconds', transaction_timestamp()))
     returning id`,
    [
      fixtures.organizationId,
      keyId,
      publicKeyDer.toString('base64'),
      createHash('sha256').update(publicKeyDer).digest('hex'),
      rotatesKeyRegistryId,
    ],
  );
  return row.id;
}

async function insertReference(
  tx: Tx,
  organizationId: string,
  kind: string,
  authorityId: string,
): Promise<string> {
  const row = await tx.one<{ id: string }>(
    `insert into ml.aggregate_reference
       (organization_id, aggregate_kind, authority_id, revision_id, sha256,
        classification_id, policy_id)
     values ($1, $2, $3, 'revision-1', $4, 'internal', 'ml-default')
     returning id`,
    [organizationId, kind, authorityId, SHA],
  );
  return row.id;
}

async function insertPromotionDecisionFixture(
  tx: Tx,
  input: {
    readonly suffix: string;
    readonly authorityKind: 'technical' | 'quality';
    readonly aliasId: string;
    readonly riskTier: MlPromotionRiskTier;
    readonly promotedAt: string;
    readonly candidateRefId: string;
    readonly runSealId: string;
    readonly policyRefId: string;
    readonly sameHumanApprovers: boolean;
  },
): Promise<{ id: string; reference: AggregateReference }> {
  const sameHumanApprovers = input.sameHumanApprovers === true;
  const actorId =
    input.authorityKind === 'technical' || sameHumanApprovers
      ? fixtures.reviewerId
      : fixtures.performerId;
  const roleId =
    input.authorityKind === 'technical'
      ? fixtures.reviewerRoleId
      : sameHumanApprovers
        ? sameHumanQualityAuthorityRoleId
        : qualityAuthorityRoleId;
  const actionId = (await tx.one<{ id: string }>('select uuidv7() as id')).id;
  const requestId = `promotion-authority-fixture:${input.suffix}:${input.authorityKind}`;
  const reason = `${input.authorityKind} fixture decision for exact promotion tuple`;
  const effectiveAt = new Date(Date.parse(input.promotedAt) - 60_000).toISOString();
  await tx.query('select core.set_access_context($1,$2)', [fixtures.organizationId, 'restricted']);
  const context = await tx.one<{ actor: string | null }>(
    `select nullif(current_setting('kf.actor', true), '') as actor`,
  );
  if (context.actor === null) {
    await tx.query('select core.set_transaction_context($1,$2,$3,$4)', [
      fixtures.reviewerId,
      fixtures.reviewerRoleId,
      actionId,
      `promotion-authority-fixture:${input.suffix}`,
    ]);
  }
  const object = await tx.one<{ id: string }>(
    `insert into core.object
       (object_type, authority_domain, lifecycle_state, classification, retention_class,
        schema_version, organization_id, title, created_by, updated_by)
     select 'ml_promotion_decision','qms','recorded','internal','quality_record',
            version,$1,$2,$3,$3
       from registry.schema_release where is_current
     returning id`,
    [
      fixtures.organizationId,
      `${input.authorityKind} ML promotion fixture ${input.suffix}`,
      actorId,
    ],
  );
  const parameters = {
    aliasId: input.aliasId,
    authorityKind: input.authorityKind,
    candidateRefId: input.candidateRefId,
    policyRefId: input.policyRefId,
    riskTier: input.riskTier,
    runSealId: input.runSealId,
  };
  await tx.query(
    `insert into core.action
       (id, action_type, actor_id, acting_role_id, target_ids, parameters,
        preconditions, idempotency_key, effective_at, request_id, reason,
        result_status, result, organization_id, request_digest)
     values ($1,'authorize_ml_promotion',$2,$3,$4,$5,'{}',$6,$7,$8,$9,'applied','{}',$10,$11)`,
    [
      actionId,
      actorId,
      roleId,
      [object.id],
      JSON.stringify(parameters),
      `authority-${input.suffix}-${input.authorityKind}`,
      effectiveAt,
      requestId,
      reason,
      fixtures.organizationId,
      createHash('sha256').update(`request:${requestId}`).digest('hex'),
    ],
  );
  const approval = await tx.one<{ id: string }>(
    `insert into core.approval
       (object_id, action_id, approver_id, approver_role, meaning, effective_at)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [
      object.id,
      actionId,
      actorId,
      roleId,
      `Authorize exact ${input.authorityKind} governed ML promotion decision`,
      effectiveAt,
    ],
  );
  const claimSha256 = createHash('sha256')
    .update(`typed-decision:${input.suffix}:${input.authorityKind}`)
    .digest('hex');
  const evidence = await tx.one<{ id: string }>(
    `insert into ml.aggregate_reference
       (organization_id, aggregate_kind, authority_id, revision_id, sha256,
        classification_id, policy_id)
     values ($1,'evidence',$2,$3,$4,'internal','ml-default') returning id`,
    [fixtures.organizationId, object.id, actionId, claimSha256],
  );
  await tx.query(
    `insert into ml.promotion_authority_decision
       (object_id, organization_id, action_id, approval_id, evidence_ref_id,
        approver_id, approver_role_id, authority_kind, alias_id, candidate_ref_id,
        run_seal_id, policy_ref_id, risk_tier, decision_claim_sha256,
        effective_at, valid_until)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,null)`,
    [
      object.id,
      fixtures.organizationId,
      actionId,
      approval.id,
      evidence.id,
      actorId,
      roleId,
      input.authorityKind,
      input.aliasId,
      input.candidateRefId,
      input.runSealId,
      input.policyRefId,
      input.riskTier,
      claimSha256,
      effectiveAt,
    ],
  );
  const head = await tx.maybeOne<{ digest: string }>(
    'select digest from core.audit_event order by seq desc limit 1',
  );
  const auditDigest = createHash('sha256')
    .update(`promotion-authority-audit:${actionId}`)
    .digest('hex');
  await tx.query(
    `insert into core.audit_event
       (action_id, actor_id, acting_role_id, action_type, object_id, effective_at,
        request_id, reason, before_digest, after_digest, prev_digest, digest)
     values ($1,$2,$3,'authorize_ml_promotion',$4,$5,$6,$7,$8,$8,$9,$10)`,
    [
      actionId,
      actorId,
      roleId,
      object.id,
      effectiveAt,
      requestId,
      reason,
      createHash('sha256').update(`promotion-authority-state:${actionId}`).digest('hex'),
      head?.digest ?? '0'.repeat(64),
      auditDigest,
    ],
  );
  await tx.query(
    `insert into core.outbox (action_id, topic, payload)
     values ($1,'kf.authorize_ml_promotion',$2)`,
    [actionId, JSON.stringify({ action_id: actionId, targets: [object.id] })],
  );
  return {
    id: evidence.id,
    reference: {
      organizationId: fixtures.organizationId,
      kind: 'evidence',
      authorityId: object.id,
      revisionId: actionId,
      sha256: claimSha256,
      classificationId: 'internal',
      policyId: 'ml-default',
    },
  };
}

async function preparePromotion(
  tx: Tx,
  suffix: string,
  authority?: PromotionAuthorityFixtureInput,
) {
  const organizationId = fixtures.organizationId;
  const lineageDigest = createHash('sha256').update(`lineage:${suffix}`).digest('hex');
  const segmentDigest = createHash('sha256').update(`segment:${suffix}`).digest('hex');
  const sealDigest = createHash('sha256').update(`seal:${suffix}`).digest('hex');
  const run = await insertReference(tx, organizationId, 'run', `governed-run-${suffix}`);
  const code = await insertReference(tx, organizationId, 'code', `governed-code-${suffix}`);
  const recipe = await insertReference(tx, organizationId, 'recipe', `governed-recipe-${suffix}`);
  const environment = await insertReference(
    tx,
    organizationId,
    'environment',
    `governed-environment-${suffix}`,
  );
  const policy = await insertReference(
    tx,
    organizationId,
    'metric_policy',
    `governed-policy-${suffix}`,
  );
  const input = await insertReference(tx, organizationId, 'input', `governed-input-${suffix}`);
  const candidate = await insertReference(
    tx,
    organizationId,
    'candidate',
    `governed-candidate-${suffix}`,
  );
  const segment = await insertReference(
    tx,
    organizationId,
    'segment',
    `governed-segment-${suffix}`,
  );
  const lineage = await tx.one<{ id: string }>(
    `insert into ml.run_lineage
       (run_ref_id, code_ref_id, recipe_ref_id, environment_ref_id,
        metric_policy_ref_id, lineage_sha256)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [run, code, recipe, environment, policy, lineageDigest],
  );
  await tx.query(
    `insert into ml.run_lineage_input (run_lineage_id, ordinal, aggregate_ref_id)
     values ($1, 1, $2)`,
    [lineage.id, input],
  );
  await tx.query(
    `insert into ml.run_lineage_output (run_lineage_id, ordinal, aggregate_ref_id)
     values ($1, 1, $2)`,
    [lineage.id, candidate],
  );
  await tx.query(
    `insert into ml.metric_segment
       (segment_ref_id, run_lineage_id, ordinal, first_sequence, last_sequence,
        event_count, metadata_sha256, schema_version)
     values ($1, $2, 1, 1, 1, 1, $3, 1)`,
    [segment, lineage.id, segmentDigest],
  );
  const seal = await tx.one<{ id: string }>(
    `insert into ml.run_seal
       (run_lineage_id, lineage_sha256, segment_manifest, segment_manifest_sha256, event_count,
        sealed_at, signing_key_id, signing_key_registry_id, seal_sha256, signature,
        schema_version)
     values ($1, $2, $3::text[], $4, 1, date_trunc('milliseconds',clock_timestamp()),
             'test-signing-key', $5, $6, $7, 1) returning id`,
    [
      lineage.id,
      lineageDigest,
      [segmentDigest],
      digest([segmentDigest]),
      fixtureRunSealKeyRegistryId,
      sealDigest,
      SIGNATURE,
    ],
  );
  if (authority === undefined) {
    const technical = await insertReference(
      tx,
      organizationId,
      'evidence',
      `technical-decision-${suffix}`,
    );
    const quality = await insertReference(
      tx,
      organizationId,
      'evidence',
      `quality-decision-${suffix}`,
    );
    return {
      candidate,
      policy,
      technical,
      quality,
      technicalReference: aggregateReference('evidence', `technical-decision-${suffix}`),
      qualityReference: aggregateReference('evidence', `quality-decision-${suffix}`),
      sealId: seal.id,
      sealDigest,
    };
  }
  const technical = await insertPromotionDecisionFixture(tx, {
    suffix,
    authorityKind: 'technical',
    aliasId: authority.aliasId,
    riskTier: authority.riskTier,
    promotedAt: authority.promotedAt,
    candidateRefId: candidate,
    runSealId: seal.id,
    policyRefId: policy,
    sameHumanApprovers: authority.sameHumanApprovers === true,
  });
  const quality = authority.includeQuality
    ? await insertPromotionDecisionFixture(tx, {
        suffix,
        authorityKind: 'quality',
        aliasId: authority.aliasId,
        riskTier: authority.riskTier,
        promotedAt: authority.promotedAt,
        candidateRefId: candidate,
        runSealId: seal.id,
        policyRefId: policy,
        sameHumanApprovers: authority.sameHumanApprovers === true,
      })
    : {
        id: await insertReference(tx, organizationId, 'evidence', `quality-decision-${suffix}`),
        reference: aggregateReference('evidence', `quality-decision-${suffix}`),
      };
  return {
    candidate,
    policy,
    technical: technical.id,
    quality: quality.id,
    technicalReference: technical.reference,
    qualityReference: quality.reference,
    sealId: seal.id,
    sealDigest,
  };
}

beforeAll(async () => {
  harness = await startHarness();
  fixtures = await seedFixtures(harness.adminPool);
  const authorityRoles = await withTransaction(harness.adminPool, async (tx) => {
    await bindContext(tx, fixtures, fixtures.reviewerId);
    await tx.query(
      `update org.role_assignment set valid_from = '2020-01-01T00:00:00.000Z'
        where id = $1`,
      [fixtures.reviewerRoleId],
    );
    const insertQualityRole = async (subjectId: string, title: string): Promise<string> => {
      const roleObject = await tx.one<{ id: string }>(
        `insert into core.object
           (object_type, authority_domain, lifecycle_state, classification, retention_class,
            schema_version, organization_id, title, created_by, updated_by)
         values ('role_assignment','organization','active','internal','project_record',
                 $1,$2,$3,$4,$4)
         returning id`,
        [fixtures.schemaVersion, fixtures.organizationId, title, fixtures.reviewerId],
      );
      await tx.query(
        `insert into org.role_assignment
           (id, subject_id, role_id, scope_id, valid_from)
         values ($1,$2,'quality_authority',$3,'2020-01-01T00:00:00.000Z')`,
        [roleObject.id, subjectId, fixtures.organizationId],
      );
      return roleObject.id;
    };
    return {
      distinctHuman: await insertQualityRole(
        fixtures.performerId,
        'Quality Authority fixture role',
      ),
      sameHuman: await insertQualityRole(
        fixtures.reviewerId,
        'Same-human Quality Authority fixture role',
      ),
    };
  });
  qualityAuthorityRoleId = authorityRoles.distinctHuman;
  sameHumanQualityAuthorityRoleId = authorityRoles.sameHuman;
  fixtureRunSealKeyRegistryId = await withTransaction(harness.adminPool, async (tx) => {
    const key = await tx.one<{ id: string }>(
      `insert into ml.run_seal_signing_key
         (organization_id, workload_identity_ref, key_id, algorithm,
          public_key_spki_der_base64, public_key_sha256, valid_from, valid_until, registered_at)
       values ($1,'workload.database-fixture','test-signing-key','Ed25519',$2,$3,
               '2020-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z',
               date_trunc('milliseconds', transaction_timestamp()))
       returning id`,
      [
        fixtures.organizationId,
        FIXTURE_RUN_SEAL_SPKI.toString('base64'),
        createHash('sha256').update(FIXTURE_RUN_SEAL_SPKI).digest('hex'),
      ],
    );
    return key.id;
  });
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

describe('organization-scoped ML registry database', () => {
  it('verifies RFC 8032 vectors and rejects non-canonical or small-order forgeries', async () => {
    const verified = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{
        vector1: boolean;
        vector2: boolean;
        tampered: boolean;
        identityForgery: boolean;
        smallOrderForgery: boolean;
        noncanonicalPoint: boolean;
        noncanonicalScalar: boolean;
      }>(
        `select
           ml.verify_ed25519(
             decode('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex'),
             ''::bytea,
             decode(
               'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155'
               '5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
               'hex'
             )
           ) as vector1,
           ml.verify_ed25519(
             decode('3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c', 'hex'),
             decode('72', 'hex'),
             decode(
               '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da'
               '085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
               'hex'
             )
           ) as vector2,
           ml.verify_ed25519(
             decode('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex'),
             convert_to('tampered', 'UTF8'),
             decode(
               'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155'
               '5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
               'hex'
             )
           ) as tampered,
           ml.verify_ed25519(
             decode('01' || repeat('00', 31), 'hex'),
             ''::bytea,
             decode('01' || repeat('00', 63), 'hex')
           ) as "identityForgery",
           ml.verify_ed25519(
             decode('ec' || repeat('ff', 30) || '7f', 'hex'),
             ''::bytea,
             decode(
               'ec' || repeat('ff', 30) || '7f' || repeat('00', 32),
               'hex'
             )
           ) as "smallOrderForgery",
           ml.verify_ed25519(
             decode('ed' || repeat('ff', 30) || '7f', 'hex'),
             ''::bytea,
             decode('01' || repeat('00', 63), 'hex')
           ) as "noncanonicalPoint",
           ml.verify_ed25519(
             decode('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex'),
             ''::bytea,
             decode(
               'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155'
               'edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010',
               'hex'
             )
           ) as "noncanonicalScalar"`,
      ),
    );

    expect(verified).toEqual({
      vector1: true,
      vector2: true,
      tampered: false,
      identityForgery: false,
      smallOrderForgery: false,
      noncanonicalPoint: false,
      noncanonicalScalar: false,
    });
  });

  it('appends a promotion only after rebuilding and verifying its canonical signed receipt', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyId = 'kf-promotion-key-db-1';
    const suffix = 'verified-receipt';
    const promotedAt = '2026-08-14T13:00:00.000Z';
    const aliasId = 'regulated.verified-encoder';
    const prepared = await withTransaction(harness.adminPool, async (tx) => {
      const promotion = await preparePromotion(tx, suffix, {
        aliasId,
        riskTier: 'regulated',
        promotedAt,
        includeQuality: true,
      });
      await registerPromotionKey(tx, keyId, publicKey);
      return promotion;
    });
    const technical = prepared.technicalReference;
    const quality = prepared.qualityReference;
    const receipt = signPromotionReceipt(
      {
        organizationId: fixtures.organizationId,
        aliasId,
        candidate: aggregateReference('candidate', `governed-candidate-${suffix}`),
        runSealDigest: prepared.sealDigest,
        policy: aggregateReference('metric_policy', `governed-policy-${suffix}`),
        evidence: [quality, technical],
        riskTier: 'regulated',
        technicalAuthorityDecision: technical,
        qualityAuthorityDecision: quality,
        promotedAt,
      },
      { id: keyId, privateKey },
    );

    const appendStartedAt = performance.now();
    const appended = await withTransaction(harness.adminPool, async (tx) => {
      await tx.query('set local role kf_ml_promoter');
      await tx.query('select core.set_access_context($1, $2)', [
        fixtures.organizationId,
        'restricted',
      ]);
      return tx.one<{
        id: string;
        receipt_sha256: string;
        evidence_manifest_sha256: string;
      }>(
        `select * from ml.append_signed_promotion_receipt(
           $1,$2,$3,$4,$5,$6::uuid[],$7,$8,$9,$10,$11,$12,$13
         )`,
        [
          fixtures.organizationId,
          receipt.aliasId,
          prepared.candidate,
          prepared.sealId,
          prepared.policy,
          [prepared.quality, prepared.technical],
          receipt.riskTier,
          prepared.technical,
          prepared.quality,
          promotedAt,
          keyId,
          receipt.receiptDigest,
          receipt.signature,
        ],
      );
    });
    const appendElapsedMs = performance.now() - appendStartedAt;

    expect(appended.receipt_sha256).toBe(receipt.receiptDigest);
    expect(appended.evidence_manifest_sha256).toBe(receipt.evidenceSetDigest);
    expect(appendElapsedMs).toBeLessThan(5_000);
    await expect(
      withTransaction(harness.adminPool, async (tx) => {
        await tx.query('set local role kf_ml_promoter');
        await tx.query(
          `insert into ml.promotion_receipt
             (organization_id, alias_id, candidate_ref_id, run_seal_id, policy_ref_id,
              evidence_manifest_sha256, risk_tier, technical_authority_decision_ref_id,
              quality_authority_decision_ref_id, promoted_at, signing_key_id,
              receipt_sha256, signature)
           values ($1,'research.raw-bypass',$2,$3,$4,$5,'research',$6,null,$7,$8,$9,$10)`,
          [
            fixtures.organizationId,
            prepared.candidate,
            prepared.sealId,
            prepared.policy,
            receipt.evidenceSetDigest,
            prepared.technical,
            promotedAt,
            keyId,
            'f'.repeat(64),
            SIGNATURE,
          ],
        );
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('requires technical and quality promotion decisions from distinct humans', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyId = 'kf-promotion-key-db-distinct-humans';
    const suffix = 'distinct-human-authority';
    const aliasId = 'regulated.distinct-human-authority';
    const promotedAt = '2026-08-14T13:05:00.000Z';
    const prepared = await withTransaction(harness.adminPool, async (tx) => {
      const promotion = await preparePromotion(tx, suffix, {
        aliasId,
        riskTier: 'regulated',
        promotedAt,
        includeQuality: true,
        sameHumanApprovers: true,
      });
      await registerPromotionKey(tx, keyId, publicKey);
      return promotion;
    });
    const receipt = signPromotionReceipt(
      {
        organizationId: fixtures.organizationId,
        aliasId,
        candidate: aggregateReference('candidate', `governed-candidate-${suffix}`),
        runSealDigest: prepared.sealDigest,
        policy: aggregateReference('metric_policy', `governed-policy-${suffix}`),
        evidence: [prepared.technicalReference, prepared.qualityReference],
        riskTier: 'regulated',
        technicalAuthorityDecision: prepared.technicalReference,
        qualityAuthorityDecision: prepared.qualityReference,
        promotedAt,
      },
      { id: keyId, privateKey },
    );

    await expect(
      withTransaction(harness.adminPool, async (tx) => {
        await tx.query('set local role kf_ml_promoter');
        await tx.query('select core.set_access_context($1, $2)', [
          fixtures.organizationId,
          'restricted',
        ]);
        await tx.query(
          `select * from ml.append_signed_promotion_receipt(
             $1,$2,$3,$4,$5,$6::uuid[],$7,$8,$9,$10,$11,$12,$13
           )`,
          [
            fixtures.organizationId,
            aliasId,
            prepared.candidate,
            prepared.sealId,
            prepared.policy,
            [prepared.technical, prepared.quality],
            'regulated',
            prepared.technical,
            prepared.quality,
            promotedAt,
            keyId,
            receipt.receiptDigest,
            receipt.signature,
          ],
        );
      }),
    ).rejects.toThrow(/distinct humans/i);
  });

  it('does not let a descriptive research risk claim bypass Quality Authority', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyId = 'kf-promotion-key-db-research-quality-required';
    const suffix = 'research-quality-required';
    const aliasId = 'research.quality-required';
    const promotedAt = '2026-08-14T13:07:00.000Z';
    const prepared = await withTransaction(harness.adminPool, async (tx) => {
      const promotion = await preparePromotion(tx, suffix, {
        aliasId,
        riskTier: 'research',
        promotedAt,
        includeQuality: true,
      });
      await registerPromotionKey(tx, keyId, publicKey);
      return promotion;
    });
    const unsigned = {
      schemaVersion: 'kf.ml.promotion-receipt.v1',
      issuer: 'knowledge-fabric',
      organizationId: fixtures.organizationId,
      aliasId,
      candidate: aggregateReference('candidate', `governed-candidate-${suffix}`),
      runSealDigest: prepared.sealDigest,
      policy: aggregateReference('metric_policy', `governed-policy-${suffix}`),
      evidence: [prepared.technicalReference],
      riskTier: 'research',
      technicalAuthorityDecision: prepared.technicalReference,
      qualityAuthorityDecision: null,
      promotedAt,
      evidenceSetDigest: digest([prepared.technicalReference]),
      signingKeyId: keyId,
    } as const;
    const receipt = {
      ...unsigned,
      receiptDigest: digest(unsigned),
      signature: edSign(null, canonicalBytes(unsigned), privateKey).toString('base64'),
    };

    await expect(
      withTransaction(harness.adminPool, async (tx) => {
        await tx.query('set local role kf_ml_promoter');
        await tx.query('select core.set_access_context($1, $2)', [
          fixtures.organizationId,
          'restricted',
        ]);
        await tx.query(
          `select * from ml.append_signed_promotion_receipt(
             $1,$2,$3,$4,$5,$6::uuid[],$7,$8,$9,$10,$11,$12,$13
           )`,
          [
            fixtures.organizationId,
            aliasId,
            prepared.candidate,
            prepared.sealId,
            prepared.policy,
            [prepared.technical],
            'research',
            prepared.technical,
            null,
            promotedAt,
            keyId,
            receipt.receiptDigest,
            receipt.signature,
          ],
        );
      }),
    ).rejects.toThrow(/every promotion requires a matching Quality Authority/i);
  });

  it('rejects shape-correct arbitrary signatures and evidence changed after signing', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyId = 'kf-promotion-key-db-tamper';
    const suffix = 'tampered-receipt';
    const promotedAt = '2026-08-14T13:10:00.000Z';
    const prepared = await withTransaction(harness.adminPool, async (tx) => {
      const promotion = await preparePromotion(tx, suffix);
      const extraEvidence = await insertReference(
        tx,
        fixtures.organizationId,
        'evidence',
        `post-signing-evidence-${suffix}`,
      );
      await registerPromotionKey(tx, keyId, publicKey);
      return { ...promotion, extraEvidence };
    });
    const technical = aggregateReference('evidence', `technical-decision-${suffix}`);
    const quality = aggregateReference('evidence', `quality-decision-${suffix}`);
    const receipt = signPromotionReceipt(
      {
        organizationId: fixtures.organizationId,
        aliasId: 'regulated.tamper-test',
        candidate: aggregateReference('candidate', `governed-candidate-${suffix}`),
        runSealDigest: prepared.sealDigest,
        policy: aggregateReference('metric_policy', `governed-policy-${suffix}`),
        evidence: [technical, quality],
        riskTier: 'regulated',
        technicalAuthorityDecision: technical,
        qualityAuthorityDecision: quality,
        promotedAt,
      },
      { id: keyId, privateKey },
    );
    const append = (evidenceIds: readonly string[], signature: string) =>
      withTransaction(harness.adminPool, async (tx) => {
        await tx.query('set local role kf_ml_promoter');
        await tx.query('select core.set_access_context($1, $2)', [
          fixtures.organizationId,
          'restricted',
        ]);
        await tx.query(
          `select * from ml.append_signed_promotion_receipt(
             $1,$2,$3,$4,$5,$6::uuid[],$7,$8,$9,$10,$11,$12,$13
           )`,
          [
            fixtures.organizationId,
            receipt.aliasId,
            prepared.candidate,
            prepared.sealId,
            prepared.policy,
            evidenceIds,
            receipt.riskTier,
            prepared.technical,
            prepared.quality,
            promotedAt,
            keyId,
            receipt.receiptDigest,
            signature,
          ],
        );
      });

    await expect(append([prepared.technical, prepared.quality], SIGNATURE)).rejects.toThrow(
      /signature verification failed/i,
    );
    await expect(
      append([prepared.technical, prepared.quality, prepared.extraEvidence], receipt.signature),
    ).rejects.toThrow(/digest does not match canonical stored evidence/i);
  });

  it('rejects a valid signature over a cross-organization unsealed candidate', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyId = 'kf-promotion-key-db-cross-org-candidate';
    const suffix = 'cross-org-candidate';
    const promotedAt = '2026-08-14T13:15:00.000Z';
    const prepared = await withTransaction(harness.adminPool, async (tx) => {
      const promotion = await preparePromotion(tx, suffix);
      const crossOrganizationCandidate = await insertReference(
        tx,
        OTHER_ORGANIZATION_ID,
        'candidate',
        `governed-candidate-${suffix}`,
      );
      await registerPromotionKey(tx, keyId, publicKey);
      return { ...promotion, crossOrganizationCandidate };
    });
    const technical = aggregateReference('evidence', `technical-decision-${suffix}`);
    const unsigned = {
      schemaVersion: 'kf.ml.promotion-receipt.v1',
      issuer: 'knowledge-fabric',
      organizationId: fixtures.organizationId,
      aliasId: 'research.cross-org-candidate',
      candidate: {
        ...aggregateReference('candidate', `governed-candidate-${suffix}`),
        organizationId: OTHER_ORGANIZATION_ID,
      },
      runSealDigest: prepared.sealDigest,
      policy: aggregateReference('metric_policy', `governed-policy-${suffix}`),
      evidence: [technical],
      riskTier: 'research',
      technicalAuthorityDecision: technical,
      qualityAuthorityDecision: null,
      promotedAt,
      evidenceSetDigest: digest([technical]),
      signingKeyId: keyId,
    } as const;
    const receiptDigest = digest(unsigned);
    const signature = edSign(null, canonicalBytes(unsigned), privateKey).toString('base64');

    await expect(
      withTransaction(harness.adminPool, async (tx) => {
        await tx.query('set local role kf_ml_promoter');
        await tx.query('select core.set_access_context($1, $2)', [
          fixtures.organizationId,
          'restricted',
        ]);
        await tx.query(
          `select * from ml.append_signed_promotion_receipt(
             $1,$2,$3,$4,$5,$6::uuid[],$7,$8,$9,$10,$11,$12,$13
           )`,
          [
            fixtures.organizationId,
            unsigned.aliasId,
            prepared.crossOrganizationCandidate,
            prepared.sealId,
            prepared.policy,
            [prepared.technical],
            unsigned.riskTier,
            prepared.technical,
            null,
            promotedAt,
            keyId,
            receiptDigest,
            signature,
          ],
        );
      }),
    ).rejects.toThrow(
      /not a sealed run output|one organization|not a matching effective typed human decision/i,
    );
  });

  it('blocks a revoked key and accepts its owner-registered rotation', async () => {
    const oldPair = generateKeyPairSync('ed25519');
    const newPair = generateKeyPairSync('ed25519');
    const oldKeyId = 'kf-promotion-key-db-old';
    const newKeyId = 'kf-promotion-key-db-new';
    const suffix = 'rotated-receipt';
    const promotedAt = '2026-08-14T13:20:00.000Z';
    const aliasId = 'regulated.rotated-encoder';
    const prepared = await withTransaction(harness.adminPool, async (tx) => {
      const promotion = await preparePromotion(tx, suffix, {
        aliasId,
        riskTier: 'regulated',
        promotedAt,
        includeQuality: true,
      });
      const oldKeyRegistryId = await registerPromotionKey(tx, oldKeyId, oldPair.publicKey);
      await registerPromotionKey(tx, newKeyId, newPair.publicKey, oldKeyRegistryId);
      await tx.query(
        `insert into ml.promotion_signing_key_revocation
           (signing_key_registry_id, reason_code, revoked_at)
         values ($1, 'key_rotation', '2026-08-14T12:30:00.000Z')`,
        [oldKeyRegistryId],
      );
      return promotion;
    });
    const technical = prepared.technicalReference;
    const quality = prepared.qualityReference;
    const input = {
      organizationId: fixtures.organizationId,
      aliasId,
      candidate: aggregateReference('candidate', `governed-candidate-${suffix}`),
      runSealDigest: prepared.sealDigest,
      policy: aggregateReference('metric_policy', `governed-policy-${suffix}`),
      evidence: [technical, quality],
      riskTier: 'regulated' as const,
      technicalAuthorityDecision: technical,
      qualityAuthorityDecision: quality,
      promotedAt,
    };
    const oldReceipt = signPromotionReceipt(input, {
      id: oldKeyId,
      privateKey: oldPair.privateKey,
    });
    const newReceipt = signPromotionReceipt(input, {
      id: newKeyId,
      privateKey: newPair.privateKey,
    });
    const append = (receipt: typeof oldReceipt) =>
      withTransaction(harness.adminPool, async (tx) => {
        await tx.query('set local role kf_ml_promoter');
        await tx.query('select core.set_access_context($1, $2)', [
          fixtures.organizationId,
          'restricted',
        ]);
        return tx.one<{ receipt_sha256: string }>(
          `select * from ml.append_signed_promotion_receipt(
             $1,$2,$3,$4,$5,$6::uuid[],$7,$8,$9,$10,$11,$12,$13
           )`,
          [
            fixtures.organizationId,
            receipt.aliasId,
            prepared.candidate,
            prepared.sealId,
            prepared.policy,
            [prepared.technical, prepared.quality],
            receipt.riskTier,
            prepared.technical,
            prepared.quality,
            promotedAt,
            receipt.signingKeyId,
            receipt.receiptDigest,
            receipt.signature,
          ],
        );
      });

    await expect(append(oldReceipt)).rejects.toThrow(/active owner-registered signing key/i);
    await expect(append(newReceipt)).resolves.toEqual(
      expect.objectContaining({ receipt_sha256: newReceipt.receiptDigest }),
    );
  });

  it('linearizes signing-key revocation before active-key resolution', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyId = 'kf-promotion-key-db-revocation-race';
    const suffix = 'revocation-race';
    const promotedAt = '2026-08-14T13:25:00.000Z';
    const prepared = await withTransaction(harness.adminPool, async (tx) => {
      const promotion = await preparePromotion(tx, suffix);
      const keyRegistryId = await registerPromotionKey(tx, keyId, publicKey);
      return { ...promotion, keyRegistryId };
    });
    const technical = aggregateReference('evidence', `technical-decision-${suffix}`);
    const quality = aggregateReference('evidence', `quality-decision-${suffix}`);
    const receipt = signPromotionReceipt(
      {
        organizationId: fixtures.organizationId,
        aliasId: 'research.revocation-race',
        candidate: aggregateReference('candidate', `governed-candidate-${suffix}`),
        runSealDigest: prepared.sealDigest,
        policy: aggregateReference('metric_policy', `governed-policy-${suffix}`),
        evidence: [technical, quality],
        riskTier: 'research',
        technicalAuthorityDecision: technical,
        qualityAuthorityDecision: quality,
        promotedAt,
      },
      { id: keyId, privateKey },
    );
    const revoker = await harness.adminPool.connect();
    const promoter = await harness.adminPool.connect();
    try {
      await revoker.query('begin');
      await revoker.query(
        `insert into ml.promotion_signing_key_revocation
           (signing_key_registry_id, reason_code, revoked_at)
         values ($1, 'key_compromise', '2026-08-14T13:24:00.000Z')`,
        [prepared.keyRegistryId],
      );

      await promoter.query('begin');
      await promoter.query('set local role kf_ml_promoter');
      await promoter.query('select core.set_access_context($1, $2)', [
        fixtures.organizationId,
        'restricted',
      ]);
      const appendOutcome = promoter
        .query(
          `select * from ml.append_signed_promotion_receipt(
             $1,$2,$3,$4,$5,$6::uuid[],$7,$8,$9,$10,$11,$12,$13
           )`,
          [
            fixtures.organizationId,
            receipt.aliasId,
            prepared.candidate,
            prepared.sealId,
            prepared.policy,
            [prepared.technical, prepared.quality],
            receipt.riskTier,
            prepared.technical,
            prepared.quality,
            promotedAt,
            keyId,
            receipt.receiptDigest,
            receipt.signature,
          ],
        )
        .then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        );

      let waitingOnAuthorityLock = false;
      for (let attempt = 0; attempt < 100 && !waitingOnAuthorityLock; attempt += 1) {
        const waitState = await withTransaction(harness.adminPool, (tx) =>
          tx.one<{ waiting: boolean }>(
            `select coalesce((
               select wait_event_type = 'Lock' and wait_event = 'advisory'
                 from pg_stat_activity where pid = $1
             ), false) as waiting`,
            [promoter.processID],
          ),
        );
        waitingOnAuthorityLock = waitState.waiting;
        if (!waitingOnAuthorityLock) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(waitingOnAuthorityLock).toBe(true);

      await revoker.query('commit');
      const outcome = await appendOutcome;
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') {
        expect(outcome.error).toBeInstanceOf(Error);
        expect((outcome.error as Error).message).toMatch(/active owner-registered signing key/i);
      }
      await promoter.query('rollback');
    } finally {
      await Promise.allSettled([revoker.query('rollback'), promoter.query('rollback')]);
      revoker.release();
      promoter.release();
    }
  });

  it('fails closed when promotion key admission cannot refresh a repeatable-read snapshot', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const keyId = 'kf-promotion-key-db-repeatable-read-refused';
    await withTransaction(harness.adminPool, (tx) => registerPromotionKey(tx, keyId, publicKey));

    const client = await harness.adminPool.connect();
    try {
      await client.query('begin isolation level repeatable read');
      await expect(
        client.query(`select ml.active_promotion_signing_public_key($1,$2,clock_timestamp())`, [
          fixtures.organizationId,
          keyId,
        ]),
      ).rejects.toThrow(/requires READ COMMITTED isolation/i);
      await client.query('rollback');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });

  it('suppresses a latest receipt whose key is revoked without alias fallback', async () => {
    const oldPair = generateKeyPairSync('ed25519');
    const latestPair = generateKeyPairSync('ed25519');
    const expiredPair = generateKeyPairSync('ed25519');
    const aliasId = 'research.key-state';
    const historicalAliasId = 'research.expired-key-history';
    const oldDigest = createHash('sha256').update('old-key-state-receipt').digest('hex');
    const latestDigest = createHash('sha256').update('latest-key-state-receipt').digest('hex');
    const historicalDigest = createHash('sha256')
      .update('expired-key-history-receipt')
      .digest('hex');

    const latestKeyRegistryId = await withTransaction(harness.adminPool, async (tx) => {
      const oldPromotion = await preparePromotion(tx, 'old-key-state', {
        aliasId,
        riskTier: 'research',
        promotedAt: '2026-08-14T14:00:00.000Z',
        includeQuality: true,
      });
      const latestPromotion = await preparePromotion(tx, 'latest-key-state', {
        aliasId,
        riskTier: 'research',
        promotedAt: '2026-08-14T15:00:00.000Z',
        includeQuality: true,
      });
      const historicalPromotion = await preparePromotion(tx, 'expired-key-history', {
        aliasId: historicalAliasId,
        riskTier: 'research',
        promotedAt: '2026-08-14T15:00:00.000Z',
        includeQuality: true,
      });
      await registerPromotionKey(tx, 'kf-promotion-key-db-alias-old', oldPair.publicKey);
      const latestKeyId = await registerPromotionKey(
        tx,
        'kf-promotion-key-db-alias-latest',
        latestPair.publicKey,
      );
      const expiredDer = expiredPair.publicKey.export({ type: 'spki', format: 'der' });
      await tx.query(
        `insert into ml.promotion_signing_key
           (organization_id, key_id, algorithm, public_key_spki_der_base64,
            public_key_sha256, valid_from, valid_until, registered_at)
         values ($1, 'kf-promotion-key-db-alias-expired', 'Ed25519', $2, $3,
                 '2026-08-14T00:00:00.000Z', '2026-08-14T16:00:00.000Z',
                 date_trunc('milliseconds', transaction_timestamp()))`,
        [
          fixtures.organizationId,
          expiredDer.toString('base64'),
          createHash('sha256').update(expiredDer).digest('hex'),
        ],
      );

      const insertHistoricalReceipt = async (
        promotion: Awaited<ReturnType<typeof preparePromotion>>,
        receiptAliasId: string,
        promotedAt: string,
        signingKeyId: string,
        receiptDigest: string,
      ) => {
        const row = await tx.one<{ id: string }>(
          `insert into ml.promotion_receipt
             (organization_id, alias_id, candidate_ref_id, run_seal_id, policy_ref_id,
              evidence_manifest_sha256, risk_tier, technical_authority_decision_ref_id,
              quality_authority_decision_ref_id, promoted_at, signing_key_id,
              receipt_sha256, signature)
           values ($1,$2,$3,$4,$5,$6,'research',$7,$8,$9,$10,$11,$12)
           returning id`,
          [
            fixtures.organizationId,
            receiptAliasId,
            promotion.candidate,
            promotion.sealId,
            promotion.policy,
            createHash('sha256').update(`evidence:${receiptDigest}`).digest('hex'),
            promotion.technical,
            promotion.quality,
            promotedAt,
            signingKeyId,
            receiptDigest,
            SIGNATURE,
          ],
        );
        await tx.query(
          `insert into ml.promotion_receipt_evidence
             (promotion_receipt_id, ordinal, evidence_ref_id)
           values ($1, 1, $2), ($1, 2, $3)`,
          [row.id, promotion.technical, promotion.quality],
        );
      };

      await insertHistoricalReceipt(
        oldPromotion,
        aliasId,
        '2026-08-14T14:00:00.000Z',
        'kf-promotion-key-db-alias-old',
        oldDigest,
      );
      await insertHistoricalReceipt(
        latestPromotion,
        aliasId,
        '2026-08-14T15:00:00.000Z',
        'kf-promotion-key-db-alias-latest',
        latestDigest,
      );
      await insertHistoricalReceipt(
        historicalPromotion,
        historicalAliasId,
        '2026-08-14T15:00:00.000Z',
        'kf-promotion-key-db-alias-expired',
        historicalDigest,
      );
      return latestKeyId;
    });

    const beforeRevocation = await withTransaction(harness.adminPool, (tx) =>
      tx.query<{ alias_id: string; receipt_sha256: string }>(
        `select alias_id, receipt_sha256 from ml.governed_alias
          where organization_id = $1 and alias_id = any($2::text[])
          order by alias_id`,
        [fixtures.organizationId, [aliasId, historicalAliasId]],
      ),
    );
    expect(beforeRevocation).toEqual([
      { alias_id: historicalAliasId, receipt_sha256: historicalDigest },
      { alias_id: aliasId, receipt_sha256: latestDigest },
    ]);

    await withTransaction(harness.adminPool, (tx) =>
      tx.query(
        `insert into ml.promotion_signing_key_revocation
           (signing_key_registry_id, reason_code, revoked_at)
         values ($1, 'key_compromise', '2026-08-14T15:30:00.000Z')`,
        [latestKeyRegistryId],
      ),
    );

    const afterRevocation = await withTransaction(harness.adminPool, (tx) =>
      tx.query<{ alias_id: string; receipt_sha256: string }>(
        `select alias_id, receipt_sha256 from ml.governed_alias
          where organization_id = $1 and alias_id = any($2::text[])
          order by alias_id`,
        [fixtures.organizationId, [aliasId, historicalAliasId]],
      ),
    );
    expect(afterRevocation).toEqual([
      { alias_id: historicalAliasId, receipt_sha256: historicalDigest },
    ]);
  });

  it('verifies signed revocation authority and rejects tamper, revoked keys, scope, and time', async () => {
    const promotionPair = generateKeyPairSync('ed25519');
    const revocationPair = generateKeyPairSync('ed25519');
    const revokedPair = generateKeyPairSync('ed25519');
    const promotionKeyId = 'kf-promotion-key-db-revocation-source';
    const revocationKeyId = 'kf-promotion-key-db-revocation-active';
    const revokedKeyId = 'kf-promotion-key-db-revocation-revoked';
    const suffix = 'verified-revocation';
    const promotedAt = '2026-08-14T13:30:00.000Z';
    const aliasId = 'research.revocation-test';
    const prepared = await withTransaction(harness.adminPool, async (tx) => {
      const promotion = await preparePromotion(tx, suffix, {
        aliasId,
        riskTier: 'research',
        promotedAt,
        includeQuality: true,
      });
      await registerPromotionKey(tx, promotionKeyId, promotionPair.publicKey);
      await registerPromotionKey(tx, revocationKeyId, revocationPair.publicKey);
      const revokedKeyRegistryId = await registerPromotionKey(
        tx,
        revokedKeyId,
        revokedPair.publicKey,
      );
      await tx.query(
        `insert into ml.promotion_signing_key_revocation
           (signing_key_registry_id, reason_code, revoked_at)
         values ($1, 'key_compromise', '2026-08-14T13:00:00.000Z')`,
        [revokedKeyRegistryId],
      );
      return promotion;
    });
    const technical = prepared.technicalReference;
    const quality = prepared.qualityReference;
    const receipt = signPromotionReceipt(
      {
        organizationId: fixtures.organizationId,
        aliasId,
        candidate: aggregateReference('candidate', `governed-candidate-${suffix}`),
        runSealDigest: prepared.sealDigest,
        policy: aggregateReference('metric_policy', `governed-policy-${suffix}`),
        evidence: [technical, quality],
        riskTier: 'research',
        technicalAuthorityDecision: technical,
        qualityAuthorityDecision: quality,
        promotedAt,
      },
      { id: promotionKeyId, privateKey: promotionPair.privateKey },
    );
    const storedReceipt = await withTransaction(harness.adminPool, async (tx) => {
      await tx.query('set local role kf_ml_promoter');
      await tx.query('select core.set_access_context($1, $2)', [
        fixtures.organizationId,
        'restricted',
      ]);
      return tx.one<{ id: string }>(
        `select * from ml.append_signed_promotion_receipt(
           $1,$2,$3,$4,$5,$6::uuid[],$7,$8,$9,$10,$11,$12,$13
         )`,
        [
          fixtures.organizationId,
          receipt.aliasId,
          prepared.candidate,
          prepared.sealId,
          prepared.policy,
          [prepared.technical, prepared.quality],
          receipt.riskTier,
          prepared.technical,
          prepared.quality,
          promotedAt,
          promotionKeyId,
          receipt.receiptDigest,
          receipt.signature,
        ],
      );
    });
    const revocationInput = {
      organizationId: fixtures.organizationId,
      aliasId: receipt.aliasId,
      receiptDigest: receipt.receiptDigest,
      reasonCode: 'operator_withdrawal' as const,
      revokedAt: '2026-08-14T13:40:00.000Z',
    };
    const revocation = signPromotionRevocation(revocationInput, {
      id: revocationKeyId,
      privateKey: revocationPair.privateKey,
    });
    const revokedKeyRevocation = signPromotionRevocation(revocationInput, {
      id: revokedKeyId,
      privateKey: revokedPair.privateKey,
    });
    const earlyRevocation = signPromotionRevocation(
      { ...revocationInput, revokedAt: '2026-08-14T13:20:00.000Z' },
      { id: revocationKeyId, privateKey: revocationPair.privateKey },
    );
    const appendRevocation = (
      signed: typeof revocation,
      overrides: { organizationId?: string; reasonCode?: string; signature?: string } = {},
    ) =>
      withTransaction(harness.adminPool, async (tx) => {
        await tx.query('set local role kf_ml_promoter');
        await tx.query('select core.set_access_context($1, $2)', [
          overrides.organizationId ?? fixtures.organizationId,
          'restricted',
        ]);
        return tx.one<{ id: string; revocation_sha256: string }>(
          `select * from ml.append_signed_promotion_revocation(
             $1,$2,$3,$4,$5,$6,$7
           )`,
          [
            overrides.organizationId ?? fixtures.organizationId,
            storedReceipt.id,
            overrides.reasonCode ?? signed.reasonCode,
            signed.revokedAt,
            signed.signingKeyId,
            signed.revocationDigest,
            overrides.signature ?? signed.signature,
          ],
        );
      });

    await expect(appendRevocation(revocation, { signature: SIGNATURE })).rejects.toThrow(
      /signature verification failed/i,
    );
    await expect(appendRevocation(revocation, { reasonCode: 'policy_violation' })).rejects.toThrow(
      /digest does not match/i,
    );
    await expect(appendRevocation(revokedKeyRevocation)).rejects.toThrow(
      /active owner-registered signing key/i,
    );
    await expect(
      appendRevocation(revocation, { organizationId: OTHER_ORGANIZATION_ID }),
    ).rejects.toThrow(/receipt belongs to another organization/i);
    await expect(appendRevocation(earlyRevocation)).rejects.toThrow(/predates its receipt/i);
    await expect(appendRevocation(revocation)).resolves.toEqual(
      expect.objectContaining({ revocation_sha256: revocation.revocationDigest }),
    );

    await expect(
      withTransaction(harness.adminPool, async (tx) => {
        await tx.query('set local role kf_ml_promoter');
        await tx.query(
          `insert into ml.promotion_revocation
             (organization_id, receipt_id, alias_id, reason_code, revoked_at,
              signing_key_id, revocation_sha256, signature)
           values ($1,$2,$3,'administrative',$4,$5,$6,$7)`,
          [
            fixtures.organizationId,
            storedReceipt.id,
            receipt.aliasId,
            revocation.revokedAt,
            revocationKeyId,
            'f'.repeat(64),
            SIGNATURE,
          ],
        );
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('exposes only organization-scoped public verification-key state as read-only data', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const keyId = 'kf-promotion-key-db-projection';
    await withTransaction(harness.adminPool, (tx) => registerPromotionKey(tx, keyId, publicKey));

    const visible = await withTransaction(harness.pool, async (tx) => {
      await bindContext(tx, fixtures);
      const key = await tx.one<{
        organization_id: string;
        key_id: string;
        algorithm: string;
        public_key_spki_der_base64: string;
        public_key_sha256: string;
        revocation_reason_code: string | null;
        revoked_at: string | null;
      }>(
        `select organization_id, key_id, algorithm, public_key_spki_der_base64,
                public_key_sha256, revocation_reason_code, revoked_at
           from ml.promotion_verification_key where key_id = $1`,
        [keyId],
      );
      const privileges = await tx.one<{
        canSelect: boolean;
        canWrite: boolean;
      }>(
        `select
           has_table_privilege(current_user, 'ml.promotion_verification_key', 'SELECT')
             as "canSelect",
           has_table_privilege(
             current_user, 'ml.promotion_signing_key', 'INSERT,UPDATE,DELETE,TRUNCATE'
           ) as "canWrite"`,
      );
      return { key, privileges };
    });
    expect(visible.key).toEqual(
      expect.objectContaining({
        organization_id: fixtures.organizationId,
        key_id: keyId,
        algorithm: 'Ed25519',
        public_key_spki_der_base64: expect.any(String),
        public_key_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        revocation_reason_code: null,
        revoked_at: null,
      }),
    );
    expect(visible.privileges).toEqual({ canSelect: true, canWrite: false });

    const hidden = await withTransaction(harness.pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [
        OTHER_ORGANIZATION_ID,
        'restricted',
      ]);
      return tx.query('select key_id from ml.promotion_verification_key where key_id = $1', [
        keyId,
      ]);
    });
    expect(hidden).toEqual([]);
  });

  it('shows aggregate references only inside bound organization and rejects cross-org writes', async () => {
    await withTransaction(harness.adminPool, async (tx) => {
      await insertReference(tx, fixtures.organizationId, 'run', 'visible-run');
      await insertReference(tx, OTHER_ORGANIZATION_ID, 'run', 'hidden-run');
    });

    const visible = await withTransaction(harness.pool, async (tx) => {
      await bindContext(tx, fixtures);
      return tx.query<{ authority_id: string }>(
        `select authority_id from ml.aggregate_reference
          where authority_id in ('visible-run', 'hidden-run') order by authority_id`,
      );
    });
    expect(visible.map((row) => row.authority_id)).toEqual(['visible-run']);

    await expect(
      withTransaction(harness.pool, async (tx) => {
        await bindContext(tx, fixtures);
        await insertReference(tx, OTHER_ORGANIZATION_ID, 'run', 'cross-org-run');
      }),
    ).rejects.toThrow(/row-level security|permission denied/i);
  });

  it('rejects unknown kinds and regulated promotion without Quality Authority evidence', async () => {
    await expect(
      withTransaction(harness.adminPool, async (tx) => {
        await insertReference(tx, fixtures.organizationId, 'arbitrary_blob', 'unsafe-kind');
      }),
    ).rejects.toThrow(/aggregate_kind|check constraint/i);

    await expect(
      withTransaction(harness.adminPool, async (tx) => {
        const promotion = await preparePromotion(tx, 'missing-quality', {
          aliasId: 'regulated.encoder',
          riskTier: 'regulated',
          promotedAt: '2026-08-14T13:00:00.000Z',
          includeQuality: true,
        });
        await tx.query(
          `insert into ml.promotion_receipt
             (organization_id, alias_id, candidate_ref_id, run_seal_id, policy_ref_id,
              evidence_manifest_sha256, risk_tier, technical_authority_decision_ref_id,
              quality_authority_decision_ref_id, promoted_at, signing_key_id,
              receipt_sha256, signature)
           values ($1, 'regulated.encoder', $2, $3, $4, $5, 'regulated', $6, null,
                   '2026-08-14T13:00:00.000Z', 'test-signing-key', $7, $8)`,
          [
            fixtures.organizationId,
            promotion.candidate,
            promotion.sealId,
            promotion.policy,
            'f'.repeat(64),
            promotion.technical,
            '1'.repeat(64),
            SIGNATURE,
          ],
        );
      }),
    ).rejects.toThrow(/quality|check constraint/i);
  });

  it('commits promotion only with a complete immutable authority evidence set', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    await expect(
      withTransaction(harness.adminPool, async (tx) => {
        const promotion = await preparePromotion(tx, 'missing-evidence', {
          aliasId: 'research.encoder',
          riskTier: 'research',
          promotedAt: '2026-08-14T13:00:00.000Z',
          includeQuality: true,
        });
        await tx.query(
          `insert into ml.promotion_receipt
             (organization_id, alias_id, candidate_ref_id, run_seal_id, policy_ref_id,
              evidence_manifest_sha256, risk_tier, technical_authority_decision_ref_id,
              quality_authority_decision_ref_id, promoted_at, signing_key_id,
              receipt_sha256, signature)
           values ($1, 'research.encoder', $2, $3, $4, $5, 'research', $6, $7,
                   '2026-08-14T13:00:00.000Z', 'test-signing-key', $8, $9)`,
          [
            fixtures.organizationId,
            promotion.candidate,
            promotion.sealId,
            promotion.policy,
            'f'.repeat(64),
            promotion.technical,
            promotion.quality,
            '1'.repeat(64),
            SIGNATURE,
          ],
        );
      }),
    ).rejects.toThrow(/complete contiguous evidence set/i);

    const receiptId = await withTransaction(harness.adminPool, async (tx) => {
      const promotion = await preparePromotion(tx, 'complete-evidence', {
        aliasId: 'regulated.encoder',
        riskTier: 'regulated',
        promotedAt: '2026-08-14T13:00:00.000Z',
        includeQuality: true,
      });
      await registerPromotionKey(tx, 'test-signing-key', publicKey);
      const receipt = await tx.one<{ id: string }>(
        `insert into ml.promotion_receipt
           (organization_id, alias_id, candidate_ref_id, run_seal_id, policy_ref_id,
            evidence_manifest_sha256, risk_tier, technical_authority_decision_ref_id,
            quality_authority_decision_ref_id, promoted_at, signing_key_id,
            receipt_sha256, signature)
         values ($1, 'regulated.encoder', $2, $3, $4, $5, 'regulated', $6, $7,
                 '2026-08-14T13:00:00.000Z', 'test-signing-key', $8, $9)
         returning id`,
        [
          fixtures.organizationId,
          promotion.candidate,
          promotion.sealId,
          promotion.policy,
          'f'.repeat(64),
          promotion.technical,
          promotion.quality,
          '1'.repeat(64),
          SIGNATURE,
        ],
      );
      await tx.query(
        `insert into ml.promotion_receipt_evidence
           (promotion_receipt_id, ordinal, evidence_ref_id)
         values ($1, 1, $2), ($1, 2, $3)`,
        [receipt.id, promotion.technical, promotion.quality],
      );
      return receipt.id;
    });

    const evidenceCount = await withTransaction(harness.adminPool, async (tx) =>
      tx.one<{ count: string }>(
        `select count(*)::text as count from ml.promotion_receipt_evidence
          where promotion_receipt_id = $1`,
        [receiptId],
      ),
    );
    expect(evidenceCount.count).toBe('2');

    const governed = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{ signing_key_id: string; signature: string; receipt_sha256: string }>(
        `select signing_key_id, signature, receipt_sha256
           from ml.governed_alias
          where organization_id = $1 and alias_id = 'regulated.encoder'`,
        [fixtures.organizationId],
      ),
    );
    expect(governed).toEqual({
      signing_key_id: 'test-signing-key',
      signature: SIGNATURE,
      receipt_sha256: '1'.repeat(64),
    });
  });

  it('binds a seal to exact ordered segments and preserves only authorized retry replay', async () => {
    const prepared = await withTransaction(harness.adminPool, async (tx) => {
      const organizationId = fixtures.organizationId;
      const run = await insertReference(tx, organizationId, 'run', 'sealed-event-run');
      const code = await insertReference(tx, organizationId, 'code', 'sealed-event-code');
      const recipe = await insertReference(tx, organizationId, 'recipe', 'sealed-event-recipe');
      const environment = await insertReference(
        tx,
        organizationId,
        'environment',
        'sealed-event-environment',
      );
      const policy = await insertReference(
        tx,
        organizationId,
        'metric_policy',
        'sealed-event-policy',
      );
      const input = await insertReference(tx, organizationId, 'input', 'sealed-event-input');
      const output = await insertReference(tx, organizationId, 'output', 'sealed-event-output');
      const definitionRef = await insertReference(tx, organizationId, 'metric_definition', 'loss');
      const segment = await insertReference(tx, organizationId, 'segment', 'sealed-event-segment');
      const lineage = await tx.one<{ id: string }>(
        `insert into ml.run_lineage
           (run_ref_id, code_ref_id, recipe_ref_id, environment_ref_id,
            metric_policy_ref_id, lineage_sha256)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [run, code, recipe, environment, policy, '2'.repeat(64)],
      );
      await tx.query(
        `insert into ml.run_lineage_input (run_lineage_id, ordinal, aggregate_ref_id)
         values ($1,1,$2)`,
        [lineage.id, input],
      );
      await tx.query(
        `insert into ml.run_lineage_output (run_lineage_id, ordinal, aggregate_ref_id)
         values ($1,1,$2)`,
        [lineage.id, output],
      );
      const definition = await tx.one<{ id: string }>(
        `insert into ml.metric_definition
           (definition_ref_id, metric_id, value_kind, unit_id, allowed_enum_ids)
         values ($1,'loss','number','ratio','{}') returning id`,
        [definitionRef],
      );
      return { lineageId: lineage.id, definitionId: definition.id, policyRefId: policy, segment };
    });

    const execute = createFabricDispatcher(harness.pool);
    const authorize = async (actorId: string, actingRoleId: string) =>
      execute({
        actionType: 'authorize_ml_metric_stream',
        actorId: fixtures.reviewerId,
        actingRoleId: fixtures.reviewerRoleId,
        targetIds: [fixtures.organizationId],
        payload: {
          authorizedActorId: actorId,
          authorizedRoleId: actingRoleId,
          runLineageId: prepared.lineageId,
          metricDefinitionId: prepared.definitionId,
          metricPolicyRefId: prepared.policyRefId,
        },
        idempotencyKey: `sealed-event-authorization:${actorId}`,
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
        requestId: 'ml-registry-database-test',
      });
    await authorize(fixtures.performerId, fixtures.performerRoleId);
    await authorize(fixtures.reviewerId, fixtures.reviewerRoleId);

    const appendAs = async (
      actorId: string,
      actingRoleId: string,
      key: string,
      sequence: number,
      eventSha256: string,
    ) => {
      const event = new MetricEventJournal().append(
        {
          reference: aggregateReference('metric_definition', 'loss'),
          metricId: 'loss',
          valueKind: 'number',
          unitId: 'ratio',
          allowedValues: [],
        },
        {
          idempotencyKey: key,
          run: aggregateReference('run', 'sealed-event-run'),
          sequence,
          recordedAt: '2026-08-14T00:00:00.000Z',
          value: { kind: 'number', number: 0.5 },
        },
      );
      expect(event.eventDigest).toBe(eventSha256);
      return execute({
        actionType: 'append_ml_metric_event',
        actorId,
        actingRoleId,
        targetIds: [fixtures.organizationId],
        payload: {
          runLineageId: prepared.lineageId,
          metricDefinitionId: prepared.definitionId,
          idempotencyKey: event.idempotencyKey,
          sequence: event.sequence,
          recordedAt: event.recordedAt,
          value: event.value,
          eventDigest: event.eventDigest,
        },
        idempotencyKey: `ml-event:${event.eventDigest}`,
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
        requestId: 'ml-registry-database-test',
      });
    };
    const eventDigest = (key: string, sequence: number) =>
      new MetricEventJournal().append(
        {
          reference: aggregateReference('metric_definition', 'loss'),
          metricId: 'loss',
          valueKind: 'number',
          unitId: 'ratio',
          allowedValues: [],
        },
        {
          idempotencyKey: key,
          run: aggregateReference('run', 'sealed-event-run'),
          sequence,
          recordedAt: '2026-08-14T00:00:00.000Z',
          value: { kind: 'number', number: 0.5 },
        },
      ).eventDigest;
    const append = (key: string, sequence: number, expectedDigest = eventDigest(key, sequence)) =>
      appendAs(fixtures.performerId, fixtures.performerRoleId, key, sequence, expectedDigest);

    const firstDigest = eventDigest('sealed-event-1', 1);
    const first = await append('sealed-event-1', 1, firstDigest);
    expect(first.replayed).toBe(false);
    await expect(
      appendAs(fixtures.reviewerId, fixtures.reviewerRoleId, 'sealed-event-1', 1, firstDigest),
    ).rejects.toThrow(/idempotency.*authorization/i);
    const segmentDigest = '4'.repeat(64);
    const segmentManifest = [segmentDigest];
    await withTransaction(harness.adminPool, async (tx) => {
      await tx.query(
        `insert into ml.metric_segment
           (segment_ref_id, run_lineage_id, ordinal, first_sequence, last_sequence,
            event_count, metadata_sha256, schema_version)
         values ($1,$2,1,1,1,1,$3,1)`,
        [prepared.segment, prepared.lineageId, segmentDigest],
      );
    });

    const insertSeal = (manifest: readonly string[], manifestDigest: string, sealDigest: string) =>
      withTransaction(harness.adminPool, (tx) =>
        tx.query(
          `insert into ml.run_seal
           (run_lineage_id, lineage_sha256, segment_manifest, segment_manifest_sha256,
            event_count,
            sealed_at, signing_key_id, signing_key_registry_id, seal_sha256, signature,
            schema_version)
         values ($1,$2,$3::text[],$4,1,date_trunc('milliseconds',clock_timestamp()),
                 'test-signing-key',$5,$6,$7,1)`,
          [
            prepared.lineageId,
            '2'.repeat(64),
            manifest,
            manifestDigest,
            fixtureRunSealKeyRegistryId,
            sealDigest,
            SIGNATURE,
          ],
        ),
      );

    const wrongManifest = ['5'.repeat(64)];
    await expect(insertSeal(wrongManifest, digest(wrongManifest), '6'.repeat(64))).rejects.toThrow(
      /segment manifest does not match/i,
    );
    await expect(insertSeal(segmentManifest, '7'.repeat(64), '8'.repeat(64))).rejects.toThrow(
      /manifest digest does not match/i,
    );
    await insertSeal(segmentManifest, digest(segmentManifest), '6'.repeat(64));

    const replay = await append('sealed-event-1', 1, firstDigest);
    expect(replay.actionId).toBe(first.actionId);
    expect(replay.replayed).toBe(true);
    await expect(append('sealed-event-2', 2)).rejects.toThrow(/sealed/i);

    await expect(
      withTransaction(harness.adminPool, async (tx) => {
        const lateInput = await insertReference(
          tx,
          fixtures.organizationId,
          'input',
          'sealed-event-late-input',
        );
        await tx.query(
          `insert into ml.run_lineage_input (run_lineage_id, ordinal, aggregate_ref_id)
           values ($1,2,$2)`,
          [prepared.lineageId, lateInput],
        );
      }),
    ).rejects.toThrow(/sealed/i);

    await expect(
      withTransaction(harness.adminPool, async (tx) => {
        const lateSegment = await insertReference(
          tx,
          fixtures.organizationId,
          'segment',
          'sealed-event-late-segment',
        );
        await tx.query(
          `insert into ml.metric_segment
             (segment_ref_id, run_lineage_id, ordinal, first_sequence, last_sequence,
              event_count, metadata_sha256)
           values ($1,$2,2,2,2,1,$3)`,
          [lateSegment, prepared.lineageId, '8'.repeat(64)],
        );
      }),
    ).rejects.toThrow(/sealed/i);
  });
});
