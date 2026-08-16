import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDispatcher, type ActionRequest } from '@kf/actions';
import { withTransaction, type Tx } from '@kf/database';
import {
  MetricEventJournal,
  ML_PROMOTION_RISK_TIERS,
  isCanonicalTimestamp,
  isPromotionRiskTier,
  signPromotionReceipt,
  type AggregateReference,
  type MetricDefinition,
  type ProvisionalMetricEvent,
} from '@kf/ml-registry';
import {
  ML_ACTION_TYPES,
  actionForMetricEventAppend,
  actionForMetricStreamAuthorization,
  actionForPromotionAuthorization,
  createMlActionAtoms,
  metricEventActionIdempotencyKey,
} from './ml.js';
import {
  requireRiskTier,
  validateEventPayload,
  validatePromotionPayload,
} from './ml/validation.js';
import {
  bindContext,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from '../../../tests/database/harness.js';

const SHA = 'a'.repeat(64);

function reference(
  organizationId: string,
  kind: AggregateReference['kind'],
  authorityId: string,
): AggregateReference {
  return {
    organizationId,
    kind,
    authorityId,
    revisionId: 'revision-1',
    sha256: SHA,
    classificationId: 'internal',
    policyId: 'ml-default',
  };
}

const UNIT_ORGANIZATION = '11111111-1111-7111-8111-111111111111';
const UNIT_RUN_ID = '22222222-2222-7222-8222-222222222222';
const UNIT_DEFINITION_ID = '33333333-3333-7333-8333-333333333333';
const UNIT_POLICY_ID = '44444444-4444-7444-8444-444444444444';
const UNIT_ACTOR_ID = '55555555-5555-7555-8555-555555555555';
const UNIT_ROLE_ID = '66666666-6666-7666-8666-666666666666';
const UNIT_CANDIDATE_ID = '77777777-7777-7777-8777-777777777777';
const UNIT_RUN_SEAL_ID = '88888888-8888-7888-8888-888888888888';

function unitEvent(): ProvisionalMetricEvent {
  const run = reference(UNIT_ORGANIZATION, 'run', 'run-authority');
  const definition: MetricDefinition = {
    reference: reference(UNIT_ORGANIZATION, 'metric_definition', 'loss-definition'),
    metricId: 'validation.loss',
    valueKind: 'number',
    unitId: 'ratio',
    allowedValues: [],
  };
  return new MetricEventJournal().append(definition, {
    idempotencyKey: 'trainer-run-41',
    run,
    sequence: 41,
    recordedAt: '2026-08-14T12:01:00.000Z',
    value: { kind: 'number', number: 0.125 },
  });
}

describe('ML typed-action contracts', () => {
  it('uses the registry public contracts for shared promotion and timestamp vocabulary', () => {
    expect(
      ML_PROMOTION_RISK_TIERS.every((tier) => requireRiskTier(tier, 'riskTier') === tier),
    ).toBe(true);
    expect(isPromotionRiskTier('high_risk')).toBe(true);
    expect(isCanonicalTimestamp('2026-08-14T12:01:00.000Z')).toBe(true);
    expect(() => requireRiskTier('clinical', 'riskTier')).toThrow(
      /riskTier must be research, regulated, or high_risk/,
    );
  });

  it('binds append semantics to one organization target and a digest-derived action replay key', () => {
    const event = unitEvent();
    const intent = actionForMetricEventAppend({
      organizationId: UNIT_ORGANIZATION,
      runLineageId: UNIT_RUN_ID,
      metricDefinitionId: UNIT_DEFINITION_ID,
      event,
    });

    expect(intent).toEqual({
      actionType: 'append_ml_metric_event',
      targetId: UNIT_ORGANIZATION,
      parameters: {
        runLineageId: UNIT_RUN_ID,
        metricDefinitionId: UNIT_DEFINITION_ID,
        idempotencyKey: 'trainer-run-41',
        sequence: 41,
        recordedAt: '2026-08-14T12:01:00.000Z',
        value: { kind: 'number', number: 0.125 },
        eventDigest: event.eventDigest,
      },
    });
    expect(metricEventActionIdempotencyKey(event.eventDigest)).toBe(
      `ml-event:${event.eventDigest}`,
    );
  });

  it('documents the complete generic authorization action payload', () => {
    expect(
      actionForMetricStreamAuthorization({
        organizationId: UNIT_ORGANIZATION,
        authorizedActorId: UNIT_ACTOR_ID,
        authorizedRoleId: UNIT_ROLE_ID,
        runLineageId: UNIT_RUN_ID,
        metricDefinitionId: UNIT_DEFINITION_ID,
        metricPolicyRefId: UNIT_POLICY_ID,
      }),
    ).toEqual({
      actionType: 'authorize_ml_metric_stream',
      targetId: UNIT_ORGANIZATION,
      parameters: {
        authorizedActorId: UNIT_ACTOR_ID,
        authorizedRoleId: UNIT_ROLE_ID,
        runLineageId: UNIT_RUN_ID,
        metricDefinitionId: UNIT_DEFINITION_ID,
        metricPolicyRefId: UNIT_POLICY_ID,
      },
    });
  });

  it('builds a closed promotion-decision creation action with no caller-selected target', () => {
    expect(
      actionForPromotionAuthorization({
        aliasId: 'encoder.production',
        candidateRefId: UNIT_CANDIDATE_ID,
        runSealId: UNIT_RUN_SEAL_ID,
        policyRefId: UNIT_POLICY_ID,
        riskTier: 'regulated',
        authorityKind: 'quality',
        validUntil: '2027-08-14T12:01:00.000Z',
      }),
    ).toEqual({
      actionType: 'authorize_ml_promotion',
      targetIds: [],
      parameters: {
        aliasId: 'encoder.production',
        candidateRefId: UNIT_CANDIDATE_ID,
        runSealId: UNIT_RUN_SEAL_ID,
        policyRefId: UNIT_POLICY_ID,
        riskTier: 'regulated',
        authorityKind: 'quality',
        validUntil: '2027-08-14T12:01:00.000Z',
      },
    });

    expect(() =>
      actionForPromotionAuthorization({
        aliasId: 'encoder.production',
        candidateRefId: UNIT_CANDIDATE_ID,
        runSealId: UNIT_RUN_SEAL_ID,
        policyRefId: UNIT_POLICY_ID,
        riskTier: 'regulated',
        authorityKind: 'quality',
        validUntil: '2027-08-14T12:01:00Z',
      }),
    ).toThrow(/canonical four-digit-year RFC 3339 millisecond timestamp/);
  });

  it.each(['0000-08-14T12:01:00.000Z', '+010000-08-14T12:01:00.000Z'])(
    'rejects extended timestamp %s at every generic ML action preflight',
    (invalidTimestamp) => {
      const base: Omit<ActionRequest, 'actionType' | 'payload' | 'targetIds'> = {
        actorId: UNIT_ACTOR_ID,
        actingRoleId: UNIT_ROLE_ID,
        idempotencyKey: 'extended-time-refused',
        organizationId: UNIT_ORGANIZATION,
        maxClassification: 'restricted',
      };
      const eventPayload = {
        runLineageId: UNIT_RUN_ID,
        metricDefinitionId: UNIT_DEFINITION_ID,
        idempotencyKey: 'trainer-run-extended-time',
        sequence: 41,
        recordedAt: '2026-08-14T12:01:00.000Z',
        value: { kind: 'number', number: 0.125 },
        eventDigest: SHA,
      } as const;

      expect(() =>
        validateEventPayload({
          ...base,
          actionType: 'append_ml_metric_event',
          targetIds: [UNIT_ORGANIZATION],
          payload: { ...eventPayload, recordedAt: invalidTimestamp },
        }),
      ).toThrow(/four-digit-year RFC 3339 millisecond timestamp/);
      expect(() =>
        validateEventPayload({
          ...base,
          actionType: 'append_ml_metric_event',
          targetIds: [UNIT_ORGANIZATION],
          payload: {
            ...eventPayload,
            value: { kind: 'timestamp', timestamp: invalidTimestamp },
          },
        }),
      ).toThrow(/four-digit-year RFC 3339 millisecond timestamp/);
      expect(() =>
        validatePromotionPayload({
          ...base,
          actionType: 'authorize_ml_promotion',
          targetIds: [],
          payload: {
            aliasId: 'encoder.production',
            candidateRefId: UNIT_CANDIDATE_ID,
            runSealId: UNIT_RUN_SEAL_ID,
            policyRefId: UNIT_POLICY_ID,
            riskTier: 'regulated',
            authorityKind: 'quality',
            validUntil: invalidTimestamp,
          },
        }),
      ).toThrow(/four-digit-year RFC 3339 millisecond timestamp/);
    },
  );
});

interface MlFixture {
  readonly runLineageId: string;
  readonly metricDefinitionId: string;
  readonly metricPolicyRefId: string;
  readonly run: AggregateReference;
  readonly definition: MetricDefinition;
}

interface PromotionFixture {
  readonly candidateId: string;
  readonly candidate: AggregateReference;
  readonly policyId: string;
  readonly policy: AggregateReference;
  readonly runSealId: string;
  readonly runSealDigest: string;
}

interface AuthorityFixture {
  readonly personId: string;
  readonly roleAssignmentId: string;
}

let h: Harness;
let f: Fixtures;
let ml: MlFixture;
let promotion: PromotionFixture;
let qualityAuthority: AuthorityFixture;
let executeMl: ReturnType<typeof createDispatcher>;
let authorizationActionId: string;
let firstEvent: ProvisionalMetricEvent;
let firstAppendActionId: string;

function uniqueDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function insertReference(
  tx: Tx,
  organizationId: string,
  kind: AggregateReference['kind'],
  authorityId: string,
  suffix: string,
): Promise<{ id: string; reference: AggregateReference }> {
  const aggregate = {
    ...reference(organizationId, kind, authorityId),
    sha256: uniqueDigest(`${kind}:${authorityId}:${suffix}`),
  };
  const row = await tx.one<{ id: string }>(
    `insert into ml.aggregate_reference
       (organization_id, aggregate_kind, authority_id, revision_id, sha256,
        classification_id, policy_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id`,
    [
      aggregate.organizationId,
      aggregate.kind,
      aggregate.authorityId,
      aggregate.revisionId,
      aggregate.sha256,
      aggregate.classificationId,
      aggregate.policyId,
    ],
  );
  return { id: row.id, reference: aggregate };
}

async function seedMlFixture(fixtures: Fixtures): Promise<MlFixture> {
  const suffix = uniqueDigest(`${fixtures.organizationId}:${Date.now().toString()}`).slice(0, 12);
  return withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, fixtures);
    const run = await insertReference(tx, fixtures.organizationId, 'run', `run-${suffix}`, suffix);
    const policy = await insertReference(
      tx,
      fixtures.organizationId,
      'metric_policy',
      `metric-policy-${suffix}`,
      suffix,
    );
    const code = await insertReference(
      tx,
      fixtures.organizationId,
      'code',
      `code-${suffix}`,
      suffix,
    );
    const recipe = await insertReference(
      tx,
      fixtures.organizationId,
      'recipe',
      `recipe-${suffix}`,
      suffix,
    );
    const environment = await insertReference(
      tx,
      fixtures.organizationId,
      'environment',
      `environment-${suffix}`,
      suffix,
    );
    const definitionRef = await insertReference(
      tx,
      fixtures.organizationId,
      'metric_definition',
      `metric-definition-${suffix}`,
      suffix,
    );
    const lineage = await tx.one<{ id: string }>(
      `insert into ml.run_lineage
         (run_ref_id, code_ref_id, recipe_ref_id, environment_ref_id,
          metric_policy_ref_id, lineage_sha256)
       values ($1, $2, $3, $4, $5, $6)
       returning id`,
      [run.id, code.id, recipe.id, environment.id, policy.id, uniqueDigest(`lineage:${suffix}`)],
    );
    const definition = await tx.one<{ id: string }>(
      `insert into ml.metric_definition
         (definition_ref_id, metric_id, value_kind, unit_id, allowed_enum_ids)
       values ($1, $2, 'number', 'ratio', '{}')
       returning id`,
      [definitionRef.id, `validation.loss.${suffix}`],
    );
    return {
      runLineageId: lineage.id,
      metricDefinitionId: definition.id,
      metricPolicyRefId: policy.id,
      run: run.reference,
      definition: {
        reference: definitionRef.reference,
        metricId: `validation.loss.${suffix}`,
        valueKind: 'number',
        unitId: 'ratio',
        allowedValues: [],
      },
    };
  });
}

async function seedAuthorityFixture(
  fixtures: Fixtures,
  roleId: 'technical_authority' | 'quality_authority',
  roleLifecycle: 'active' | 'inactive' = 'active',
): Promise<AuthorityFixture> {
  return withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, fixtures, fixtures.reviewerId);
    const person = await tx.one<{ id: string }>(
      `insert into core.object
         (object_type, authority_domain, lifecycle_state, classification, retention_class,
          schema_version, organization_id, title, created_by, updated_by)
       values ('person','organization','active','internal','project_record',$1,$2,$3,$4,$4)
       returning id`,
      [fixtures.schemaVersion, fixtures.organizationId, 'Quality Authority', fixtures.reviewerId],
    );
    await tx.query(
      `insert into org.person (id, display_name, organization)
       values ($1, 'Quality Authority', $2)`,
      [person.id, fixtures.organizationId],
    );
    const assignment = await tx.one<{ id: string }>(
      `insert into core.object
         (object_type, authority_domain, lifecycle_state, classification, retention_class,
          schema_version, organization_id, title, created_by, updated_by)
       values ('role_assignment','organization',$1,'internal','project_record',$2,$3,$4,$5,$5)
       returning id`,
      [
        roleLifecycle,
        fixtures.schemaVersion,
        fixtures.organizationId,
        `${roleId} test assignment`,
        fixtures.reviewerId,
      ],
    );
    await tx.query(
      `insert into org.role_assignment (id, subject_id, role_id, scope_id)
       values ($1,$2,$3,$4)`,
      [assignment.id, person.id, roleId, fixtures.organizationId],
    );
    return { personId: person.id, roleAssignmentId: assignment.id };
  });
}

async function seedPromotionFixture(fixtures: Fixtures): Promise<PromotionFixture> {
  const suffix = uniqueDigest(`promotion:${fixtures.organizationId}:${Date.now()}`).slice(0, 12);
  const runSealPair = generateKeyPairSync('ed25519');
  return withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, fixtures);
    const run = await insertReference(
      tx,
      fixtures.organizationId,
      'run',
      `promotion-run-${suffix}`,
      suffix,
    );
    const policy = await insertReference(
      tx,
      fixtures.organizationId,
      'metric_policy',
      `promotion-policy-${suffix}`,
      suffix,
    );
    const code = await insertReference(
      tx,
      fixtures.organizationId,
      'code',
      `promotion-code-${suffix}`,
      suffix,
    );
    const recipe = await insertReference(
      tx,
      fixtures.organizationId,
      'recipe',
      `promotion-recipe-${suffix}`,
      suffix,
    );
    const environment = await insertReference(
      tx,
      fixtures.organizationId,
      'environment',
      `promotion-environment-${suffix}`,
      suffix,
    );
    const input = await insertReference(
      tx,
      fixtures.organizationId,
      'input',
      `promotion-input-${suffix}`,
      suffix,
    );
    const candidate = await insertReference(
      tx,
      fixtures.organizationId,
      'candidate',
      `promotion-candidate-${suffix}`,
      suffix,
    );
    const segment = await insertReference(
      tx,
      fixtures.organizationId,
      'segment',
      `promotion-segment-${suffix}`,
      suffix,
    );
    const lineageDigest = uniqueDigest(`promotion-lineage:${suffix}`);
    const lineage = await tx.one<{ id: string }>(
      `insert into ml.run_lineage
         (run_ref_id, code_ref_id, recipe_ref_id, environment_ref_id,
          metric_policy_ref_id, lineage_sha256)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [run.id, code.id, recipe.id, environment.id, policy.id, lineageDigest],
    );
    await tx.query(
      `insert into ml.run_lineage_input (run_lineage_id, ordinal, aggregate_ref_id)
       values ($1,1,$2)`,
      [lineage.id, input.id],
    );
    await tx.query(
      `insert into ml.run_lineage_output (run_lineage_id, ordinal, aggregate_ref_id)
       values ($1,1,$2)`,
      [lineage.id, candidate.id],
    );
    const segmentDigest = uniqueDigest(`promotion-segment-metadata:${suffix}`);
    await tx.query(
      `insert into ml.metric_segment
         (segment_ref_id, run_lineage_id, ordinal, first_sequence, last_sequence,
          event_count, metadata_sha256, schema_version)
       values ($1,$2,1,1,1,1,$3,1)`,
      [segment.id, lineage.id, segmentDigest],
    );
    const publicKeyDer = runSealPair.publicKey.export({ type: 'spki', format: 'der' });
    const signingKey = await tx.one<{ id: string }>(
      `insert into ml.run_seal_signing_key
         (organization_id, workload_identity_ref, key_id, algorithm,
          public_key_spki_der_base64, public_key_sha256, valid_from, registered_at)
       values ($1,$2,$3,'Ed25519',$4,$5,'2020-01-01T00:00:00.000Z',
               date_trunc('milliseconds', transaction_timestamp()))
       returning id`,
      [
        fixtures.organizationId,
        `workload.promotion-test-${suffix}`,
        `run-seal-test-${suffix}`,
        publicKeyDer.toString('base64'),
        createHash('sha256').update(publicKeyDer).digest('hex'),
      ],
    );
    const runSealDigest = uniqueDigest(`promotion-seal:${suffix}`);
    const seal = await tx.one<{ id: string }>(
      `insert into ml.run_seal
         (run_lineage_id, lineage_sha256, segment_manifest, segment_manifest_sha256,
          event_count, sealed_at, signing_key_id, signing_key_registry_id,
          seal_sha256, signature, schema_version)
       values ($1,$2,$3::text[],$4,1,date_trunc('milliseconds',clock_timestamp()),
               $5,$6,$7,$8,1) returning id`,
      [
        lineage.id,
        lineageDigest,
        [segmentDigest],
        uniqueDigest(JSON.stringify([segmentDigest])),
        `run-seal-test-${suffix}`,
        signingKey.id,
        runSealDigest,
        Buffer.alloc(64).toString('base64'),
      ],
    );
    return {
      candidateId: candidate.id,
      candidate: candidate.reference,
      policyId: policy.id,
      policy: policy.reference,
      runSealId: seal.id,
      runSealDigest,
    };
  });
}

function actionRequest(
  intent: ReturnType<typeof actionForMetricStreamAuthorization | typeof actionForMetricEventAppend>,
  input: {
    readonly actorId: string;
    readonly actingRoleId: string;
    readonly idempotencyKey: string;
    readonly effectiveAt?: Date;
  },
): ActionRequest {
  return {
    actionType: intent.actionType,
    actorId: input.actorId,
    actingRoleId: input.actingRoleId,
    targetIds: [intent.targetId],
    payload: intent.parameters,
    idempotencyKey: input.idempotencyKey,
    organizationId: f.organizationId,
    maxClassification: 'restricted',
    requestId: `ml-test:${input.idempotencyKey}`,
    ...(input.effectiveAt === undefined ? {} : { effectiveAt: input.effectiveAt }),
  };
}

function promotionActionRequest(
  intent: ReturnType<typeof actionForPromotionAuthorization>,
  input: {
    readonly actorId: string;
    readonly actingRoleId: string;
    readonly idempotencyKey: string;
    readonly effectiveAt: Date;
    readonly reason: string;
  },
): ActionRequest {
  return {
    actionType: intent.actionType,
    actorId: input.actorId,
    actingRoleId: input.actingRoleId,
    targetIds: intent.targetIds,
    payload: intent.parameters,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    organizationId: f.organizationId,
    maxClassification: 'restricted',
    requestId: `ml-test:${input.idempotencyKey}`,
    effectiveAt: input.effectiveAt,
  };
}

function event(key: string, sequence: number, number: number): ProvisionalMetricEvent {
  return new MetricEventJournal().append(ml.definition, {
    idempotencyKey: key,
    run: ml.run,
    sequence,
    recordedAt: `2026-08-14T12:${String(sequence).padStart(2, '0')}:00.000Z`,
    value: { kind: 'number', number },
  });
}

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  ml = await seedMlFixture(f);
  qualityAuthority = await seedAuthorityFixture(f, 'quality_authority');
  promotion = await seedPromotionFixture(f);
  const atoms = createMlActionAtoms();
  executeMl = createDispatcher(h.pool, {
    allowedActions: new Set(atoms.ownedActions),
    materializers: atoms.materializers,
    effects: atoms.effects,
    preconditions: atoms.preconditions,
  });
  const authorization = actionForMetricStreamAuthorization({
    organizationId: f.organizationId,
    authorizedActorId: f.performerId,
    authorizedRoleId: f.performerRoleId,
    runLineageId: ml.runLineageId,
    metricDefinitionId: ml.metricDefinitionId,
    metricPolicyRefId: ml.metricPolicyRefId,
  });
  const result = await executeMl(
    actionRequest(authorization, {
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      idempotencyKey: 'authorize-ml-stream-0001',
    }),
  );
  authorizationActionId = result.actionId;
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

describe('ML typed-action database authority', () => {
  it('records distinct typed human decisions and admits their exact signed promotion', async () => {
    const aliasId = 'regulated.human-authority';
    const decisionAt = new Date();
    const promotedAt = decisionAt.toISOString();
    const validUntil = new Date(decisionAt.getTime() + 86_400_000).toISOString();
    const decision = (authorityKind: 'technical' | 'quality') =>
      actionForPromotionAuthorization({
        aliasId,
        candidateRefId: promotion.candidateId,
        runSealId: promotion.runSealId,
        policyRefId: promotion.policyId,
        riskTier: 'regulated',
        authorityKind,
        validUntil,
      });

    const technicalResult = await executeMl(
      promotionActionRequest(decision('technical'), {
        actorId: f.reviewerId,
        actingRoleId: f.reviewerRoleId,
        idempotencyKey: 'ml-promotion-technical-0001',
        effectiveAt: decisionAt,
        reason: 'Technical evidence satisfies exact governed promotion policy.',
      }),
    );
    const qualityResult = await executeMl(
      promotionActionRequest(decision('quality'), {
        actorId: qualityAuthority.personId,
        actingRoleId: qualityAuthority.roleAssignmentId,
        idempotencyKey: 'ml-promotion-quality-0001',
        effectiveAt: decisionAt,
        reason: 'Quality review accepts exact regulated promotion evidence.',
      }),
    );

    const rows = await withTransaction(h.adminPool, (tx) =>
      tx.query<{
        object_id: string;
        action_id: string;
        authority_kind: 'technical' | 'quality';
        approver_id: string;
        approval_id: string;
        evidence_ref_id: string;
        authority_id: string;
        revision_id: string;
        sha256: string;
        classification_id: string;
        policy_id: string;
      }>(
        `select decision.object_id, decision.action_id, decision.authority_kind,
                decision.approver_id, decision.approval_id, decision.evidence_ref_id,
                evidence.authority_id, evidence.revision_id, evidence.sha256,
                evidence.classification_id, evidence.policy_id
           from ml.promotion_authority_decision decision
           join ml.aggregate_reference evidence on evidence.id = decision.evidence_ref_id
          where decision.object_id = any($1::uuid[])
          order by decision.authority_kind`,
        [technicalResult.objectIds.concat(qualityResult.objectIds)],
      ),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.authority_kind)).toEqual(['quality', 'technical']);
    for (const row of rows) {
      expect(row.authority_id).toBe(row.object_id);
      expect(row.revision_id).toBe(row.action_id);
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/u);
    }

    const evidence = (kind: 'technical' | 'quality'): AggregateReference => {
      const row = rows.find((candidate) => candidate.authority_kind === kind)!;
      return {
        organizationId: f.organizationId,
        kind: 'evidence',
        authorityId: row.authority_id,
        revisionId: row.revision_id,
        sha256: row.sha256,
        classificationId: row.classification_id,
        policyId: row.policy_id,
      };
    };
    const technicalEvidence = evidence('technical');
    const qualityEvidence = evidence('quality');
    const pair = generateKeyPairSync('ed25519');
    const keyId = 'promotion-human-authority-test';
    await withTransaction(h.adminPool, async (tx) => {
      const publicKeyDer = pair.publicKey.export({ type: 'spki', format: 'der' });
      await tx.query(
        `insert into ml.promotion_signing_key
           (organization_id, key_id, algorithm, public_key_spki_der_base64,
            public_key_sha256, valid_from, registered_at)
         values ($1,$2,'Ed25519',$3,$4,$5,
                 date_trunc('milliseconds', transaction_timestamp()))`,
        [
          f.organizationId,
          keyId,
          publicKeyDer.toString('base64'),
          createHash('sha256').update(publicKeyDer).digest('hex'),
          new Date(Date.now() - 60_000).toISOString(),
        ],
      );
    });
    const receipt = signPromotionReceipt(
      {
        organizationId: f.organizationId,
        aliasId,
        candidate: promotion.candidate,
        runSealDigest: promotion.runSealDigest,
        policy: promotion.policy,
        evidence: [technicalEvidence, qualityEvidence],
        riskTier: 'regulated',
        technicalAuthorityDecision: technicalEvidence,
        qualityAuthorityDecision: qualityEvidence,
        promotedAt,
      },
      { id: keyId, privateKey: pair.privateKey },
    );
    const receiptRow = await withTransaction(h.adminPool, async (tx) => {
      await tx.query('set local role kf_ml_promoter');
      await tx.query('select core.set_access_context($1,$2)', [f.organizationId, 'restricted']);
      return tx.one<{ receipt_sha256: string }>(
        `select * from ml.append_signed_promotion_receipt(
           $1,$2,$3,$4,$5,$6::uuid[],$7,$8,$9,$10,$11,$12,$13
         )`,
        [
          f.organizationId,
          aliasId,
          promotion.candidateId,
          promotion.runSealId,
          promotion.policyId,
          rows.map((row) => row.evidence_ref_id),
          'regulated',
          rows.find((row) => row.authority_kind === 'technical')!.evidence_ref_id,
          rows.find((row) => row.authority_kind === 'quality')!.evidence_ref_id,
          promotedAt,
          keyId,
          receipt.receiptDigest,
          receipt.signature,
        ],
      );
    });
    expect(receiptRow.receipt_sha256).toBe(receipt.receiptDigest);

    const envelopes = await withTransaction(h.adminPool, (tx) =>
      tx.one<{
        decisions: string;
        approvals: string;
        actions: string;
        audits: string;
        outbox: string;
        authorizationVersion: string;
        authorizationActionId: string;
        authorizationDigestMatches: boolean;
        authorizationVersion: string;
        authorizationActionId: string;
        authorizationDigestMatches: boolean;
      }>(
        `select
           (select count(*) from ml.promotion_authority_decision
             where object_id = any($1::uuid[]))::text as decisions,
           (select count(*) from core.approval
             where object_id = any($1::uuid[]))::text as approvals,
           (select count(*) from core.action
             where id = any($2::uuid[]))::text as actions,
           (select count(*) from core.audit_event
             where action_id = any($2::uuid[]))::text as audits,
           (select count(*) from core.outbox
             where action_id = any($2::uuid[]))::text as outbox`,
        [
          technicalResult.objectIds.concat(qualityResult.objectIds),
          [technicalResult.actionId, qualityResult.actionId],
        ],
      ),
    );
    expect(envelopes).toEqual({
      decisions: '2',
      approvals: '2',
      actions: '2',
      audits: '2',
      outbox: '2',
    });
  });

  it('rejects non-authority actors, caller-selected targets, and opaque decision evidence', async () => {
    const decisionAt = new Date();
    const intent = actionForPromotionAuthorization({
      aliasId: 'research.rejected-authority',
      candidateRefId: promotion.candidateId,
      runSealId: promotion.runSealId,
      policyRefId: promotion.policyId,
      riskTier: 'research',
      authorityKind: 'technical',
    });
    await expect(
      executeMl(
        promotionActionRequest(intent, {
          actorId: f.performerId,
          actingRoleId: f.performerRoleId,
          idempotencyKey: 'ml-promotion-wrong-role-0001',
          effectiveAt: decisionAt,
          reason: 'A performer cannot self-assert Technical Authority.',
        }),
      ),
    ).rejects.toThrow(/technical_authority/);

    const inactiveAuthority = await seedAuthorityFixture(f, 'technical_authority', 'inactive');
    await expect(
      executeMl(
        promotionActionRequest(intent, {
          actorId: inactiveAuthority.personId,
          actingRoleId: inactiveAuthority.roleAssignmentId,
          idempotencyKey: 'ml-promotion-inactive-role-0001',
          effectiveAt: decisionAt,
          reason: 'An inactive authority object cannot authorize promotion.',
        }),
      ),
    ).rejects.toThrow(/technical_authority/);

    const missingBasisIntent = actionForPromotionAuthorization({
      aliasId: 'research.missing-basis',
      candidateRefId: UNIT_CANDIDATE_ID,
      runSealId: promotion.runSealId,
      policyRefId: promotion.policyId,
      riskTier: 'research',
      authorityKind: 'technical',
    });
    await expect(
      executeMl(
        promotionActionRequest(missingBasisIntent, {
          actorId: f.reviewerId,
          actingRoleId: f.reviewerRoleId,
          idempotencyKey: 'ml-promotion-missing-basis-0001',
          effectiveAt: decisionAt,
          reason: 'A missing candidate must fail as an invisible promotion basis.',
        }),
      ),
    ).rejects.toThrow(/candidate, sealed run, or exact policy is unavailable/i);

    await expect(
      executeMl({
        ...promotionActionRequest(intent, {
          actorId: f.reviewerId,
          actingRoleId: f.reviewerRoleId,
          idempotencyKey: 'ml-promotion-forged-target-0001',
          effectiveAt: decisionAt,
          reason: 'Caller target must not be accepted.',
        }),
        targetIds: [f.organizationId],
      }),
    ).rejects.toThrow(/accepts no initial targets|create exactly one new decision/i);

    await expect(
      withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f);
        const opaque = await insertReference(
          tx,
          f.organizationId,
          'evidence',
          `opaque-authority-${Date.now()}`,
          'opaque-authority',
        );
        await tx.query(
          `insert into ml.promotion_receipt
             (organization_id, alias_id, candidate_ref_id, run_seal_id, policy_ref_id,
              evidence_manifest_sha256, risk_tier, technical_authority_decision_ref_id,
              quality_authority_decision_ref_id, promoted_at, signing_key_id,
              receipt_sha256, signature)
           values ($1,'research.opaque-rejected',$2,$3,$4,$5,'research',$6,null,now(),
                   'opaque-test',$7,$8)`,
          [
            f.organizationId,
            promotion.candidateId,
            promotion.runSealId,
            promotion.policyId,
            uniqueDigest('opaque-manifest'),
            opaque.id,
            uniqueDigest('opaque-receipt'),
            Buffer.alloc(64).toString('base64'),
          ],
        );
      }),
    ).rejects.toThrow(/not a matching effective typed human decision/i);
  });

  it('creates exactly one action, audit event and outbox row for authorization and append', async () => {
    firstEvent = event('typed-event-0001', 1, 0.125);
    const intent = actionForMetricEventAppend({
      organizationId: f.organizationId,
      runLineageId: ml.runLineageId,
      metricDefinitionId: ml.metricDefinitionId,
      event: firstEvent,
    });
    const result = await executeMl(
      actionRequest(intent, {
        actorId: f.performerId,
        actingRoleId: f.performerRoleId,
        idempotencyKey: metricEventActionIdempotencyKey(firstEvent.eventDigest),
      }),
    );
    firstAppendActionId = result.actionId;

    expect(result.replayed).toBe(false);
    const counts = await withTransaction(h.adminPool, (tx) =>
      tx.one<{
        authorizations: string;
        events: string;
        actions: string;
        audits: string;
        outbox: string;
      }>(
        `select
           (select count(*) from ml.metric_write_authorization
             where run_lineage_id = $1)::text as authorizations,
           (select count(*) from ml.metric_event
             where run_lineage_id = $1)::text as events,
           (select count(*) from core.action
             where action_type = any($2::text[]))::text as actions,
           (select count(*) from core.audit_event
             where action_id = any($3::uuid[]))::text as audits,
           (select count(*) from core.outbox
             where action_id = any($3::uuid[]))::text as outbox,
           (select authz.schema_version::text
              from ml.metric_write_authorization authz
             where authz.run_lineage_id = $1) as "authorizationVersion",
           (select authz.action_id::text
              from ml.metric_write_authorization authz
             where authz.run_lineage_id = $1) as "authorizationActionId",
           (select authz.authorization_sha256 = encode(
                     public.digest(convert_to(
                       ml.canonical_metric_write_authorization_v2(
                         authz.action_id, authz.organization_id,
                         authz.actor_id, authz.acting_role_id,
                         authz.run_lineage_id, authz.metric_definition_id,
                         authz.metric_policy_ref_id, authz.authorized_at
                       ), 'UTF8'), 'sha256'), 'hex')
              from ml.metric_write_authorization authz
             where authz.run_lineage_id = $1) as "authorizationDigestMatches"`,
        [
          ml.runLineageId,
          [ML_ACTION_TYPES.authorizeMetricStream, ML_ACTION_TYPES.appendMetricEvent],
          [authorizationActionId, result.actionId],
        ],
      ),
    );
    expect(counts).toEqual({
      authorizations: '1',
      events: '1',
      actions: '2',
      audits: '2',
      outbox: '2',
      authorizationVersion: '2',
      authorizationActionId,
      authorizationDigestMatches: true,
    });
  });

  it('refuses raw privilege paths, fake action UUIDs and exact-action mismatches', async () => {
    const privileges = await withTransaction(h.adminPool, (tx) =>
      tx.one<{
        app_setup_insert: boolean;
        worker_setup_insert: boolean;
        promoter_authorization_insert: boolean;
        app_old_append: boolean;
        worker_old_append: boolean;
        app_typed_append: boolean;
      }>(
        `select
           has_table_privilege('kf_app', 'ml.aggregate_reference', 'INSERT')
             as app_setup_insert,
           has_table_privilege('kf_worker', 'ml.aggregate_reference', 'INSERT')
             as worker_setup_insert,
           has_table_privilege('kf_ml_promoter', 'ml.metric_write_authorization', 'INSERT')
             as promoter_authorization_insert,
           has_function_privilege(
             'kf_app',
             'ml.append_metric_event_receipt(uuid,uuid,text,bigint,timestamp with time zone,double precision,text,timestamp with time zone,text)',
             'EXECUTE'
           ) as app_old_append,
           has_function_privilege(
             'kf_worker',
             'ml.append_metric_event_receipt(uuid,uuid,text,bigint,timestamp with time zone,double precision,text,timestamp with time zone,text)',
             'EXECUTE'
           ) as worker_old_append,
           has_function_privilege(
             'kf_app',
             'ml.append_metric_event_action(uuid,uuid,text,bigint,timestamp with time zone,double precision,text,timestamp with time zone,text)',
             'EXECUTE'
           ) as app_typed_append`,
      ),
    );
    expect(privileges).toEqual({
      app_setup_insert: false,
      worker_setup_insert: false,
      promoter_authorization_insert: false,
      app_old_append: false,
      worker_old_append: false,
      app_typed_append: true,
    });

    const fakeActionId = '77777777-7777-7777-8777-777777777777';
    await expect(
      withTransaction(h.pool, async (tx) => {
        await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
        await tx.query('select core.set_transaction_context($1, $2, $3, $4)', [
          f.performerId,
          f.performerRoleId,
          fakeActionId,
          'fake-ml-action',
        ]);
        await tx.query(
          `select * from ml.append_metric_event_action(
             $1, $2, $3, $4, $5, $6, null, null, $7
           )`,
          [
            ml.runLineageId,
            ml.metricDefinitionId,
            firstEvent.idempotencyKey,
            firstEvent.sequence,
            firstEvent.recordedAt,
            firstEvent.value.kind === 'number' ? firstEvent.value.number : null,
            firstEvent.eventDigest,
          ],
        );
      }),
    ).rejects.toThrow(/exact recorded action|exact open typed-action/i);

    await expect(
      withTransaction(h.pool, async (tx) => {
        const actionId = (await tx.one<{ id: string }>('select uuidv7() as id')).id;
        const requestId = `mismatched-ml-action:${actionId}`;
        await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
        await tx.query('select core.set_transaction_context($1, $2, $3, $4)', [
          f.performerId,
          f.performerRoleId,
          actionId,
          requestId,
        ]);
        await tx.query(
          `insert into core.action
             (id, action_type, actor_id, acting_role_id, target_ids, parameters,
              preconditions, idempotency_key, effective_at, request_id, result_status, result,
              organization_id, request_digest)
           values ($1, $2, $3, $4, $5, '{}', '{}', $6, date_trunc('milliseconds', now()), $7, 'applied', '{}', $8, $9)`,
          [
            actionId,
            ML_ACTION_TYPES.appendMetricEvent,
            f.performerId,
            f.performerRoleId,
            [f.organizationId],
            `mismatch-${actionId}`,
            requestId,
            f.organizationId,
            uniqueDigest(`mismatch-request:${actionId}`),
          ],
        );
        await tx.query(
          `select * from ml.append_metric_event_action(
             $1, $2, 'typed-event-mismatch', 9,
             '2026-08-14T12:09:00.000Z', 0.5, null, null, $3
           )`,
          [ml.runLineageId, ml.metricDefinitionId, uniqueDigest('mismatch-event')],
        );
      }),
    ).rejects.toThrow(/parameters do not exactly match/i);
  });

  it('rolls back the action envelope on digest failure and replays without a second envelope', async () => {
    const firstIntent = actionForMetricEventAppend({
      organizationId: f.organizationId,
      runLineageId: ml.runLineageId,
      metricDefinitionId: ml.metricDefinitionId,
      event: firstEvent,
    });
    const replay = await executeMl(
      actionRequest(firstIntent, {
        actorId: f.performerId,
        actingRoleId: f.performerRoleId,
        idempotencyKey: metricEventActionIdempotencyKey(firstEvent.eventDigest),
      }),
    );
    expect(replay).toMatchObject({ actionId: firstAppendActionId, replayed: true });

    const before = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ actions: string; audits: string; outbox: string; events: string }>(
        `select
           (select count(*) from core.action where action_type = $1)::text as actions,
           (select count(*) from core.audit_event where action_type = $1)::text as audits,
           (select count(*) from core.outbox outbox join core.action action
             on action.id = outbox.action_id where action.action_type = $1)::text as outbox,
           (select count(*) from ml.metric_event where run_lineage_id = $2)::text as events`,
        [ML_ACTION_TYPES.appendMetricEvent, ml.runLineageId],
      ),
    );
    expect(before).toEqual({ actions: '1', audits: '1', outbox: '1', events: '1' });

    const badEvent = event('typed-event-bad-digest', 2, 0.25);
    const badIntent = actionForMetricEventAppend({
      organizationId: f.organizationId,
      runLineageId: ml.runLineageId,
      metricDefinitionId: ml.metricDefinitionId,
      event: badEvent,
    });
    const badKey = metricEventActionIdempotencyKey(badEvent.eventDigest);
    await expect(
      executeMl({
        ...actionRequest(badIntent, {
          actorId: f.performerId,
          actingRoleId: f.performerRoleId,
          idempotencyKey: badKey,
        }),
        payload: { ...badIntent.parameters, eventDigest: 'f'.repeat(64) },
      }),
    ).rejects.toThrow(/digest does not match canonical/i);

    const after = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ actions: string; audits: string; outbox: string; events: string }>(
        `select
           (select count(*) from core.action
             where action_type = $1 and idempotency_key = $2)::text as actions,
           (select count(*) from core.audit_event event join core.action action
             on action.id = event.action_id
             where action.action_type = $1 and action.idempotency_key = $2)::text as audits,
           (select count(*) from core.outbox outbox join core.action action
             on action.id = outbox.action_id
             where action.action_type = $1 and action.idempotency_key = $2)::text as outbox,
           (select count(*) from ml.metric_event
             where run_lineage_id = $3 and idempotency_key = $4)::text as events`,
        [ML_ACTION_TYPES.appendMetricEvent, badKey, ml.runLineageId, badEvent.idempotencyKey],
      ),
    );
    expect(after).toEqual({ actions: '0', audits: '0', outbox: '0', events: '0' });
  });

  it('reconstructs ECMAScript canonical numbers at decimal and exponent boundaries', async () => {
    const values = [1e-7, 1e-6, 1e20, 1e21, 1.2345678901234567e30];
    for (const [index, value] of values.entries()) {
      const candidate = event(`typed-event-jcs-${index + 1}`, index + 2, value);
      const intent = actionForMetricEventAppend({
        organizationId: f.organizationId,
        runLineageId: ml.runLineageId,
        metricDefinitionId: ml.metricDefinitionId,
        event: candidate,
      });
      const result = await executeMl(
        actionRequest(intent, {
          actorId: f.performerId,
          actingRoleId: f.performerRoleId,
          idempotencyKey: metricEventActionIdempotencyKey(candidate.eventDigest),
        }),
      );
      expect(result.replayed).toBe(false);
    }
  });
});
