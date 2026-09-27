#!/usr/bin/env node
// Mint a persona's bearer token through the realm's own login form (PKCE, as the web app does)
// into a 0600 file. The password is read from the personas file and never printed; the token is
// never printed either. Usage: node mint.mjs <username> <out-file> [--loop <seconds>]
// With --loop the file is re-minted (atomic rename) every <seconds> until the process is killed,
// so a paused LAMU run still holds a live token when it re-reads the file.
import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { login } from '../../../../lib/keycloak.mjs';

const [username, out, flag, seconds] = process.argv.slice(2);
if (!username || !out) throw new Error('usage: mint.mjs <username> <out-file> [--loop <seconds>]');
const personas = process.env.KF_VERACIER_PERSONAS ?? path.join(homedir(), '.config', 'kf', 'veracier-personas.txt');
const password = new Map(
  readFileSync(personas, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t').slice(0, 2)),
).get(username);
if (password === undefined) throw new Error(`no persona ${username}`);
const oidc = {
  issuer: `${process.env.KF_VERACIER_KEYCLOAK ?? 'http://localhost:18080'}/realms/knowledge-fabric`,
  clientId: 'knowledge-fabric-web',
  redirectUri: `http://localhost:${process.env.KF_VERACIER_WEB_PORT ?? '3100'}/auth/callback`,
};
async function mintOnce() {
  const { accessToken, expiresAt } = await login(oidc, username, password);
  const tmp = `${out}.tmp-${process.pid}`;
  writeFileSync(tmp, accessToken + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, out);
  process.stdout.write(`minted ${username} expires ${new Date(expiresAt).toISOString()}\n`);
}
await mintOnce();
if (flag === '--loop') {
  const every = Number(seconds) * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, every));
    await mintOnce();
  }
}
