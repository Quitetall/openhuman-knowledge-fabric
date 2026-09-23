import { describe, expect, it } from 'vitest';
import type { Pool } from '@kf/database';
import { IdentityRejected } from '@kf/authorization';
import { CallerRejected, createCallerIdentifier, unidentified } from './auth.js';

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

describe('unidentified', () => {
  it('does not echo text it did not author', () => {
    // A pool timeout or pg error from the role lookup lands here, and its message is about the
    // server. A 401 body is read by exactly the people it should not be read by.
    const body = unidentified(new Error('password authentication failed for user "kf_owner"'));
    expect(body).toEqual({
      error: 'caller_unidentified',
      message: 'The caller could not be identified.',
    });
  });

  it('keeps the authored reasons a caller needs', () => {
    expect(unidentified(new IdentityRejected('invalid_token', 'token rejected'))).toEqual({
      error: 'invalid_token',
      message: 'token rejected',
    });
    expect(unidentified(new CallerRejected('x-kf-actor is required')).message).toBe(
      'x-kf-actor is required',
    );
  });
});
