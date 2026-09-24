import { describe, expect, it } from 'vitest';
import { parseRevokeIdentityArgs, planRevokeIdentity } from './revoke-identity.js';

/** Every refusal before a database is touched, each naming what is missing and why it matters. */

const PERSON = '019ff405-2ecb-7e77-96cb-00990ac6f24c';
const LINK = '019ff405-2eca-7e77-96cb-00990ac6f24b';
const ISSUER = 'http://localhost:8080/realms/knowledge-fabric';

function refusals(request: Parameters<typeof planRevokeIdentity>[0]): string {
  const plan = planRevokeIdentity(request);
  return plan.ok ? '' : plan.refusals.join('\n');
}

describe('planRevokeIdentity', () => {
  it('accepts a link named by id, and one named by issuer and subject', () => {
    const byId = planRevokeIdentity({ identityId: LINK, revokedBy: PERSON, reason: 'left' });
    expect(byId.ok && byId.decision.target).toEqual({ identityId: LINK });
    const byAccount = planRevokeIdentity({
      issuer: ISSUER,
      subject: 'abc',
      revokedBy: PERSON,
      reason: 'left',
    });
    expect(byAccount.ok && byAccount.decision.target).toEqual({ issuer: ISSUER, subject: 'abc' });
  });

  it('requires a reason, and a blank one is no reason', () => {
    expect(refusals({ identityId: LINK, revokedBy: PERSON })).toMatch(/no --reason given/);
    expect(refusals({ identityId: LINK, revokedBy: PERSON, reason: '  ' })).toMatch(/no --reason/);
  });

  it('requires who decided it', () => {
    expect(refusals({ identityId: LINK, reason: 'left' })).toMatch(/not auditable/);
    expect(refusals({ identityId: LINK, revokedBy: 'ops', reason: 'left' })).toMatch(/uuid/);
  });

  it('refuses no link, both forms at once, and half an account', () => {
    expect(refusals({ revokedBy: PERSON, reason: 'x' })).toMatch(/no link named/);
    expect(
      refusals({ identityId: LINK, issuer: ISSUER, subject: 's', revokedBy: PERSON, reason: 'x' }),
    ).toMatch(/not both/);
    expect(refusals({ issuer: ISSUER, revokedBy: PERSON, reason: 'x' })).toMatch(
      /unique only within its issuer/,
    );
    expect(refusals({ identityId: 'nope', revokedBy: PERSON, reason: 'x' })).toMatch(
      /--identity must be a uuid/,
    );
  });
});

describe('parseRevokeIdentityArgs', () => {
  it('reads both flag forms and refuses unknown ones', () => {
    expect(
      parseRevokeIdentityArgs(['--identity', LINK, '--revoked-by=' + PERSON, '--reason', 'r']),
    ).toEqual({ identityId: LINK, revokedBy: PERSON, reason: 'r' });
    expect(() => parseRevokeIdentityArgs(['--person', PERSON])).toThrow(/unknown flag --person/);
    expect(() => parseRevokeIdentityArgs(['--reason'])).toThrow(/needs a value/);
  });
});
