/**
 * Step-up authentication.
 *
 * The property under test is that every unknown fails. A provider that does not report
 * `auth_time` cannot prove a session is recent, and the temptation — in code and in review —
 * is to treat "not reported" as "fine", because that makes the feature work everywhere. It
 * would also make the control evaporate for exactly the providers least able to enforce it.
 */

import { describe, expect, it } from 'vitest';
import {
  authenticationEvent,
  satisfiesStepUp,
  DEFAULT_STEP_UP,
  type AuthenticationEvent,
} from '@kf/authorization';

const now = new Date('2026-08-11T12:00:00Z');
const minutesAgo = (m: number): Date => new Date(now.getTime() - m * 60_000);

const event = (over: Partial<AuthenticationEvent> = {}): AuthenticationEvent => ({
  authenticatedAt: minutesAgo(1),
  assuranceLevel: 'urn:mace:incommon:iap:silver',
  methods: ['mfa', 'pwd'],
  ...over,
});

describe('reading the authentication event from a token', () => {
  it('reads auth_time, acr and amr', () => {
    const e = authenticationEvent({
      auth_time: 1_776_000_000,
      acr: 'high',
      amr: ['pwd', 'otp'],
    });
    expect(e.authenticatedAt?.toISOString()).toBe(new Date(1_776_000_000_000).toISOString());
    expect(e.assuranceLevel).toBe('high');
    expect(e.methods).toEqual(['pwd', 'otp']);
  });

  it('does NOT fall back to iat when auth_time is absent', () => {
    // The mistake this guards: `iat` is when the token was minted, and a refresh token mints
    // a fresh one from a session that authenticated days ago. Treating mint time as
    // authentication time would satisfy every freshness requirement forever.
    const e = authenticationEvent({ iat: Math.floor(now.getTime() / 1000), sub: 'someone' });
    expect(e.authenticatedAt).toBeUndefined();
  });

  it('ignores claims of the wrong shape rather than coercing them', () => {
    const e = authenticationEvent({ auth_time: 'recently', acr: 42, amr: 'mfa' });
    expect(e.authenticatedAt).toBeUndefined();
    expect(e.assuranceLevel).toBeUndefined();
    expect(e.methods).toEqual([]);
  });

  it('keeps only the string entries of amr', () => {
    const e = authenticationEvent({ amr: ['mfa', 7, null, 'hwk'] });
    expect(e.methods).toEqual(['mfa', 'hwk']);
  });
});

describe('failing closed on every unknown', () => {
  it('refuses when the age of the authentication is unknown', () => {
    const r = satisfiesStepUp(event({ authenticatedAt: undefined }), { maxAgeSeconds: 900 }, now);
    expect(r.satisfied).toBe(false);
    expect(r.failure).toBe('authentication_age_unknown');
    // The remedy is named, because the caller's client is what has to change.
    expect(r.detail).toMatch(/max_age/);
  });

  it('refuses when the assurance level is unknown', () => {
    const r = satisfiesStepUp(event({ assuranceLevel: undefined }), { assuranceLevels: ['high'] }, now);
    expect(r.satisfied).toBe(false);
    expect(r.failure).toBe('assurance_unknown');
  });

  it('refuses when no method is reported', () => {
    const r = satisfiesStepUp(event({ methods: [] }), { methods: ['mfa'] }, now);
    expect(r.satisfied).toBe(false);
    expect(r.failure).toBe('method_insufficient');
  });

  it('refuses an authentication older than the policy allows', () => {
    const r = satisfiesStepUp(event({ authenticatedAt: minutesAgo(20) }), { maxAgeSeconds: 900 }, now);
    expect(r.satisfied).toBe(false);
    expect(r.failure).toBe('authentication_too_old');
    expect(r.detail).toMatch(/1200s ago/);
  });

  it('refuses a method that is not one of the required ones', () => {
    const r = satisfiesStepUp(event({ methods: ['pwd'] }), { methods: ['mfa', 'otp', 'hwk'] }, now);
    expect(r.satisfied).toBe(false);
    expect(r.failure).toBe('method_insufficient');
    // Says what they did use, so the person reading the log can tell a policy gap from an
    // attack.
    expect(r.detail).toMatch(/authenticated with pwd/);
  });
});

describe('accepting what genuinely satisfies the policy', () => {
  it('accepts a recent, strong authentication', () => {
    expect(
      satisfiesStepUp(event(), { maxAgeSeconds: 900, methods: ['mfa'] }, now).satisfied,
    ).toBe(true);
  });

  it('accepts exactly at the boundary', () => {
    // 900s ago against maxAgeSeconds 900. The comparison is `>`, so the boundary passes —
    // asserted rather than left to chance, because a policy that rejects at exactly its own
    // limit re-prompts a user who did what was asked.
    const r = satisfiesStepUp(event({ authenticatedAt: minutesAgo(15) }), { maxAgeSeconds: 900 }, now);
    expect(r.satisfied).toBe(true);
  });

  it('applies no constraint that was not stated', () => {
    // An empty policy is not a trap door — it is what most actions have, and it must not
    // start refusing people because a field was left off.
    expect(satisfiesStepUp(event({ authenticatedAt: undefined, methods: [] }), {}, now).satisfied)
      .toBe(true);
  });

  it('treats an empty list of methods as no requirement, not an impossible one', () => {
    expect(satisfiesStepUp(event({ methods: [] }), { methods: [] }, now).satisfied).toBe(true);
  });
});

describe('the default policy', () => {
  it('covers actions that move money, release a product, or withdraw a control', () => {
    for (const action of [
      'authorize_payment',
      'record_payment_settlement',
      'approve_invoice',
      'make_document_effective',
      'promote_configuration_item',
      'invalidate_test_execution',
      'close_capa',
      'correct_record',
    ]) {
      expect(DEFAULT_STEP_UP[action], action).toBeDefined();
    }
  });

  it('requires a real second factor on the two that move money directly', () => {
    // Recency alone is not enough where the loss is immediate and irreversible: a borrowed
    // unlocked laptop is recent.
    for (const action of ['authorize_payment', 'record_payment_settlement']) {
      expect(DEFAULT_STEP_UP[action]?.methods).toContain('mfa');
    }
  });

  it('leaves ordinary work alone', () => {
    // A policy that covers everything gets switched off. These are the actions people
    // perform dozens of times a day, and re-prompting on them is how step-up dies.
    for (const action of ['submit_deliverable', 'record_work_execution', 'create_work_order']) {
      expect(DEFAULT_STEP_UP[action], action).toBeUndefined();
    }
  });

  it('is refused outright by an authentication event carrying nothing', () => {
    // The header-identity path produces exactly this. It must satisfy no policy.
    const nothing: AuthenticationEvent = {
      authenticatedAt: undefined,
      assuranceLevel: undefined,
      methods: [],
    };
    for (const [action, policy] of Object.entries(DEFAULT_STEP_UP)) {
      expect(satisfiesStepUp(nothing, policy, now).satisfied, action).toBe(false);
    }
  });
});
