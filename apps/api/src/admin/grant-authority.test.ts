import { describe, expect, it } from 'vitest';
import { parseGrantAuthorityArgs, planGrantAuthority } from './grant-authority.js';

/**
 * The refusals are the point. This command widens a person's authority, so every value it acts
 * on is stated by an operator or the run stops — and each of those refusals is asserted here,
 * with the specific guidance rather than just "it failed", because a message that only says
 * "--role" cannot tell someone who forgot the flag apart from someone who mistyped it.
 */

const VALID = {
  personId: '019ff405-2eca-7e77-96cb-00990ac6f24b',
  organizationId: '019ff405-2ec7-736e-898a-1f5687a80a48',
  roleId: 'performer',
  classification: 'restricted',
  grantedBy: '019ff405-2ecb-7e77-96cb-00990ac6f24c',
  reason: 'dogfood operator, authorized 2026-08-27',
};

function refusalsFor(overrides: Record<string, unknown>): readonly string[] {
  const plan = planGrantAuthority({ ...VALID, ...overrides });
  return plan.ok ? [] : plan.refusals;
}

describe('planGrantAuthority', () => {
  it('accepts a fully stated grant', () => {
    const plan = planGrantAuthority(VALID);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.grant.classification).toBe('restricted');
  });

  it('refuses a missing person', () => {
    expect(refusalsFor({ personId: undefined }).join('\n')).toContain('--person');
  });

  it('refuses a missing organization, because clearance is organization-scoped', () => {
    expect(refusalsFor({ organizationId: undefined }).join('\n')).toContain('organization-scoped');
  });

  it('refuses a missing grantor, naming auditability rather than just the flag', () => {
    // "who decided this" is the reason the flag exists; a bare "--granted-by required" would
    // read as bureaucracy and invite someone to pass any uuid to get past it.
    expect(refusalsFor({ grantedBy: undefined }).join('\n')).toContain('not auditable');
  });

  it('refuses a missing role', () => {
    expect(refusalsFor({ roleId: undefined }).join('\n')).toContain(
      'holding a role is not the same as acting under one',
    );
  });

  it('refuses a missing clearance, and says what a wrong guess costs', () => {
    expect(refusalsFor({ classification: undefined }).join('\n')).toContain('over-discloses');
  });

  it('refuses a missing reason', () => {
    expect(refusalsFor({ reason: undefined }).join('\n')).toContain('why this authority');
  });

  it('refuses a blank reason, not only an absent one', () => {
    // org.person_clearance.reason has a non-blank CHECK, so '   ' would reach the database and
    // fail there instead of here.
    expect(refusalsFor({ reason: '   ' }).join('\n')).toContain('why this authority');
  });

  it('refuses a non-uuid person rather than passing it to the database', () => {
    expect(refusalsFor({ personId: 'dogfood' }).join('\n')).toContain('must be a uuid');
  });

  it('refuses an issuer without a subject', () => {
    expect(
      refusalsFor({ issuer: 'http://localhost:8080/realms/knowledge-fabric' }).join('\n'),
    ).toContain('unique only within its issuer');
  });

  it('refuses a subject without an issuer', () => {
    expect(refusalsFor({ subject: '0a05cfb4-1b29-4112-90e7-dbf839a931a7' }).join('\n')).toContain(
      'unique only within its issuer',
    );
  });

  it('accepts issuer and subject together, and carries them into the grant', () => {
    const plan = planGrantAuthority({
      ...VALID,
      issuer: 'http://localhost:8080/realms/knowledge-fabric',
      subject: '0a05cfb4-1b29-4112-90e7-dbf839a931a7',
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.grant.identity?.subject).toBe('0a05cfb4-1b29-4112-90e7-dbf839a931a7');
  });

  it('omits identity entirely when neither is given, rather than carrying empty strings', () => {
    const plan = planGrantAuthority(VALID);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.grant.identity).toBeUndefined();
  });

  it('reports every missing field in one run', () => {
    // One refusal per attempt turns a five-flag command into five failed runs.
    const refusals = refusalsFor({
      personId: undefined,
      roleId: undefined,
      classification: undefined,
      reason: undefined,
    });
    expect(refusals.length).toBeGreaterThanOrEqual(4);
  });
});

describe('parseGrantAuthorityArgs', () => {
  it('accepts --flag value', () => {
    expect(parseGrantAuthorityArgs(['--role', 'performer']).roleId).toBe('performer');
  });

  it('accepts --flag=value', () => {
    expect(parseGrantAuthorityArgs(['--role=performer']).roleId).toBe('performer');
  });

  it('keeps a reason containing spaces intact', () => {
    expect(parseGrantAuthorityArgs(['--reason', 'authorized by B. Lam']).reason).toBe(
      'authorized by B. Lam',
    );
  });

  it('refuses an unknown flag instead of ignoring it', () => {
    // Silently dropping --clearence would grant with no clearance stated and the operator would
    // believe they had set one.
    expect(() => parseGrantAuthorityArgs(['--clearence', 'restricted'])).toThrow('unknown flag');
  });

  it('refuses a flag with no value', () => {
    expect(() => parseGrantAuthorityArgs(['--role'])).toThrow('needs a value');
  });

  it('refuses a flag followed by another flag, rather than consuming it as the value', () => {
    expect(() => parseGrantAuthorityArgs(['--role', '--clearance', 'restricted'])).toThrow(
      'needs a value',
    );
  });
});
