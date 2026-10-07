/**
 * Where the MCP server gets the person's delegated token (ADR 0035), and nowhere else.
 *
 * The token is an access token obtained by OAuth 2.0 token exchange: `sub` the person, `azp` and
 * `act.client_id` the declared agent. It lives at most the realm's access-token lifespan, which
 * commissioning holds to the attestation replay bound (KF-SAS-RQ-241, 300 s). So the server never
 * holds a long-lived credential and never refreshes one itself; it asks again on every call:
 *
 *   - a FILE (`KF_MCP_TOKEN_FILE`), re-read on every call, so whatever keeps it fresh (the
 *     person's token-exchange helper) only has to rewrite it. The file must be the caller's own
 *     and readable by nobody else, or it is refused: a token anyone on the host can read is a
 *     token anyone on the host can act on;
 *   - a COMMAND (`KF_MCP_TOKEN_COMMAND`), run when the last token it printed is within thirty
 *     seconds of expiry, like a git credential helper: it prints a token on stdout and nothing
 *     else, and may hold its own secrets however it likes (`secrets run -- …`).
 *
 * A token is never written to disk by this server, never logged, and never put in an answer.
 */

import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** A JWT's three base64url segments; anything else is not a token this server will present. */
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/** Refresh a commanded token this long before its stated expiry. */
const EARLY_MS = 30_000;

export class TokenUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenUnavailable';
  }
}

export interface TokenSource {
  /** A current bearer token, or a refusal naming why there is none. */
  token(): Promise<string>;
  /** Where it comes from, for the startup line: a path or "command", never a value. */
  readonly describe: string;
}

function checked(raw: string, where: string): string {
  const token = raw.trim();
  if (!JWT.test(token)) {
    throw new TokenUnavailable(`${where} does not hold a bearer token (a JWT)`);
  }
  return token;
}

/** The `exp` a token states, read only to know when to ask again; never trusted for anything. */
export function statedExpiry(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (payload === undefined) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export function fileTokenSource(path: string): TokenSource {
  return {
    describe: `file ${path}`,
    async token() {
      let info;
      try {
        info = await stat(path);
      } catch {
        throw new TokenUnavailable(`the token file ${path} cannot be read`);
      }
      // Owner-only. On a host where another account can read it, that account is this person.
      if ((info.mode & 0o077) !== 0) {
        throw new TokenUnavailable(
          `the token file ${path} is readable by others (mode ${(info.mode & 0o777).toString(8)}); ` +
            'chmod 600 it',
        );
      }
      if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
        throw new TokenUnavailable(`the token file ${path} belongs to another account`);
      }
      return checked(await readFile(path, 'utf8'), `the token file ${path}`);
    },
  };
}

export function commandTokenSource(command: string): TokenSource {
  let cached: { token: string; until: number } | undefined;
  return {
    describe: 'command',
    async token() {
      if (cached !== undefined && Date.now() < cached.until) return cached.token;
      let stdout: string;
      try {
        ({ stdout } = await run('/bin/sh', ['-c', command], {
          timeout: 20_000,
          maxBuffer: 64 * 1024,
          // Never echoed: its output IS the token, and its stderr may name secrets.
          windowsHide: true,
        }));
      } catch {
        cached = undefined;
        throw new TokenUnavailable('the token command failed; run it by hand to see why');
      }
      const token = checked(stdout, 'the token command');
      const expiry = statedExpiry(token);
      cached = { token, until: expiry === undefined ? 0 : expiry - EARLY_MS };
      return token;
    },
  };
}
