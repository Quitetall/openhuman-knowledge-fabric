import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { withTransaction } from '@kf/database';
import { createFabricDispatcher } from '@kf/orchestrator';
import { seedFixtures, startHarness, type Fixtures, type Harness } from './harness.js';

/**
 * OpenWarrant SAS §67 against a real database (ADR 0019). What OW-WAR-0044 needs from KF,
 * in its own words:
 *
 *   1. A Warrant registered through §67 typed actions: draft → proposed → authorized, with
 *      immutable contract revisions carrying the digest and Compilation Basis OpenWarrant
 *      computed, and `recorded_at` assigned by the server (§67.2).
 *   2. The OpenWarrant UUIDv7 IS the object id (§12.2); a second draft under it is refused.
 *   3. §67.3: a stale `expected_version` fails rather than overwrites.
 *   4. §67.4: an identical retry replays; the same key with a different payload is refused.
 *   5. Authorizing a digest other than the proposed one is refused; a revision is immutable.
 *   6. A Warrant is numbered OH-WAR-NNNNNN-C by the allocator (registry 1.0.0-draft.2), and a
 *      caller-proposed identifier is still refused — the contrast §12.4 asks for.
 *   7. Withdrawal returns to draft; amendment, condition, outcome and standing move the other
 *      dimensions and leave the phase where §24 says.
 */

let harness: Harness;
let fixtures: Fixtures;

beforeAll(async () => {
  harness = await startHarness();
  fixtures = await seedFixtures(harness.adminPool);
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

const dispatcher = () => createFabricDispatcher(harness.pool);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function act(
  actionType: string,
  targetIds: readonly string[],
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return dispatcher()({
    actionType,
    actorId: fixtures.reviewerId,
    actingRoleId: fixtures.reviewerRoleId,
    targetIds: [...targetIds],
    organizationId: fixtures.organizationId,
    maxClassification: 'restricted',
    idempotencyKey: `${actionType}-${randomUUID()}`,
    reason: `${actionType} for the §67 proof`,
    payload: payload as NonNullable<Parameters<ReturnType<typeof dispatcher>>[0]['payload']>,
    ...extra,
  });
}

async function phaseAndVersion(id: string): Promise<{ phase: string; version: number }> {
  const row = await withTransaction(harness.adminPool, (tx) =>
    tx.one<{ lifecycle_state: string; row_version: string }>(
      'select lifecycle_state, row_version::text from core.object where id = $1',
      [id],
    ),
  );
  return { phase: row.lifecycle_state, version: Number(row.row_version) };
}

async function warrantRow(id: string): Promise<Record<string, unknown>> {
  return withTransaction(harness.adminPool, (tx) =>
    tx.one<Record<string, unknown>>('select * from work.warrant where id = $1', [id]),
  );
}

/** The UUIDv7 OpenWarrant would mint at draft creation (§12.2), minted here by the database. */
async function uuidv7(): Promise<string> {
  const row = await withTransaction(harness.adminPool, (tx) =>
    tx.one<{ id: string }>('select uuidv7()::text as id'),
  );
  return row.id;
}

async function draft(alias: string): Promise<string> {
  const uuid = await uuidv7();
  const result = await act('create_warrant_draft', [], {
    warrant_uuid: uuid,
    repository: 'openwarrant',
    local_alias: alias,
    title: `Warrant ${alias}`,
    profile: 'delivery',
    assurance_level: 'controlled',
  });
  expect(result.status).toBe('applied');
  expect(result.objectIds).toEqual([uuid]);
  return uuid;
}

const proposal = (n: number) => ({
  contract_digest: sha(`contract-${n}`),
  compilation_basis: sha(`basis-${n}`),
  canonical_ir: { schema: 'oh.war/ir/v1', intent: { problem: `problem ${n}` } },
});

describe('SAS §67 through typed actions', () => {
  it('registers a Warrant: draft, proposal snapshot, authorized revision, server time', async () => {
    const id = await draft('OW-WAR-9001');
    expect((await phaseAndVersion(id)).phase).toBe('draft');

    const submitted = await act('submit_warrant', [id], proposal(1));
    expect(submitted.status).toBe('applied');
    expect((await phaseAndVersion(id)).phase).toBe('proposed');

    const authorized = await act('authorize_warrant_contract', [id], {
      contract_digest: sha('contract-1'),
      authorization_meaning: 'the contract as proposed is authorized for execution',
      policy_basis: 'SAS §28.4; delivery profile, controlled assurance',
    });
    expect(authorized.status).toBe('applied');
    expect((await phaseAndVersion(id)).phase).toBe('authorized');

    const revisions = await withTransaction(harness.adminPool, (tx) =>
      tx.query<Record<string, unknown>>(
        `select revision_no, kind, contract_digest, compilation_basis, predecessor_no,
                authorizer, acting_role, authorization_meaning, effective_at, recorded_at
           from work.warrant_contract_revision where warrant_id = $1 order by revision_no`,
        [id],
      ),
    );
    expect(revisions.map((r) => [r['revision_no'], r['kind'], r['predecessor_no']])).toEqual([
      [1, 'proposed', null],
      [2, 'authorized', 1],
    ]);
    expect(revisions[1]!['contract_digest']).toBe(sha('contract-1'));
    expect(revisions[1]!['compilation_basis']).toBe(sha('basis-1'));
    expect(revisions[1]!['authorizer']).toBe(fixtures.reviewerId);
    expect(revisions[1]!['acting_role']).toBe(fixtures.reviewerRoleId);
    expect(revisions[1]!['recorded_at']).toBeInstanceOf(Date);

    const row = await warrantRow(id);
    expect(row['authorized_revision_no']).toBe(2);
    expect(row['current_revision_no']).toBe(2);
    expect(row['execution_condition']).toBe('clear');
    expect(row['outcome']).toBe('none');

    // §67.2: recorded_at is the server's. A client cannot smuggle one in through the payload
    // because nothing reads it; the action row carries the server clock.
    const action = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{ recorded_at: Date }>('select recorded_at from core.action where id = $1', [
        authorized.actionId,
      ]),
    );
    expect(action.recorded_at).toBeInstanceOf(Date);
  });

  it('the OpenWarrant UUID is the identity: a second draft under it is refused', async () => {
    const id = await draft('OW-WAR-9002');
    await expect(
      act('create_warrant_draft', [], {
        warrant_uuid: id,
        repository: 'openwarrant',
        title: 'the same identity again',
        profile: 'delivery',
        assurance_level: 'basic',
      }),
    ).rejects.toMatchObject({ name: 'ActionRejected', failure: 'precondition_failed' });
    await expect(
      act('create_warrant_draft', [], {
        warrant_uuid: randomUUID(),
        repository: 'openwarrant',
        title: 'not a v7',
        profile: 'delivery',
        assurance_level: 'basic',
      }),
    ).rejects.toMatchObject({ name: 'ActionRejected', failure: 'precondition_failed' });
  });

  it('§67.3 version drift fails rather than overwrites', async () => {
    const id = await draft('OW-WAR-9003');
    const { version } = await phaseAndVersion(id);
    await act('revise_warrant_draft', [id], { title: 'moved on' });
    await expect(
      act('submit_warrant', [id], proposal(3), { expectedVersion: version }),
    ).rejects.toMatchObject({ name: 'ActionRejected' });
    expect((await phaseAndVersion(id)).phase).toBe('draft');
  });

  it('§67.4 an identical retry replays; the same key with another payload is refused', async () => {
    const id = await draft('OW-WAR-9004');
    const key = `submit-${randomUUID()}`;
    const first = await act('submit_warrant', [id], proposal(4), { idempotencyKey: key });
    const again = await act('submit_warrant', [id], proposal(4), { idempotencyKey: key });
    expect(again.replayed).toBe(true);
    expect(again.actionId).toBe(first.actionId);
    await expect(
      act('submit_warrant', [id], proposal(5), { idempotencyKey: key }),
    ).rejects.toMatchObject({ name: 'ActionRejected' });
    const count = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{ count: string }>(
        'select count(*)::text as count from work.warrant_contract_revision where warrant_id = $1',
        [id],
      ),
    );
    expect(count.count).toBe('1');
  });

  it('authorizes only the proposed digest, and a revision is immutable', async () => {
    const id = await draft('OW-WAR-9005');
    await act('submit_warrant', [id], proposal(6));
    await expect(
      act('authorize_warrant_contract', [id], {
        contract_digest: sha('something-else'),
        authorization_meaning: 'x',
        policy_basis: 'y',
      }),
    ).rejects.toMatchObject({ name: 'ActionRejected', failure: 'precondition_failed' });
    expect((await phaseAndVersion(id)).phase).toBe('proposed');
    await expect(
      withTransaction(harness.adminPool, (tx) =>
        tx.query(
          `update work.warrant_contract_revision set contract_digest = $2
            where warrant_id = $1 and revision_no = 1`,
          [id, sha('tampered')],
        ),
      ),
    ).rejects.toThrow(/immutable/);
  });

  it('numbers a Warrant under OH-WAR through the allocator (OW-WAR-0044 M2)', async () => {
    const id = await draft('OW-WAR-9006');
    const allocated = await act('allocate_enterprise_identifier', [id], {});
    const enterpriseId = (allocated.receipt as Record<string, unknown>)['enterprise_id'];
    expect(enterpriseId).toMatch(/^OH-WAR-[0-9]{6}-[0-9]$/);
    const row = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{ enterprise_id: string | null; ok: boolean }>(
        'select enterprise_id, core.valid_enterprise_id(enterprise_id) as ok from core.object where id = $1',
        [id],
      ),
    );
    expect(row.enterprise_id).toBe(enterpriseId);
    expect(row.ok).toBe(true);
    // The identifier is returned by KF, never proposed: a payload naming one is refused.
    const other = await draft('OW-WAR-9016');
    await expect(
      act('allocate_enterprise_identifier', [other], { enterprise_id: 'OH-WAR-000042-7' }),
    ).rejects.toMatchObject({ name: 'ActionRejected', failure: 'precondition_failed' });
  });

  it('withdrawal, amendment, condition, outcome and standing move only their own dimension', async () => {
    const id = await draft('OW-WAR-9007');
    await act('submit_warrant', [id], proposal(7));
    await act('withdraw_warrant_proposal', [id], {});
    expect((await phaseAndVersion(id)).phase).toBe('draft');

    await act('submit_warrant', [id], proposal(8));
    await act('authorize_warrant_contract', [id], {
      contract_digest: sha('contract-8'),
      authorization_meaning: 'authorized',
      policy_basis: 'SAS §28.4',
    });
    await act('record_warrant_preflight', [id], { basis: sha('basis-8') });
    expect((await phaseAndVersion(id)).phase).toBe('ready');

    await act('propose_warrant_amendment', [id], {
      ...proposal(9),
      structured_difference: { changed: ['scope'] },
    });
    expect((await phaseAndVersion(id)).phase).toBe('ready');
    await act('authorize_warrant_amendment', [id], {
      contract_digest: sha('contract-9'),
      authorization_meaning: 'amendment authorized',
      policy_basis: 'SAS §24.8',
    });
    expect((await phaseAndVersion(id)).phase).toBe('authorized');
    expect((await warrantRow(id))['authorized_revision_no']).toBe(5);

    const draftOnly = await draft('OW-WAR-9008');
    await expect(
      act('open_warrant_blocker', [draftOnly], { blocker: 'too early' }),
    ).rejects.toMatchObject({ failure: 'precondition_failed' });
    await act('open_warrant_blocker', [id], { blocker: 'host unreachable' });
    expect((await warrantRow(id))['execution_condition']).toBe('blocked');
    expect((await phaseAndVersion(id)).phase).toBe('authorized');
    await expect(act('pause_warrant', [id], {})).rejects.toMatchObject({
      failure: 'precondition_failed',
    });
    await act('resolve_warrant_blocker', [id], {});
    expect((await warrantRow(id))['execution_condition']).toBe('clear');

    await act('record_warrant_preflight', [id], {});
    await act('authorize_warrant_dispatch', [id], {});
    await act('register_warrant_submission', [id], {});
    expect((await phaseAndVersion(id)).phase).toBe('verifying');
    await act('resolve_warrant', [id], { outcome: 'satisfied' });
    expect((await phaseAndVersion(id)).phase).toBe('resolved');
    await act('dispute_warrant_resolution', [id], { dispute: 'the evidence was stale' });
    const disputed = await warrantRow(id);
    expect(disputed['outcome']).toBe('satisfied');
    expect(disputed['standing']).toBe('disputed');
    await act('annul_warrant_resolution', [id], { annulment_basis: 'dispute upheld' });
    const annulled = await warrantRow(id);
    expect(annulled['outcome']).toBe('satisfied');
    expect(annulled['standing']).toBe('annulled');
    expect((await phaseAndVersion(id)).phase).toBe('resolved');
  });
});
