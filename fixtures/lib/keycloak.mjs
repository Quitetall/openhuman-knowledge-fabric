/* global fetch, URLSearchParams */
// Keycloak, as the fixture uses it: the admin API to create the personas' accounts, and the
// realm's own login form to sign each of them in.
//
// Signing in goes through the authorization-code flow with PKCE (S256), the same flow the
// browser performs and scripts/deploy/login-token.sh walks: no direct-access grant, no
// impersonation. The token a persona holds is the token they would hold after logging in
// themselves. Passwords come from the caller and are never logged or put on a command line.

import { createHash, randomBytes } from 'node:crypto';

const b64url = (buf) => buf.toString('base64url');

export async function adminToken(origin, password) {
  const response = await fetch(`${origin}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: 'admin-cli',
      grant_type: 'password',
      username: 'admin',
      password,
    }),
  });
  if (!response.ok) throw new Error(`keycloak admin login: HTTP ${response.status}`);
  return (await response.json()).access_token;
}

/** Only a loopback Keycloak: the fixture's accounts skip the realm's second factor. */
export function assertLoopback(origin) {
  const url = new URL(origin);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username !== '') {
    throw new Error(`refusing to create fixture accounts on a non-loopback Keycloak: ${origin}`);
  }
}

/**
 * Create the account when absent and return its subject. The password is set only when the
 * account is created, so a re-run never changes a password somebody may be using.
 *
 * The realm makes every new account enrol TOTP (`CONFIGURE_TOTP` is a default required action;
 * identity-and-login.md, "Realm hardening"). A fixture persona is a demonstration account on a
 * loopback Keycloak, so — exactly as scripts/deploy/create-dev-user.sh does for the development
 * account, and under the same loopback guard — its required actions are cleared after creation.
 * The realm's policy is unchanged; only these accounts are exempted, and only here.
 */
export async function ensureUser(origin, realm, token, person, password) {
  assertLoopback(origin);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const [first, ...rest] = person.name.split(' ');
  const profile = {
    username: person.username,
    enabled: true,
    email: person.email,
    emailVerified: true,
    firstName: first,
    lastName: rest.join(' ') || '-',
    requiredActions: [],
  };
  const created = await fetch(`${origin}/admin/realms/${realm}/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify(profile),
  });
  if (created.status !== 201 && created.status !== 409) {
    throw new Error(`creating ${person.username}: HTTP ${created.status}`);
  }
  const found = await fetch(
    `${origin}/admin/realms/${realm}/users?exact=true&username=${encodeURIComponent(person.username)}`,
    { headers },
  );
  const users = await found.json();
  if (!Array.isArray(users) || users.length !== 1) {
    throw new Error(`expected one account named ${person.username}`);
  }
  const subject = users[0].id;
  const updated = await fetch(`${origin}/admin/realms/${realm}/users/${subject}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(profile),
  });
  if (updated.status !== 204)
    throw new Error(`updating ${person.username}: HTTP ${updated.status}`);
  if (created.status === 201) {
    const reset = await fetch(`${origin}/admin/realms/${realm}/users/${subject}/reset-password`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ type: 'password', value: password, temporary: false }),
    });
    if (reset.status !== 204)
      throw new Error(`setting ${person.username}'s password: ${reset.status}`);
  }
  return { subject, created: created.status === 201 };
}

class CookieJar {
  #cookies = new Map();
  store(response) {
    for (const header of response.headers.getSetCookie?.() ?? []) {
      const [pair] = header.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.#cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header() {
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

function formAction(html) {
  const match =
    /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(html) ??
    /<form[^>]*action="([^"]+)"[^>]*id="kc-form-login"/.exec(html);
  if (match === null) throw new Error('the login page carried no login form');
  return match[1].replace(/&amp;/g, '&');
}

/**
 * Sign `username` in through the realm's login form and return `{ accessToken, expiresAt }`.
 * `redirectUri` must be one the public client registers; nothing listens there, the code is read
 * from the redirect Keycloak answers with.
 */
export async function login({ issuer, clientId, redirectUri }, username, password) {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  const jar = new CookieJar();
  const auth = new URL(`${issuer}/protocol/openid-connect/auth`);
  auth.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: 'openid',
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  const page = await fetch(auth, { redirect: 'manual' });
  jar.store(page);
  if (page.status !== 200) throw new Error(`login page for ${username}: HTTP ${page.status}`);
  const action = formAction(await page.text());
  const posted = await fetch(action, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() },
    body: new URLSearchParams({ username, password, credentialId: '' }),
  });
  const location = posted.headers.get('location');
  if (posted.status !== 302 || location === null || !location.startsWith(redirectUri)) {
    throw new Error(`sign-in for ${username} was refused (HTTP ${posted.status})`);
  }
  const back = new URL(location);
  if (back.searchParams.get('state') !== state) throw new Error('login state mismatch');
  const code = back.searchParams.get('code');
  if (code === null) throw new Error(`no authorization code for ${username}`);
  const exchanged = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!exchanged.ok) throw new Error(`token exchange for ${username}: HTTP ${exchanged.status}`);
  const body = await exchanged.json();
  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + Number(body.expires_in) * 1000,
  };
}
