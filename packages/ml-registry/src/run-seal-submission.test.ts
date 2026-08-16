import { describe, expect, it, vi } from 'vitest';

import { submitExternallySignedRunSeal, type RunSealSubmissionDatabase } from './index.js';

const SIGNATURE = Buffer.alloc(64, 7).toString('base64');

describe('offline run-seal submission adapter', () => {
  it('passes only the externally signed claim to the privileged verifier', async () => {
    // The recorder declares the two parameters it is asserted on below. A `vi.fn(async () =>
    // …)` with no declared parameters still records what arrives, but it describes a
    // function that takes nothing — so the SQL and bound values asserted further down were
    // being matched against a call signature that says they do not exist.
    const one = vi.fn(async (_sql: string, _values: readonly unknown[]) => ({
      id: '33333333-3333-7333-8333-333333333333',
      seal_sha256: 'a'.repeat(64),
      signing_key_registry_id: '44444444-4444-7444-8444-444444444444',
    }));
    // `RunSealSubmissionDatabase.one` is generic in the row type — the caller chooses it,
    // exactly as with `@kf/database`'s `Tx`. A fixture row can only be written concretely,
    // so the narrowing is confined to this one adapter instead of casting the whole seam.
    const database: RunSealSubmissionDatabase = {
      one: async <T,>(sql: string, values: readonly unknown[]): Promise<T> =>
        (await one(sql, values)) as T,
    };

    const result = await submitExternallySignedRunSeal(database, {
      organizationId: '11111111-1111-7111-8111-111111111111',
      runLineageId: '22222222-2222-7222-8222-222222222222',
      workloadIdentityRef: 'spiffe:kf.internal:blut:sealer',
      sealedAt: '2026-08-15T08:30:00.000Z',
      signingKeyId: 'blut-run-seal-2026-08',
      sealDigest: 'a'.repeat(64),
      signature: SIGNATURE,
    });

    expect(one).toHaveBeenCalledWith(
      expect.stringMatching(/ml\.append_signed_run_seal/),
      [
        '11111111-1111-7111-8111-111111111111',
        '22222222-2222-7222-8222-222222222222',
        'spiffe:kf.internal:blut:sealer',
        '2026-08-15T08:30:00.000Z',
        'blut-run-seal-2026-08',
        'a'.repeat(64),
        SIGNATURE,
      ],
    );
    expect(result).toEqual({
      id: '33333333-3333-7333-8333-333333333333',
      sealDigest: 'a'.repeat(64),
      signingKeyRegistryId: '44444444-4444-7444-8444-444444444444',
    });
  });

  it('rejects malformed or expanded claims before reaching the database', async () => {
    const one = vi.fn();
    await expect(
      submitExternallySignedRunSeal(
        { one },
        {
          organizationId: '11111111-1111-7111-8111-111111111111',
          runLineageId: '22222222-2222-7222-8222-222222222222',
          workloadIdentityRef: 'spiffe:kf.internal:blut:sealer',
          sealedAt: '2026-08-15T08:30:00Z',
          signingKeyId: 'blut-run-seal-2026-08',
          sealDigest: 'a'.repeat(64),
          signature: SIGNATURE,
        },
      ),
    ).rejects.toThrow(/canonical four-digit-year/);
    expect(one).not.toHaveBeenCalled();
  });
});
