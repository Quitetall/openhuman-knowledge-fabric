import { generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalBytes } from '@kf/canonicalization';
import { createDispatcher } from '@kf/actions';
import {
  createPool,
  setAccessContext,
  setTransactionContext,
  withTransaction,
  type Tx,
} from '@kf/database';
import {
  actionForAuthoritySigningKeyRegistration,
  actionForAuthoritySigningKeyRevocation,
  actionForErasureRequest,
  actionForErasureTombstone,
  actionForReadCapabilityConsumption,
  actionForReadCapabilityIssue,
  actionForReadCapabilityRequest,
  actionForReadCapabilityRevocation,
  authoritySigningKeyMaterial,
  contentSha256,
  createSecureObjectActionAtoms,
  externalAuthorityRef,
  externalRevisionRef,
  policyDecisionRef,
  SECURE_OBJECT_ACTION_ROLES,
  SECURE_OBJECT_ACTION_TYPES,
  verifyErasureTombstone,
  workloadIdentityRef,
  type AuthoritySigningKey,
  type ErasureRequest,
  type SecureObjectActionIntent,
} from './secure-object.js';
import {
  consumeReadCapability,
  issueReadCapability,
  revokeReadCapability,
} from './secure-object/capabilities.js';
import { requestErasure } from './secure-object/erasure-requests.js';
import { registerAuthoritySigningKey, revokeAuthoritySigningKey } from './secure-object/keys.js';
import { requestReadCapability } from './secure-object/read-requests.js';
import { signErasureTombstone } from './secure-object/tombstones.js';
import {
  bindContext,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from '../../../tests/database/harness.js';

let h: Harness;
let f: Fixtures;
let other: Fixtures;
let qualityAuthorityRoleId: string;
let systemAdministratorRoleId: string;

function noncanonicalBase64PadBits(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const index = alphabet.indexOf(value.at(-3) ?? '');
  if (index < 0 || index % 16 !== 0) throw new Error('test fixture is not one-byte-tail base64');
  return `${value.slice(0, -3)}${alphabet[index + 1]}==`;
}

async function assignOrganizationRole(
  fixtures: Fixtures,
  actorId: string,
  roleId: 'quality_authority' | 'system_administrator',
): Promise<string> {
  const assignmentId = await createObject(h.adminPool, fixtures, {
    type: 'role_assignment',
    domain: 'organization',
    state: 'active',
    title: `${roleId} secure-object test assignment`,
    createdBy: actorId,
  });
  await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, fixtures, actorId);
    await tx.query(
      `insert into org.role_assignment (id, subject_id, role_id, scope_id)
       values ($1, $2, $3, $4)`,
      [assignmentId, actorId, roleId, fixtures.organizationId],
    );
  });
  return assignmentId;
}

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  other = await seedFixtures(h.adminPool);
  qualityAuthorityRoleId = await assignOrganizationRole(f, f.reviewerId, 'quality_authority');
  systemAdministratorRoleId = await assignOrganizationRole(f, f.reviewerId, 'system_administrator');
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

async function withAction<T>(
  fixtures: Fixtures,
  // Deliberately wider than SecureObjectActionIntent: several tests below commit a REAL but
  // wrong action type (`attach_evidence`) to prove the database refuses a secure-object write
  // that is not carried by its own action. The production type is correctly narrow and cannot
  // express that, so the widening lives here rather than as a cast at each call site.
  intent: Omit<SecureObjectActionIntent, 'actionType'> & { readonly actionType: string },
  operation: (tx: Tx) => Promise<T>,
  options: {
    readonly actorId?: string;
    readonly actingRoleId?: string;
    readonly maxClassification?: string;
    readonly effectiveAt?: Date;
    readonly isolationLevel?: 'read committed' | 'repeatable read';
  } = {},
): Promise<T> {
  return withTransaction(h.pool, async (tx) => {
    if (options.isolationLevel !== undefined) {
      await tx.query(`set transaction isolation level ${options.isolationLevel}`);
    }
    const actorId = options.actorId ?? fixtures.reviewerId;
    const actingRoleId = options.actingRoleId ?? fixtures.reviewerRoleId;
    const actionId = (await tx.one<{ id: string }>('select uuidv7() as id')).id;
    const effectiveAt = options.effectiveAt ?? new Date();

    await setAccessContext(tx, {
      organizationId: fixtures.organizationId,
      maxClassification: options.maxClassification ?? 'restricted',
    });
    await setTransactionContext(tx, {
      actorId,
      actingRoleId,
      actionId,
      requestId: `secure-object-test-${actionId}`,
    });
    await tx.query(
      `insert into core.action
         (id, organization_id, action_type, actor_id, acting_role_id, target_ids,
          parameters, preconditions, idempotency_key, request_digest, effective_at,
          request_id, result_status, result)
       values ($1, $2, $3, $4, $5, $6, $7, '{}', $8, $9, $10, $11, 'applied', '{}')`,
      [
        actionId,
        fixtures.organizationId,
        intent.actionType,
        actorId,
        actingRoleId,
        [intent.targetId],
        JSON.stringify(intent.parameters),
        `secure-${actionId}`,
        'f'.repeat(64),
        effectiveAt,
        `secure-object-test-${actionId}`,
      ],
    );
    return operation(tx);
  });
}

async function withAccess<T>(
  fixtures: Fixtures,
  maxClassification: string,
  operation: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withTransaction(h.pool, async (tx) => {
    await setAccessContext(tx, {
      organizationId: fixtures.organizationId,
      maxClassification,
    });
    return operation(tx);
  });
}

const authority = externalAuthorityRef('authority:opaque-soa');
const workload = workloadIdentityRef('workload:blut-trainer-01');
const decision = policyDecisionRef('policy-decision:01HZSAFE9V6Q');
const trainingDigest = contentSha256('a'.repeat(64));
const erasureDigest = contentSha256('e'.repeat(64));

function readInput(suffix: string) {
  return {
    organizationId: f.organizationId,
    classificationId: 'restricted',
    authorityRef: authority,
    revisionRef: externalRevisionRef(`revision:opaque-${suffix}`),
    externalContentSha256: trainingDigest,
    purpose: 'ml_training' as const,
    workloadIdentityRef: workload,
    policyDecisionRef: decision,
    idempotencyKey: `read-${suffix}`,
    ttlSeconds: 120,
  };
}

async function createReadRequest(suffix: string) {
  const input = readInput(suffix);
  return withAction(f, actionForReadCapabilityRequest(input), (tx) =>
    requestReadCapability(tx, input),
  );
}

async function issueRead(suffix: string) {
  const request = await createReadRequest(suffix);
  const capability = await withAction(f, actionForReadCapabilityIssue(request), (tx) =>
    issueReadCapability(tx, { request }),
  );
  return { request, capability };
}

function erasureInput(suffix: string) {
  return {
    organizationId: f.organizationId,
    classificationId: 'restricted',
    authorityRef: authority,
    revisionRef: externalRevisionRef(`revision:opaque-erasure-${suffix}`),
    externalContentSha256: erasureDigest,
    purpose: 'authorized_erasure' as const,
    workloadIdentityRef: workload,
    policyDecisionRef: decision,
  };
}

async function createErasureRequest(suffix: string): Promise<ErasureRequest> {
  const input = erasureInput(suffix);
  return withAction(f, actionForErasureRequest(input), (tx) => requestErasure(tx, input), {
    actorId: f.reviewerId,
    actingRoleId: qualityAuthorityRoleId,
  });
}

function keyRegistrationInput(
  keyId: string,
  publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'],
  rotatesKeyRegistryId: string | null = null,
) {
  return {
    organizationId: f.organizationId,
    authorityRef: authority,
    keyId,
    publicKey,
    rotatesKeyRegistryId,
    validUntil: null,
  };
}

async function registerKey(
  keyId: string,
  publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'],
  rotatesKeyRegistryId: string | null = null,
): Promise<AuthoritySigningKey> {
  const input = keyRegistrationInput(keyId, publicKey, rotatesKeyRegistryId);
  return withAction(
    f,
    actionForAuthoritySigningKeyRegistration(input),
    (tx) => registerAuthoritySigningKey(tx, input),
    { actorId: f.reviewerId, actingRoleId: systemAdministratorRoleId },
  );
}

async function insertDirectErasureTombstone(
  tx: Tx,
  input: {
    readonly request: ErasureRequest;
    readonly key: AuthoritySigningKey;
    readonly signature: string;
  },
): Promise<void> {
  const { request, key, signature } = input;
  await tx.query(
    `insert into secure_object.erasure_tombstone
       (erasure_request_id, external_content_sha256, purpose, workload_identity_ref,
        policy_decision_ref, tombstone_version, erased_at, signing_key_registry_id,
        signing_key_id, signature)
     values ($1, $2, $3, $4, $5, 'kf-secure-object-erasure-tombstone/v1',
             now(), $6, $7, $8)`,
    [
      request.id,
      request.externalContentSha256,
      request.purpose,
      request.workloadIdentityRef,
      request.policyDecisionRef,
      key.id,
      key.keyId,
      signature,
    ],
  );
}

async function expectUncommittedRevocationToWin(
  isolationLevel: 'read committed' | 'repeatable read',
  expectedFailure: RegExp,
): Promise<void> {
  const suffix = isolationLevel.replaceAll(' ', '-');
  const request = await createErasureRequest(`concurrent-key-revocation-${suffix}`);
  const pair = generateKeyPairSync('ed25519');
  const key = await registerKey(`soa-key-concurrent-revocation-${suffix}`, pair.publicKey);
  const reasonCode = 'key_compromise' as const;
  let markRevocationInserted!: () => void;
  let rejectRevocationInserted!: (error: unknown) => void;
  const revocationInserted = new Promise<void>((resolve, reject) => {
    markRevocationInserted = resolve;
    rejectRevocationInserted = reject;
  });
  let releaseRevocation!: () => void;
  const holdRevocation = new Promise<void>((resolve) => {
    releaseRevocation = resolve;
  });

  const revocationPromise = withAction(
    f,
    actionForAuthoritySigningKeyRevocation(key, reasonCode),
    async (tx) => {
      const inserted = await revokeAuthoritySigningKey(tx, { key, reasonCode });
      markRevocationInserted();
      await holdRevocation;
      return inserted;
    },
    { actorId: f.reviewerId, actingRoleId: systemAdministratorRoleId },
  ).catch((error: unknown) => {
    rejectRevocationInserted(error);
    throw error;
  });

  let tombstoneBackendPid = 0;
  let markSignerInvoked!: () => void;
  const signerInvoked = new Promise<void>((resolve) => {
    markSignerInvoked = resolve;
  });
  let tombstonePromise: Promise<unknown> | undefined;
  try {
    await revocationInserted;
    tombstonePromise = withAction(
      f,
      actionForErasureTombstone(request, key.id),
      async (tx) => {
        tombstoneBackendPid = (
          await tx.one<{ readonly pid: number }>('select pg_backend_pid()::integer as pid')
        ).pid;
        return signErasureTombstone(tx, {
          request,
          signingKeyRegistryId: key.id,
          signer: (bytes) => {
            markSignerInvoked();
            return edSign(null, bytes, pair.privateKey);
          },
        });
      },
      {
        actorId: f.reviewerId,
        actingRoleId: qualityAuthorityRoleId,
        isolationLevel,
      },
    );
    const tombstoneOutcome = tombstonePromise.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    await signerInvoked;
    await expect
      .poll(
        () =>
          withTransaction(h.adminPool, (tx) =>
            tx.one<{ readonly waiting: boolean }>(
              `select exists (
                 select 1 from pg_stat_activity
                  where pid = $1 and wait_event_type = 'Lock' and wait_event = 'advisory'
               ) as waiting`,
              [tombstoneBackendPid],
            ),
          ).then((row) => row.waiting),
        { interval: 20, timeout: 5_000 },
      )
      .toBe(true);

    releaseRevocation();
    await expect(revocationPromise).resolves.toBe(true);
    const tombstoneResult = await tombstoneOutcome;
    expect(tombstoneResult.status).toBe('rejected');
    if (tombstoneResult.status === 'rejected') {
      expect(tombstoneResult.error).toMatchObject({
        message: expect.stringMatching(expectedFailure),
      });
    }

    const persisted = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ readonly revocations: string; readonly tombstones: string }>(
        `select
           (select count(*) from secure_object.authority_signing_key_revocation
             where signing_key_registry_id = $1)::text as revocations,
           (select count(*) from secure_object.erasure_tombstone
             where erasure_request_id = $2)::text as tombstones`,
        [key.id, request.id],
      ),
    );
    expect(persisted).toEqual({ revocations: '1', tombstones: '0' });
  } finally {
    releaseRevocation();
    await Promise.allSettled([revocationPromise, ...(tombstonePromise ? [tombstonePromise] : [])]);
  }
}

describe('typed secure-object authority', () => {
  it('composes as an audited dispatcher effect and refuses committed-action reuse', async () => {
    const input = readInput('dispatcher');
    const intent = actionForReadCapabilityRequest(input);
    const execute = createDispatcher(h.pool, createSecureObjectActionAtoms());
    const ordinaryRoleRequest = {
      actionType: intent.actionType,
      actorId: f.performerId,
      actingRoleId: f.performerRoleId,
      targetIds: [intent.targetId],
      payload: intent.parameters,
      idempotencyKey: input.idempotencyKey,
      organizationId: f.organizationId,
      maxClassification: 'restricted',
    };

    await expect(execute(ordinaryRoleRequest)).rejects.toThrow(/technical_authority/);

    const actionRequest = {
      ...ordinaryRoleRequest,
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
    };

    const applied = await execute(actionRequest);
    expect(applied.replayed).toBe(false);
    const recorded = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ request_count: string; audit_count: string }>(
        `select
           (select count(*) from secure_object.capability_request where action_id = $1)::text
             as request_count,
           (select count(*) from core.audit_event where action_id = $1)::text as audit_count`,
        [applied.actionId],
      ),
    );
    expect(recorded).toEqual({ request_count: '1', audit_count: '1' });

    await expect(execute(actionRequest)).resolves.toMatchObject({
      actionId: applied.actionId,
      replayed: true,
    });

    await expect(
      withTransaction(h.pool, async (tx) => {
        await setAccessContext(tx, {
          organizationId: f.organizationId,
          maxClassification: 'restricted',
        });
        await setTransactionContext(tx, {
          actorId: f.reviewerId,
          actingRoleId: f.reviewerRoleId,
          actionId: applied.actionId,
        });
        await tx.query(
          `insert into secure_object.capability_request
             (organization_id, classification_id, external_authority_ref,
              external_revision_ref, external_content_sha256, purpose,
              workload_identity_ref, policy_decision_ref, idempotency_key, ttl_seconds)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            input.organizationId,
            input.classificationId,
            input.authorityRef,
            input.revisionRef,
            input.externalContentSha256,
            input.purpose,
            input.workloadIdentityRef,
            input.policyDecisionRef,
            input.idempotencyKey,
            input.ttlSeconds,
          ],
        );
      }),
    ).rejects.toThrow(/creating transaction|precede its audit event/);

    await expect(
      execute({
        ...actionRequest,
        idempotencyKey: 'wrong-target-person',
        targetIds: [f.performerId],
      }),
    ).rejects.toThrow(/owning organization object/);
  });

  it('rejects wrong action type, target, and exact semantic parameters', async () => {
    const input = readInput('typed-gate');
    const correct = actionForReadCapabilityRequest(input);

    await expect(
      withAction(f, { ...correct, actionType: 'attach_evidence' }, (tx) =>
        requestReadCapability(tx, input),
      ),
    ).rejects.toThrow(/request_secure_object_access/);

    await expect(
      withAction(f, { ...correct, targetId: other.organizationId }, (tx) =>
        requestReadCapability(tx, input),
      ),
    ).rejects.toThrow(/target/);

    await expect(
      withAction(
        f,
        {
          ...correct,
          parameters: { ...correct.parameters, externalContentSha256: 'b'.repeat(64) },
        },
        (tx) => requestReadCapability(tx, input),
      ),
    ).rejects.toThrow(/parameters/);

    await expect(
      withAction(f, correct, (tx) => requestReadCapability(tx, input)),
    ).resolves.toMatchObject({ externalContentSha256: trainingDigest });
  });

  it('rejects ordinary organization roles in typed preconditions and the raw DB guard', async () => {
    expect(SECURE_OBJECT_ACTION_ROLES).toEqual({
      request_secure_object_access: ['technical_authority'],
      issue_secure_object_capability: ['technical_authority'],
      revoke_secure_object_capability: ['technical_authority'],
      consume_secure_object_capability: ['technical_authority'],
      request_secure_object_erasure: ['quality_authority'],
      record_secure_object_erasure: ['quality_authority'],
      register_secure_object_authority_key: ['system_administrator'],
      revoke_secure_object_authority_key: ['system_administrator'],
    });

    const execute = createDispatcher(h.pool, createSecureObjectActionAtoms());
    for (const actionType of Object.values(SECURE_OBJECT_ACTION_TYPES)) {
      await expect(
        execute({
          actionType,
          actorId: f.performerId,
          actingRoleId: f.performerRoleId,
          targetIds: [f.organizationId],
          payload: {},
          idempotencyKey: `ordinary-role-${actionType}`,
          organizationId: f.organizationId,
          maxClassification: 'restricted',
        }),
      ).rejects.toThrow(/requires (technical_authority|quality_authority|system_administrator)/);

      const intent: SecureObjectActionIntent = {
        actionType,
        targetId: f.organizationId,
        parameters: {},
      };
      await expect(
        withAction(
          f,
          intent,
          (tx) =>
            tx.query('select secure_object.require_exact_action($1, $2, $3::jsonb)', [
              actionType,
              f.organizationId,
              JSON.stringify(intent.parameters),
            ]),
          { actorId: f.performerId, actingRoleId: f.performerRoleId },
        ),
      ).rejects.toThrow(/role category/);
    }
  });

  it('refuses broad raw DML without exact action context', async () => {
    await expect(
      withAccess(f, 'restricted', (tx) =>
        tx.query(
          `insert into secure_object.capability_request
             (organization_id, classification_id, external_authority_ref,
              external_revision_ref, external_content_sha256, purpose,
              workload_identity_ref, policy_decision_ref, idempotency_key, ttl_seconds,
              actor_id, action_id, requested_at, expires_at)
           values ($1, 'restricted', $2, $3, $4, 'ml_training', $5, $6, $7, 120,
                   $8, uuidv7(), now(), now() + interval '2 minutes')`,
          [
            f.organizationId,
            authority,
            externalRevisionRef('revision:raw-dml'),
            trainingDigest,
            workload,
            decision,
            'raw-dml-request',
            f.performerId,
          ],
        ),
      ),
    ).rejects.toThrow(/transaction context|exact secure-object action/);
  });

  it('binds digest through request, capability, consumption and revocation receipts', async () => {
    const { capability } = await issueRead('digest-flow');
    expect(capability.externalContentSha256).toBe(trainingDigest);

    await expect(
      withAction(
        f,
        {
          ...actionForReadCapabilityConsumption(capability),
          parameters: {
            ...actionForReadCapabilityConsumption(capability).parameters,
            externalContentSha256: 'b'.repeat(64),
          },
        },
        (tx) => consumeReadCapability(tx, { capability }),
      ),
    ).rejects.toThrow(/parameters/);

    await expect(
      withAction(
        f,
        {
          ...actionForReadCapabilityConsumption(capability),
          parameters: {
            ...actionForReadCapabilityConsumption(capability).parameters,
            workloadIdentityRef: 'workload:someone-else',
          },
        },
        (tx) => consumeReadCapability(tx, { capability }),
      ),
    ).rejects.toThrow(/parameters/);

    const consumed = await withAction(f, actionForReadCapabilityConsumption(capability), (tx) =>
      consumeReadCapability(tx, { capability }),
    );
    expect(consumed.externalContentSha256).toBe(trainingDigest);

    await expect(
      withAction(f, actionForReadCapabilityRevocation(capability), (tx) =>
        revokeReadCapability(tx, { capability }),
      ),
    ).resolves.toBe(false);

    const { capability: revoked } = await issueRead('digest-revoked');
    await expect(
      withAction(f, actionForReadCapabilityRevocation(revoked), (tx) =>
        revokeReadCapability(tx, { capability: revoked }),
      ),
    ).resolves.toBe(true);
    await expect(
      withAction(f, actionForReadCapabilityConsumption(revoked), (tx) =>
        consumeReadCapability(tx, { capability: revoked }),
      ),
    ).rejects.toMatchObject({ failure: 'capability_unavailable' });
  });

  it('keeps request idempotency concurrent and bound to complete digest semantics', async () => {
    const input = readInput('idempotent');
    const intent = actionForReadCapabilityRequest(input);
    const [first, replay] = await Promise.all([
      withAction(f, intent, (tx) => requestReadCapability(tx, input)),
      withAction(f, intent, (tx) => requestReadCapability(tx, input)),
    ]);
    expect(replay).toEqual(first);

    const divergent = {
      ...input,
      externalContentSha256: contentSha256('c'.repeat(64)),
    };
    await expect(
      withAction(f, actionForReadCapabilityRequest(divergent), (tx) =>
        requestReadCapability(tx, divergent),
      ),
    ).rejects.toMatchObject({ failure: 'idempotency_conflict' });
  });
});

describe('SOA signing-key authority', () => {
  it('rejects a direct arbitrary tombstone signature under an otherwise exact action', async () => {
    const request = await createErasureRequest('direct-arbitrary-signature');
    const pair = generateKeyPairSync('ed25519');
    const key = await registerKey('soa-key-direct-arbitrary-signature', pair.publicKey);

    await expect(
      withAction(
        f,
        actionForErasureTombstone(request, key.id),
        (tx) =>
          insertDirectErasureTombstone(tx, {
            request,
            key,
            signature: Buffer.alloc(64, 0x42).toString('base64'),
          }),
        { actorId: f.reviewerId, actingRoleId: qualityAuthorityRoleId },
      ),
    ).rejects.toThrow(/Ed25519 signature verification failed/);
  });

  it('rejects malformed and noncanonical base64 tombstone signatures', async () => {
    const request = await createErasureRequest('malformed-signature');
    const pair = generateKeyPairSync('ed25519');
    const key = await registerKey('soa-key-malformed-signature', pair.publicKey);
    const canonicalZeroes = Buffer.alloc(64).toString('base64');
    const noncanonicalPadBits = `${canonicalZeroes.slice(0, -3)}B==`;

    for (const signature of ['not-base64', noncanonicalPadBits]) {
      await expect(
        withAction(
          f,
          actionForErasureTombstone(request, key.id),
          (tx) => insertDirectErasureTombstone(tx, { request, key, signature }),
          { actorId: f.reviewerId, actingRoleId: qualityAuthorityRoleId },
        ),
      ).rejects.toThrow(/canonical base64 for 64 bytes/);
    }
  });

  it('rejects a valid signature from another registered key and a cross-key action replay', async () => {
    const request = await createErasureRequest('cross-key-signature');
    const expectedPair = generateKeyPairSync('ed25519');
    const otherPair = generateKeyPairSync('ed25519');
    const expectedKey = await registerKey('soa-key-cross-key-expected', expectedPair.publicKey);
    const otherKey = await registerKey('soa-key-cross-key-other', otherPair.publicKey);

    await expect(
      withAction(
        f,
        actionForErasureTombstone(request, expectedKey.id),
        async (tx) => {
          const currentAction = await tx.one<{
            readonly actor_id: string;
            readonly effective_at: Date;
            readonly id: string;
          }>(
            `select action.id, action.actor_id, action.effective_at
               from core.action action
              where action.id = core.current_action_id()`,
          );
          const signature = edSign(
            null,
            canonicalBytes({
              erased_at: currentAction.effective_at.toISOString(),
              erasure_request_id: request.id,
              external_content_sha256: request.externalContentSha256,
              policy_decision_ref: request.policyDecisionRef,
              purpose: request.purpose,
              signer_action_id: currentAction.id,
              signer_id: currentAction.actor_id,
              signing_key_id: expectedKey.keyId,
              signing_key_registry_id: expectedKey.id,
              version: 'kf-secure-object-erasure-tombstone/v1',
              workload_identity_ref: request.workloadIdentityRef,
            }),
            otherPair.privateKey,
          ).toString('base64');
          await insertDirectErasureTombstone(tx, { request, key: expectedKey, signature });
        },
        { actorId: f.reviewerId, actingRoleId: qualityAuthorityRoleId },
      ),
    ).rejects.toThrow(/Ed25519 signature verification failed/);

    await expect(
      withAction(
        f,
        actionForErasureTombstone(request, expectedKey.id),
        (tx) =>
          insertDirectErasureTombstone(tx, {
            request,
            key: otherKey,
            signature: Buffer.alloc(64, 0x42).toString('base64'),
          }),
        { actorId: f.reviewerId, actingRoleId: qualityAuthorityRoleId },
      ),
    ).rejects.toThrow(/parameters/);
  });

  it('requires owner-registered active Ed25519 key and rejects arbitrary private key', async () => {
    const request = await createErasureRequest('registered-key');
    const registeredPair = generateKeyPairSync('ed25519');
    const arbitraryPair = generateKeyPairSync('ed25519');
    const key = await registerKey('soa-key-2026-01', registeredPair.publicKey);

    const unauthorizedSigner = vi.fn((bytes: Uint8Array) =>
      edSign(null, bytes, registeredPair.privateKey),
    );
    await expect(
      withAction(
        f,
        { ...actionForErasureTombstone(request, key.id), actionType: 'attach_evidence' },
        (tx) =>
          signErasureTombstone(tx, {
            request,
            signingKeyRegistryId: key.id,
            signer: unauthorizedSigner,
          }),
        { actorId: f.reviewerId, actingRoleId: qualityAuthorityRoleId },
      ),
    ).rejects.toThrow(/record_secure_object_erasure/);
    expect(unauthorizedSigner).not.toHaveBeenCalled();

    await expect(
      withAction(
        f,
        actionForErasureTombstone(request, key.id),
        (tx) =>
          signErasureTombstone(tx, {
            request,
            signingKeyRegistryId: key.id,
            signer: (bytes) => edSign(null, bytes, arbitraryPair.privateKey),
          }),
        { actorId: f.reviewerId, actingRoleId: qualityAuthorityRoleId },
      ),
    ).rejects.toMatchObject({ failure: 'signing_key_unavailable' });

    const tombstone = await withAction(
      f,
      actionForErasureTombstone(request, key.id),
      (tx) =>
        signErasureTombstone(tx, {
          request,
          signingKeyRegistryId: key.id,
          signer: (bytes) => edSign(null, bytes, registeredPair.privateKey),
        }),
      { actorId: f.reviewerId, actingRoleId: qualityAuthorityRoleId },
    );

    expect(tombstone.externalContentSha256).toBe(erasureDigest);
    expect(tombstone.signingKeyRegistryId).toBe(key.id);
    expect(verifyErasureTombstone(tombstone, registeredPair.publicKey)).toBe(true);
    expect(
      verifyErasureTombstone(
        { ...tombstone, signature: noncanonicalBase64PadBits(tombstone.signature) },
        registeredPair.publicKey,
      ),
    ).toBe(false);
    expect(
      edVerify(
        null,
        canonicalBytes({
          erased_at: tombstone.erasedAt.toISOString(),
          erasure_request_id: tombstone.erasureRequestId,
          external_content_sha256: erasureDigest,
          policy_decision_ref: decision,
          purpose: 'authorized_erasure',
          signer_action_id: tombstone.signerActionId,
          signer_id: tombstone.signerId,
          signing_key_id: key.keyId,
          signing_key_registry_id: key.id,
          version: tombstone.version,
          workload_identity_ref: workload,
        }),
        registeredPair.publicKey,
        Buffer.from(tombstone.signature, 'base64'),
      ),
    ).toBe(true);
  });

  it('rejects future action effectivity for key revocations and erasure tombstones', async () => {
    const future = new Date('2098-08-15T12:30:00.000Z');
    const revocationPair = generateKeyPairSync('ed25519');
    const revocationKey = await registerKey('soa-key-future-revocation', revocationPair.publicKey);
    await expect(
      withAction(
        f,
        actionForAuthoritySigningKeyRevocation(revocationKey, 'administrative'),
        (tx) =>
          revokeAuthoritySigningKey(tx, {
            key: revocationKey,
            reasonCode: 'administrative',
          }),
        {
          actorId: f.reviewerId,
          actingRoleId: systemAdministratorRoleId,
          effectiveAt: future,
        },
      ),
    ).rejects.toThrow(/must not be in the future/i);

    const request = await createErasureRequest('future-tombstone');
    const tombstonePair = generateKeyPairSync('ed25519');
    const tombstoneKey = await registerKey('soa-key-future-tombstone', tombstonePair.publicKey);
    await expect(
      withAction(
        f,
        actionForErasureTombstone(request, tombstoneKey.id),
        (tx) =>
          signErasureTombstone(tx, {
            request,
            signingKeyRegistryId: tombstoneKey.id,
            signer: (bytes) => edSign(null, bytes, tombstonePair.privateKey),
          }),
        { actorId: f.reviewerId, actingRoleId: qualityAuthorityRoleId, effectiveAt: future },
      ),
    ).rejects.toThrow(/must not be in the future/i);
  });

  it('times out a stalled external signer and releases the action transaction', async () => {
    const request = await createErasureRequest('stalled-signer');
    const pair = generateKeyPairSync('ed25519');
    const key = await registerKey('soa-key-stalled-signer', pair.publicKey);
    const intent = actionForErasureTombstone(request, key.id);
    const appUri = new URL(h.connectionString);
    appUri.username = 'kf_app_login';
    appUri.password = 'test-only-not-a-secret';
    const singleConnectionPool = createPool({
      connectionString: appUri.toString(),
      maxConnections: 1,
    });
    let aborted = false;
    const stalledSigner = vi.fn(
      ({ signal }: { readonly signal: AbortSignal }) =>
        new Promise<Uint8Array>(() => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
            },
            { once: true },
          );
        }),
    );
    const execute = createDispatcher(
      singleConnectionPool,
      createSecureObjectActionAtoms({
        authoritySigner: { sign: stalledSigner },
        authoritySignerTimeoutMs: 25,
      }),
    );
    const idempotencyKey = 'stalled-authority-signer';
    const startedAt = Date.now();
    try {
      await expect(
        execute({
          actionType: intent.actionType,
          actorId: f.reviewerId,
          actingRoleId: qualityAuthorityRoleId,
          targetIds: [intent.targetId],
          payload: intent.parameters,
          idempotencyKey,
          organizationId: f.organizationId,
          maxClassification: 'restricted',
        }),
      ).rejects.toMatchObject({ failure: 'signer_timeout' });
      expect(Date.now() - startedAt).toBeLessThan(1_500);
      expect(aborted).toBe(true);

      await expect(
        withTransaction(singleConnectionPool, (tx) =>
          tx.one<{ ok: number }>('select 1::integer as ok'),
        ),
      ).resolves.toEqual({ ok: 1 });
      const persisted = await withTransaction(h.adminPool, (tx) =>
        tx.one<{ actions: string; tombstones: string }>(
          `select
             (select count(*) from core.action where idempotency_key = $1)::text as actions,
             (select count(*) from secure_object.erasure_tombstone
               where erasure_request_id = $2)::text as tombstones`,
          [idempotencyKey, request.id],
        ),
      );
      expect(persisted).toEqual({ actions: '0', tombstones: '0' });
    } finally {
      await singleConnectionPool.end();
    }
  });

  it('supports explicit rotation and makes revoked keys unusable', async () => {
    const oldPair = generateKeyPairSync('ed25519');
    const nextPair = generateKeyPairSync('ed25519');
    const oldKey = await registerKey('soa-key-old', oldPair.publicKey);
    const nextKey = await registerKey('soa-key-next', nextPair.publicKey, oldKey.id);
    expect(nextKey.rotatesKeyRegistryId).toBe(oldKey.id);

    const reasonCode = 'key_rotation' as const;
    await withAction(
      f,
      actionForAuthoritySigningKeyRevocation(oldKey, reasonCode),
      (tx) => revokeAuthoritySigningKey(tx, { key: oldKey, reasonCode }),
      { actorId: f.reviewerId, actingRoleId: systemAdministratorRoleId },
    );

    const oldRequest = await createErasureRequest('revoked-key');
    await expect(
      withAction(
        f,
        actionForErasureTombstone(oldRequest, oldKey.id),
        (tx) =>
          signErasureTombstone(tx, {
            request: oldRequest,
            signingKeyRegistryId: oldKey.id,
            signer: (bytes) => edSign(null, bytes, oldPair.privateKey),
          }),
        { actorId: f.reviewerId, actingRoleId: qualityAuthorityRoleId },
      ),
    ).rejects.toMatchObject({ failure: 'signing_key_unavailable' });

    const nextRequest = await createErasureRequest('rotated-key');
    await expect(
      withAction(
        f,
        actionForErasureTombstone(nextRequest, nextKey.id),
        (tx) =>
          signErasureTombstone(tx, {
            request: nextRequest,
            signingKeyRegistryId: nextKey.id,
            signer: (bytes) => edSign(null, bytes, nextPair.privateKey),
          }),
        { actorId: f.reviewerId, actingRoleId: qualityAuthorityRoleId },
      ),
    ).resolves.toMatchObject({ signingKeyRegistryId: nextKey.id });
  });

  it('orders an uncommitted key revocation before a concurrent tombstone', () =>
    expectUncommittedRevocationToWin(
      'read committed',
      /not registered and active for exact authority/,
    ));

  it('rejects a stale repeatable-read snapshot after the revocation lock wait', () =>
    expectUncommittedRevocationToWin(
      'repeatable read',
      /requires READ COMMITTED transaction isolation/,
    ));

  it('forces organization/classification RLS across key and receipt tables', async () => {
    const pair = generateKeyPairSync('ed25519');
    const key = await registerKey('soa-key-rls', pair.publicKey);

    const flags = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `select c.relname, c.relrowsecurity, c.relforcerowsecurity
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'secure_object' and c.relkind = 'r'
          order by c.relname`,
      ),
    );
    expect(flags).toHaveLength(8);
    expect(flags.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);

    const invisible = await withAccess(other, 'restricted', (tx) =>
      tx.one<{ count: string }>(
        `select count(*)::text as count from secure_object.authority_signing_key where id = $1`,
        [key.id],
      ),
    );
    expect(Number(invisible.count)).toBe(0);
  });

  it('stores public material only and rejects malformed or non-Ed25519 material', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => authoritySigningKeyMaterial(rsa.publicKey)).toThrow(/Ed25519/);
  });
});

describe('opaque-record boundary', () => {
  it('contains no PHI locator or free-text columns and does carry exact digest', async () => {
    const forbiddenColumns = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'secure_object'
            and column_name in (
              'subject', 'session', 'locator', 'path', 'reason', 'notes', 'free_text', 'private_key'
            )`,
      ),
    );
    expect(forbiddenColumns).toEqual([]);

    const digestColumns = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ table_name: string }>(
        `select table_name from information_schema.columns
          where table_schema = 'secure_object'
            and column_name = 'external_content_sha256'
          order by table_name`,
      ),
    );
    expect(digestColumns.map((row) => row.table_name)).toEqual([
      'capability_consumption',
      'capability_issue',
      'capability_request',
      'capability_revocation',
      'erasure_request',
      'erasure_tombstone',
    ]);
  });

  it('lets backup read every secure table but never append', async () => {
    await withTransaction(h.adminPool, async (tx) => {
      await tx.query(
        `do $$ begin
           if not exists (select 1 from pg_roles where rolname = 'kf_backup_login') then
             create role kf_backup_login login password 'test-only-not-a-secret' inherit;
           end if;
         end $$`,
      );
      await tx.query('grant kf_backup to kf_backup_login');
      await tx.query('grant connect on database kf_test to kf_backup_login');
    });
    const backupUri = new URL(h.connectionString);
    backupUri.username = 'kf_backup_login';
    backupUri.password = 'test-only-not-a-secret';
    const backupPool = createPool({ connectionString: backupUri.toString(), maxConnections: 1 });
    try {
      const visible = await withTransaction(backupPool, (tx) =>
        tx.query<{ table_name: string; row_count: string }>(
          `select 'authority_signing_key' as table_name,
                  count(*)::text as row_count from secure_object.authority_signing_key
           union all
           select 'capability_request', count(*)::text
             from secure_object.capability_request
           union all
           select 'erasure_tombstone', count(*)::text
             from secure_object.erasure_tombstone
           order by table_name`,
        ),
      );
      expect(visible.some((row) => Number(row.row_count) > 0)).toBe(true);

      await expect(
        withTransaction(backupPool, (tx) =>
          tx.query(
            `insert into secure_object.capability_request
               (organization_id, classification_id, external_authority_ref,
                external_revision_ref, external_content_sha256, purpose,
                workload_identity_ref, policy_decision_ref, idempotency_key, ttl_seconds)
             values ($1, 'internal', 'authority:backup', 'revision:backup', $2,
                     'ml_training', 'workload:backup', 'policy:backup',
                     'backup-must-not-write', 60)`,
            [f.organizationId, trainingDigest],
          ),
        ),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await backupPool.end();
    }
  });
});
