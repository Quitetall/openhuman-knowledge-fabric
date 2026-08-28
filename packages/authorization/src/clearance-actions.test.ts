import { describe, expect, it, vi } from 'vitest';
import { grantPersonClearanceEffect, insertPersonClearance } from './clearance-actions.js';

/**
 * The effect writes the row that decides what a person can see, so each thing it refuses to
 * infer is asserted here. No database: every refusal happens before the insert, which is the
 * point — a missing classification must not reach PostgreSQL and come back as a constraint
 * violation the caller has to decode.
 */

const PERSON = {
  id: '019ff405-2eca-7e77-96cb-00990ac6f24b',
  object_type: 'person',
  lifecycle_state: 'active',
  row_version: '1',
  organization_id: '019ff405-2ec7-736e-898a-1f5687a80a48',
  created_by: '019ff405-2ecb-7e77-96cb-00990ac6f24c',
};

const REQUEST = {
  actionType: 'grant_person_clearance',
  actorId: '019ff405-2ecb-7e77-96cb-00990ac6f24c',
  actingRoleId: '019ff405-2ecb-7e77-96cb-00990ac6f24d',
  targetIds: [PERSON.id],
  payload: { max_classification: 'restricted' },
  reason: 'authorized by the quality owner',
  idempotencyKey: 'grant-clearance-fixture',
  organizationId: PERSON.organization_id,
  maxClassification: 'restricted',
};

const CTX = { actionId: '019ff405-2ecc-7e77-96cb-00990ac6f24e', effectiveAt: new Date(0) };

function fakeTx(): { one: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> } {
  return { one: vi.fn().mockResolvedValue({ id: 'clearance-id' }), query: vi.fn() };
}

describe('grantPersonClearanceEffect', () => {
  it('writes the clearance for the targeted person', async () => {
    const tx = fakeTx();
    await grantPersonClearanceEffect(tx as never, REQUEST as never, [PERSON] as never, CTX);
    expect(tx.one).toHaveBeenCalledTimes(1);
    const params = tx.one.mock.calls[0]?.[1] as readonly unknown[];
    // subject, organization, classification, grantor, action, reason — in that order.
    expect(params).toStrictEqual([
      PERSON.id,
      PERSON.organization_id,
      'restricted',
      REQUEST.actorId,
      CTX.actionId,
      REQUEST.reason,
    ]);
  });

  it('records the GRANTOR as granted_by, not the person being cleared', async () => {
    // Self-granting is the failure this ordering prevents; if these two were swapped the record
    // would say the subject authorized their own ceiling.
    const tx = fakeTx();
    await grantPersonClearanceEffect(tx as never, REQUEST as never, [PERSON] as never, CTX);
    const params = tx.one.mock.calls[0]?.[1] as readonly unknown[];
    expect(params[3]).toBe(REQUEST.actorId);
    expect(params[3]).not.toBe(PERSON.id);
  });

  it('refuses when no person is among the targets', async () => {
    const tx = fakeTx();
    const other = { ...PERSON, object_type: 'artifact' };
    await expect(
      grantPersonClearanceEffect(tx as never, REQUEST as never, [other] as never, CTX),
    ).rejects.toThrow('nobody to grant anything to');
    expect(tx.one).not.toHaveBeenCalled();
  });

  it('refuses a missing classification rather than inferring one', async () => {
    const tx = fakeTx();
    await expect(
      grantPersonClearanceEffect(
        tx as never,
        { ...REQUEST, payload: {} } as never,
        [PERSON] as never,
        CTX,
      ),
    ).rejects.toThrow('never inferred');
    expect(tx.one).not.toHaveBeenCalled();
  });

  it('refuses a blank reason before it reaches the CHECK constraint', async () => {
    const tx = fakeTx();
    await expect(
      grantPersonClearanceEffect(
        tx as never,
        { ...REQUEST, reason: '   ' } as never,
        [PERSON] as never,
        CTX,
      ),
    ).rejects.toThrow('not a record');
    expect(tx.one).not.toHaveBeenCalled();
  });
});

describe('insertPersonClearance', () => {
  it('refuses a blank reason, whichever caller asks', async () => {
    // Both the dispatched effect and the bootstrap command go through this function, so the
    // guard lives here rather than in either caller.
    const tx = fakeTx();
    await expect(
      insertPersonClearance(tx as never, {
        personId: PERSON.id,
        organizationId: PERSON.organization_id,
        classification: 'restricted',
        grantedBy: REQUEST.actorId,
        grantedByAction: CTX.actionId,
        reason: '',
      }),
    ).rejects.toThrow('needs a reason');
    expect(tx.one).not.toHaveBeenCalled();
  });
});
