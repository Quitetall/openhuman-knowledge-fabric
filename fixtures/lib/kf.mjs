/* global fetch, setTimeout */
// The two doors the fixture loader uses, and only these two.
//
//   owner   The bootstrap tier: `kf bootstrap-organization` and `kf grant-authority`, run as the
//           real CLI on the owner connection, plus read-only lookups the way
//           fixtures/munder-diffin/setup.sh does them (bound to the organization first, because
//           core.object forces row-level security even for the owner).
//   api     Everything else: each act is a request to the running API as the person who performs
//           it, with that person's own bearer token. No database credential is involved.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { createPool, withTransaction } from '@kf/database';
import { login } from './keycloak.mjs';

export function ownerSession(repo, ownerUrl) {
  const pool = createPool({ connectionString: ownerUrl, maxConnections: 2 });
  const cli = path.join(repo, 'apps', 'api', 'dist', 'cli.js');
  const kf = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], {
        env: { ...process.env, NODE_ENV: 'development', DATABASE_OWNER_URL: ownerUrl },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out = [];
      const err = [];
      child.stdout.on('data', (d) => out.push(d));
      child.stderr.on('data', (d) => err.push(d));
      child.on('error', reject);
      child.on('close', (code) => {
        const stdout = Buffer.concat(out).toString('utf8');
        const stderr = Buffer.concat(err).toString('utf8');
        if (code === 0) resolve(stdout);
        else reject(new Error(`kf ${args[0]} exited ${code}: ${stderr.trim() || stdout.trim()}`));
      });
    });
  const scoped = (organizationId, sql, params = []) =>
    withTransaction(pool, async (tx) => {
      await tx.query(`select core.set_access_context($1::uuid, 'restricted')`, [organizationId]);
      return tx.query(sql, params);
    });
  return {
    kf,
    scoped,
    query: (sql, params = []) => withTransaction(pool, (tx) => tx.query(sql, params)),
    end: () => pool.end(),
  };
}

export class ApiError extends Error {
  constructor(status, body, what) {
    super(`${what}: HTTP ${status} ${JSON.stringify(body).slice(0, 600)}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * One person's session against the API. The token is renewed by signing in again a minute before
 * it expires (the realm issues five-minute tokens and single-use refresh tokens).
 */
export class PersonaSession {
  #token;
  #signingIn;
  constructor({ oidc, apiOrigin, person, password, organizationId, assignmentId }) {
    this.oidc = oidc;
    this.apiOrigin = apiOrigin;
    this.person = person;
    this.password = password;
    this.organizationId = organizationId;
    this.assignmentId = assignmentId;
  }

  async token() {
    if (this.#token !== undefined && this.#token.expiresAt - Date.now() > 60_000) {
      return this.#token.accessToken;
    }
    this.#signingIn ??= login(this.oidc, this.person.username, this.password).finally(() => {
      this.#signingIn = undefined;
    });
    this.#token = await this.#signingIn;
    return this.#token.accessToken;
  }

  async request(method, route, body, { classification, attempts = 4 } = {}) {
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(`${this.apiOrigin}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${await this.token()}`,
          'x-kf-organization': this.organizationId,
          'x-kf-acting-role': this.assignmentId,
          'x-kf-classification': classification ?? this.person.clearance,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let parsed;
      try {
        parsed = text === '' ? {} : JSON.parse(text);
      } catch {
        parsed = { raw: text.slice(0, 300) };
      }
      // An expired token or an attestor blip is retried; a refusal is not.
      const transient =
        response.status === 503 ||
        response.status === 502 ||
        (response.status === 401 && parsed?.error === 'invalid_token');
      if (transient && attempt < attempts) {
        if (response.status === 401) this.#token = undefined;
        await new Promise((r) => setTimeout(r, 250 * attempt));
        continue;
      }
      if (response.status >= 400) throw new ApiError(response.status, parsed, `${method} ${route}`);
      return { status: response.status, body: parsed };
    }
  }

  act(actionType, request) {
    return this.request('POST', `/actions/${actionType}`, request);
  }
}

/** Run `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
