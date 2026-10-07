/**
 * The in-app agent's identity: the signed-in person's token, exchanged for the in-app agent's
 * (ADR 0035), and the Fabric API reached with it.
 *
 * WHY EXCHANGE. Everything the in-app agent writes is the person's act with the agent's
 * participation recorded (ADR 0040 decision 5, KF-SAS-RQ-263), and the database records that
 * participation only from an attestation of a token whose `act.client_id` names a declared agent.
 * So the web application, which holds the person's access token in their session, exchanges it
 * (RFC 8693, Keycloak standard token exchange) for one issued to the in-app agent's client. The
 * exchanged token lives no longer than the person's and is held for one request, never stored.
 *
 * With no agent client configured (a development workspace, or a deployment that declared none),
 * the agent READS as the person — their reads are theirs and recorded as theirs — and refuses to
 * commit a draft, because a write it made there would carry no participation and look like the
 * person had typed it (KF-SAS-RQ-263).
 */

import type { ApiAnswer, FabricClient } from '@kf/agent';
import { readOwnerOnlyFile } from '@kf/agent';
import { apiBaseUrl, callerHeaders, type Caller } from '../api/client';
import { loadWebIdentityConfig } from '../auth';
import { discoverOidc } from '../oidc';
import type { AgentConfig } from './config';

const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token';
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

export class DelegationUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DelegationUnavailable';
  }
}

/** The person's token exchanged for the in-app agent's, or a refusal saying why there is none. */
export async function exchangeForAgent(
  caller: Caller,
  config: AgentConfig,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if (caller.authentication !== 'oidc') {
    throw new DelegationUnavailable(
      'the in-app agent acts on an exchanged token, and this development session has none',
    );
  }
  if (config.delegation === undefined) {
    throw new DelegationUnavailable('no in-app agent client is configured on this deployment');
  }
  const identity = loadWebIdentityConfig();
  if (identity.profile !== 'dogfood') {
    throw new DelegationUnavailable('token exchange needs the dogfood identity profile');
  }
  const metadata = await discoverOidc(identity, fetcher);
  const secret = readOwnerOnlyFile(config.delegation.secretFile, 'in-app agent client secret');
  const basic = Buffer.from(
    `${encodeURIComponent(config.delegation.clientId)}:${encodeURIComponent(secret)}`,
  ).toString('base64');
  let response: Response;
  try {
    response = await fetcher(metadata.tokenEndpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({
        grant_type: TOKEN_EXCHANGE,
        subject_token: caller.bearerToken,
        subject_token_type: ACCESS_TOKEN,
        requested_token_type: ACCESS_TOKEN,
      }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new DelegationUnavailable('the identity provider did not answer the token exchange');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_TOKEN_RESPONSE_BYTES) {
    throw new DelegationUnavailable('the token exchange answered with more than a token');
  }
  if (!response.ok) {
    // The provider's error body can quote the request; the status says enough.
    throw new DelegationUnavailable(
      `the identity provider refused the token exchange (${String(response.status)})`,
    );
  }
  let token: unknown;
  try {
    token = (JSON.parse(text) as { access_token?: unknown }).access_token;
  } catch {
    token = undefined;
  }
  if (typeof token !== 'string' || token === '' || token.length > 12_000) {
    throw new DelegationUnavailable('the token exchange returned no access token');
  }
  return token;
}

/** The Fabric API as the agent reaches it, with `caller`'s context and `bearer`. */
export function fabricClient(caller: Caller, bearer: string | undefined): FabricClient {
  const headers =
    bearer === undefined
      ? callerHeaders(caller)
      : { ...callerHeaders(caller), authorization: `Bearer ${bearer}` };
  return {
    organizationId: caller.organizationId,
    async call(method, path, options = {}): Promise<ApiAnswer> {
      const url = new URL(`${apiBaseUrl()}${path}`);
      for (const [key, value] of Object.entries(options.query ?? {})) {
        url.searchParams.set(key, value);
      }
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          cache: 'no-store',
          redirect: 'error',
        });
      } catch {
        return { status: 503, body: { error: 'api_unreachable' } };
      }
      const text = await response.text();
      let body: unknown = text;
      try {
        body = text === '' ? null : JSON.parse(text);
      } catch {
        // Not JSON: kept as text, and the status says what happened.
      }
      return { status: response.status, body };
    },
  };
}
