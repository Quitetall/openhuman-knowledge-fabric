import { describe, expect, it } from 'vitest';
import { SECURE_OBJECT_ACTION_TYPES, SecureObjectRejected } from '@kf/integration';
import { createSecureObjectRuntimeAtoms } from './runtime.js';

describe('secure-object API runtime composition', () => {
  it('leaves erasure recording fail-closed when no external signer is configured', async () => {
    const atoms = createSecureObjectRuntimeAtoms(undefined);
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
        { actionId: 'action', effectiveAt: new Date('2026-08-15T00:00:00.000Z') },
      ),
    ).rejects.toMatchObject<Partial<SecureObjectRejected>>({ failure: 'signing_key_unavailable' });
  });
});
