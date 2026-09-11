import { describe, expect, it } from 'vitest';
import { parseRetireOrganizationArgs, planRetireOrganization } from './retire-organization.js';

/**
 * The refusals are the point: this command is terminal for an organization, so every value is
 * stated or the run stops, and each refusal says what a later reader needs rather than which
 * flag was missing.
 */

const VALID = {
  organizationId: '019ff405-2ec7-736e-898a-1f5687a80a48',
  reason: 'duplicate created by the bootstrap name-lookup defect on 2026-09-10',
  decidedBy: '019ff405-2ecb-7e77-96cb-00990ac6f24c',
};

function refusalsFor(overrides: Record<string, unknown>): readonly string[] {
  const plan = planRetireOrganization({ ...VALID, ...overrides });
  return plan.ok ? [] : plan.refusals;
}

describe('planRetireOrganization', () => {
  it('accepts a fully stated retirement, without people or successor by default', () => {
    const plan = planRetireOrganization(VALID);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.decision.withPeople).toBe(false);
      expect(plan.decision.successorId).toBeUndefined();
    }
  });

  it('refuses a reason shorter than a sentence, naming why', () => {
    expect(refusalsFor({ reason: 'cleanup' }).join('\n')).toContain('terminal');
  });

  it('refuses a missing decider, because a retirement nobody made cannot be asked about', () => {
    expect(refusalsFor({ decidedBy: undefined }).join('\n')).toContain('nobody can be asked');
  });

  it('refuses a malformed successor', () => {
    expect(refusalsFor({ successorId: 'the-other-company' }).join('\n')).toContain('--successor');
  });

  it('reports every refusal at once', () => {
    expect(refusalsFor({ organizationId: 'x', reason: '', decidedBy: '' })).toHaveLength(3);
  });
});

describe('parseRetireOrganizationArgs', () => {
  it('reads --flag value, --flag=value and the bare --with-people', () => {
    const parsed = parseRetireOrganizationArgs([
      '--organization',
      VALID.organizationId,
      `--reason=${VALID.reason}`,
      '--decided-by',
      VALID.decidedBy,
      '--with-people',
    ]);
    expect(parsed).toEqual({ ...VALID, withPeople: true });
  });

  it('refuses an unknown flag rather than ignoring it', () => {
    expect(() => parseRetireOrganizationArgs(['--force', 'yes'])).toThrow(/unknown option --force/);
  });

  it('refuses a flag whose value is another flag', () => {
    expect(() => parseRetireOrganizationArgs(['--reason', '--with-people'])).toThrow(
      /--reason needs a value/,
    );
  });
});
