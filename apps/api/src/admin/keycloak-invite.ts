/**
 * The invited person's account at the identity provider, created by the owner (ADR 0040
 * decision 12; KF-SAS-RQ-236).
 *
 * An invitation is a Keycloak account with nothing on it but the person's name and email, the
 * required actions "set a password" and "verify your email", and Keycloak's own action link,
 * which it emails to the person and which returns them to the Fabric's `/join/<token>` once they
 * have signed in. The account is created here, by the owner, BEFORE the identity link: the link
 * names the account's subject, and the person, the link and the role assignment are all the
 * owner's acts (RQ-236). The Fabric never sees a password.
 *
 * The admin credential is read the way every secret is (`@kf/operations` `loadSecret`): from
 * `KEYCLOAK_ADMIN_PASSWORD_FILE`, an owner-only file, and inline only in development and test.
 * It is sent as a request body, never as an argument or a URL.
 */

export interface KeycloakAdmin {
  readonly baseUrl: string;
  readonly realm: string;
  readonly username: string;
  readonly password: string;
}

export interface Invitee {
  readonly username: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
}

export interface KeycloakInvitation {
  /** The account's subject claim: what the identity link names. */
  readonly subject: string;
  /** False when the account already existed and was reused (a re-run). */
  readonly created: boolean;
  /** Whether Keycloak accepted the action email; false when it has no mail server configured. */
  readonly actionsEmailSent: boolean;
  readonly actionsEmailStatus: number;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function base(admin: KeycloakAdmin): string {
  return admin.baseUrl.replace(/\/+$/, '');
}

async function adminToken(admin: KeycloakAdmin, fetchImpl: Fetch): Promise<string> {
  const response = await fetchImpl(`${base(admin)}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: admin.username,
      password: admin.password,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Keycloak refused the admin credential (HTTP ${String(response.status)})`);
  }
  const body = (await response.json()) as { access_token?: unknown };
  if (typeof body.access_token !== 'string') throw new Error('Keycloak returned no admin token');
  return body.access_token;
}

/**
 * Create (or find) the invitee's account and ask Keycloak to email its own action link, which
 * returns the person to `redirectUri` (the Fabric's `/join/<token>`) once done.
 */
export async function inviteAtKeycloak(
  admin: KeycloakAdmin,
  invitee: Invitee,
  redirect: {
    readonly clientId: string;
    readonly redirectUri: string;
    readonly lifespanSeconds: number;
  },
  fetchImpl: Fetch = globalThis.fetch,
): Promise<KeycloakInvitation> {
  const token = await adminToken(admin, fetchImpl);
  const auth = { authorization: `Bearer ${token}` };
  const users = `${base(admin)}/admin/realms/${encodeURIComponent(admin.realm)}/users`;
  const created = await fetchImpl(users, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      username: invitee.username,
      email: invitee.email,
      firstName: invitee.firstName,
      lastName: invitee.lastName,
      enabled: true,
      emailVerified: false,
      requiredActions: ['UPDATE_PASSWORD', 'VERIFY_EMAIL'],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (created.status !== 201 && created.status !== 409) {
    throw new Error(
      `Keycloak refused to create ${invitee.username} (HTTP ${String(created.status)})`,
    );
  }
  const found = await fetchImpl(
    `${users}?exact=true&username=${encodeURIComponent(invitee.username)}`,
    { headers: auth, signal: AbortSignal.timeout(10_000) },
  );
  const list = (await found.json()) as { id?: unknown; username?: unknown }[];
  const account = Array.isArray(list)
    ? list.find((user) => user.username === invitee.username)
    : undefined;
  if (account === undefined || typeof account.id !== 'string') {
    throw new Error(`Keycloak has no account ${invitee.username} after creating it`);
  }
  const query = new URLSearchParams({
    client_id: redirect.clientId,
    redirect_uri: redirect.redirectUri,
    lifespan: String(redirect.lifespanSeconds),
  });
  const email = await fetchImpl(
    `${users}/${encodeURIComponent(account.id)}/execute-actions-email?${query.toString()}`,
    {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(['UPDATE_PASSWORD', 'VERIFY_EMAIL']),
      signal: AbortSignal.timeout(10_000),
    },
  );
  return {
    subject: account.id,
    created: created.status === 201,
    actionsEmailSent: email.status === 204 || email.status === 200,
    actionsEmailStatus: email.status,
  };
}
