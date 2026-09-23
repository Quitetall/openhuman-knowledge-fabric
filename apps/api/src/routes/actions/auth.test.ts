import { describe, expect, it } from 'vitest';
import type { Pool } from '@kf/database';
import { CallerRejected, createCallerIdentifier } from './auth.js';

// Never touched on the header path; a verifier-less identifier must not reach the database.
const NO_POOL = {} as Pool;

const HEADERS = {
  'x-kf-actor': '01930000-0000-7000-8000-000000000001',
  'x-kf-acting-role': '01930000-0000-7000-8000-000000000002',
  'x-kf-organization': '01930000-0000-7000-8000-000000000003',
  'x-kf-classification': 'restricted',
};

describe('createCallerIdentifier', () => {
  it('refuses header identity when nothing said headers may be trusted', async () => {
    // The shape that used to fall back to headers: no verifier. It is handed to every
    // document, ML, search and identifier route, so the fallback was a header-trusting API
    // everywhere except /actions.
    const identify = createCallerIdentifier(NO_POOL, undefined, { trustHeaders: false });
    await expect(identify({ headers: HEADERS })).rejects.toBeInstanceOf(CallerRejected);
  });

  it('uses header identity only under explicit header trust', async () => {
    const identify = createCallerIdentifier(NO_POOL, undefined, { trustHeaders: true });
    await expect(identify({ headers: HEADERS })).resolves.toMatchObject({
      actorId: HEADERS['x-kf-actor'],
      maxClassification: 'restricted',
    });
  });
});
