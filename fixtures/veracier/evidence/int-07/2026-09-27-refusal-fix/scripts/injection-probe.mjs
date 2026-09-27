#!/usr/bin/env node
// Live injection probe for search.identification_refusal (20260927000100).
//
//   injection-probe.mjs unlinked <organization> <acting-role>
//     A throwaway account is created in the fixture realm (loopback only) with a random password
//     held in memory, linked to no KF person. It signs in through the realm's login form and asks
//     POST /context-source/retrieve naming <organization>. The account is deleted afterwards.
//   injection-probe.mjs other-org <organization> <acting-role> <persona username>
//     A persona signs in and asks naming an organization that is not theirs.
//
// Prints the HTTP status and refusal code only. No password or token is printed or written.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { adminToken, ensureUser, login } from '../../../../lib/keycloak.mjs';

const [mode, organization, role, persona] = process.argv.slice(2);
const kc = process.env.KF_VERACIER_KEYCLOAK ?? 'http://localhost:18080';
const api = process.env.KF_URL ?? 'http://127.0.0.1:4100';
const oidc = {
  issuer: `${kc}/realms/knowledge-fabric`,
  clientId: 'knowledge-fabric-web',
  redirectUri: `http://localhost:${process.env.KF_VERACIER_WEB_PORT ?? '3100'}/auth/callback`,
};
const state = process.env.KF_VERACIER_STATE ?? path.join(homedir(), '.local', 'state', 'kf-veracier');

async function ask(accessToken) {
  const r = await fetch(`${api}/context-source/retrieve`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'x-kf-organization': organization,
      'x-kf-acting-role': role,
      'x-kf-classification': 'internal',
    },
    body: JSON.stringify({ query: 'injection probe', limit: 1 }),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, error: body.error ?? null };
}

if (mode === 'unlinked') {
  const admin = await adminToken(kc, readFileSync(path.join(state, 'keycloak-admin-password'), 'utf8').trim());
  const username = `int07-injection-probe-${Date.now()}`;
  const password = randomBytes(24).toString('base64url');
  const { subject } = await ensureUser(
    kc,
    'knowledge-fabric',
    admin,
    { username, name: 'Injection Probe', email: `${username}@probe.invalid` },
    password,
  );
  try {
    const { accessToken } = await login(oidc, username, password);
    process.stdout.write(`${JSON.stringify({ mode, subject, organization, ...(await ask(accessToken)) })}\n`);
  } finally {
    const del = await fetch(`${kc}/admin/realms/knowledge-fabric/users/${subject}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${admin}` },
    });
    process.stdout.write(`${JSON.stringify({ deleted: subject, status: del.status })}\n`);
  }
} else if (mode === 'other-org') {
  const personas =
    process.env.KF_VERACIER_PERSONAS ?? path.join(homedir(), '.config', 'kf', 'veracier-personas.txt');
  const password = new Map(
    readFileSync(personas, 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split('\t').slice(0, 2)),
  ).get(persona);
  if (password === undefined) throw new Error(`no persona ${persona}`);
  const { accessToken } = await login(oidc, persona, password);
  process.stdout.write(`${JSON.stringify({ mode, persona, organization, ...(await ask(accessToken)) })}\n`);
} else {
  throw new Error('usage: injection-probe.mjs unlinked|other-org <organization> <acting-role> [persona]');
}
