import { describe, expect, it } from 'vitest';
import { SECURE_OBJECT_ACTION_TYPES, type SecureObjectRejected } from '@kf/integration';
import { createSecureObjectRuntimeAtoms } from './runtime.js';

describe('secure-object API runtime composition', () => {
  it('leaves erasure recording fail-closed when no external signer is configured', async () => {
    const atoms = createSecureObjectRuntimeAtoms(undefined);
    // Typed as a value: vitest's toMatchObject takes no type argument, and the check that
    // matters is that this failure code still exists on the real rejection type.
    const expected: Partial<SecureObjectRejected> = { failure: 'signing_key_unavailable' };
    const effect = atoms.effects[SECURE_OBJECT_ACTION_TYPES.recordErasure];

    await expect(
      effect(
        {} as never,
        {
          actionType: SECURE_OBJECT_ACTION_TYPES.recordErasure,
          actorId: 'actor',
          actingRoleId: 'role',
          organizationId: 'organization',
          maxClassification: 'restricted',
          targetIds: ['organization'],
          idempotencyKey: 'receipt-1',
          payload: {},
        },
        // ActionEffect is (tx, request, objects, ctx). The objects array was missing, and the
        // call still passed because recordErasure refuses before ever reading it — a test
        // that proves a refusal can be arity-wrong and never notice.
        [],
        { actionId: 'action', effectiveAt: new Date('2026-08-15T00:00:00.000Z') },
      ),
    ).rejects.toMatchObject(expected);
  });
});
