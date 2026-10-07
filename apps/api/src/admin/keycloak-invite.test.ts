import { describe, expect, it } from 'vitest';
import { planInvite, parseInviteArgs } from './invite.js';
import { inviteAtKeycloak } from './keycloak-invite.js';

/**
 * The invitee's account at Keycloak, against a fake admin API that records every request: the
 * account is created with "set a password" and "verify your email" required, Keycloak's own action
 * email returns the person to the Fabric's join link, and the admin password travels only as a
 * request body.
 */
function fakeKeycloak(options: { mail: boolean; existing?: boolean }) {
  const calls: { method: string; url: string; body: string }[] = [];
  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const body = typeof init.body === 'string' ? init.body : '';
    calls.push({ method: init.method ?? 'GET', url: input, body });
    const url = new URL(input);
    if (url.pathname.endsWith('/realms/master/protocol/openid-connect/token')) {
      return Response.json({ access_token: 'admin-token' });
    }
    if (url.pathname.endsWith('/users') && init.method === 'POST') {
      return new Response(null, { status: options.existing === true ? 409 : 201 });
    }
    if (url.pathname.endsWith('/users')) {
      return Response.json([{ id: 'kc-subject-1', username: url.searchParams.get('username') }]);
    }
    if (url.pathname.endsWith('/execute-actions-email')) {
      return new Response(null, { status: options.mail ? 204 : 500 });
    }
    return new Response(null, { status: 404 });
  };
  return { calls, fetchImpl };
}

const admin = {
  baseUrl: 'https://identity.kf.example/',
  realm: 'knowledge-fabric',
  username: 'kf-admin',
  password: 'not-a-real-password',
};
const invitee = {
  username: 'lucie.garnier@veracier.example',
  email: 'lucie.garnier@veracier.example',
  firstName: 'Lucie',
  lastName: 'Garnier',
};
const redirect = {
  clientId: 'knowledge-fabric-web',
  redirectUri: 'https://kf.example/join/abc',
  lifespanSeconds: 604_800,
};

describe('the invitee’s account at the identity provider', () => {
  it('is created with the required actions, and Keycloak’s own email returns them to the link', async () => {
    const { calls, fetchImpl } = fakeKeycloak({ mail: true });
    const result = await inviteAtKeycloak(admin, invitee, redirect, fetchImpl);
    expect(result).toEqual({
      subject: 'kc-subject-1',
      created: true,
      actionsEmailSent: true,
      actionsEmailStatus: 204,
    });
    const created = JSON.parse(
      calls.find((c) => c.method === 'POST' && c.url.endsWith('/users'))!.body,
    );
    expect(created).toMatchObject({
      username: invitee.username,
      enabled: true,
      emailVerified: false,
      requiredActions: ['UPDATE_PASSWORD', 'VERIFY_EMAIL'],
    });
    const email = new URL(calls.find((c) => c.url.includes('execute-actions-email'))!.url);
    expect(email.searchParams.get('redirect_uri')).toBe('https://kf.example/join/abc');
    expect(email.searchParams.get('client_id')).toBe('knowledge-fabric-web');
    // The admin password is in a body, never in a URL.
    expect(calls.every((c) => !c.url.includes(admin.password))).toBe(true);
    expect(calls[0]?.body).toContain('not-a-real-password');
  });

  it('reuses an existing account, and says when no email could be sent', async () => {
    const { fetchImpl } = fakeKeycloak({ mail: false, existing: true });
    const result = await inviteAtKeycloak(admin, invitee, redirect, fetchImpl);
    expect(result).toMatchObject({
      created: false,
      actionsEmailSent: false,
      subject: 'kc-subject-1',
    });
  });
});

describe('kf invite, planned', () => {
  const base = [
    '--organization',
    '01900000-0000-7000-8000-000000000001',
    '--name',
    'Lucie Garnier',
    '--email',
    'lucie.garnier@veracier.example',
    '--role',
    'performer',
    '--clearance',
    'internal',
    '--invited-by',
    '01900000-0000-7000-8000-000000000002',
    '--contact',
    '01900000-0000-7000-8000-000000000003',
    '--reason',
    'Joins the AV-3000 methods team',
    '--issuer',
    'https://identity.kf.example/realms/knowledge-fabric',
    '--web',
    'https://kf.example',
  ];

  it('needs an account: --subject or --keycloak, not both and not neither', () => {
    expect(planInvite(parseInviteArgs(base)).ok).toBe(false);
    expect(planInvite(parseInviteArgs([...base, '--keycloak'])).ok).toBe(true);
    expect(planInvite(parseInviteArgs([...base, '--subject', 'abc'])).ok).toBe(true);
    expect(planInvite(parseInviteArgs([...base, '--subject', 'abc', '--keycloak'])).ok).toBe(false);
  });

  it('defaults the assignment to a year, refuses beyond 366 days, and an invitation beyond 30', () => {
    const now = new Date('2026-10-07T00:00:00Z');
    const planned = planInvite(parseInviteArgs([...base, '--subject', 'abc']), now);
    expect(planned.ok && planned.plan.validTo.toISOString()).toBe('2027-10-07T00:00:00.000Z');
    expect(planned.ok && planned.plan.expiresAt.toISOString()).toBe('2026-10-14T00:00:00.000Z');
    const long = planInvite(
      parseInviteArgs([
        ...base,
        '--subject',
        'abc',
        '--valid-to',
        '2028-01-01',
        '--expires-in-days',
        '31',
      ]),
      now,
    );
    expect(long.ok).toBe(false);
  });

  it('refuses a scope without a pack, and names every missing field', () => {
    const planned = planInvite(
      parseInviteArgs(['--scope', '01900000-0000-7000-8000-000000000009', '--keycloak']),
    );
    expect(planned.ok).toBe(false);
    if (!planned.ok) {
      expect(planned.refusals.join('\n')).toMatch(/--scope names the scope of a qualification/);
      expect(planned.refusals.join('\n')).toMatch(/--contact is required/);
    }
  });
});
