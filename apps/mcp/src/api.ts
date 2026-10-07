/**
 * The Fabric API, as the person's agent reaches it: every call carries the person's delegated
 * token, and nothing else.
 *
 * WHY HTTP AND NOT THE SERVICE LAYER. The MCP server could import the API's routes and dispatcher
 * and run them in-process. It does not, because then it would need a database login, and a
 * process holding one is a second place a person can be bound — the separation ADR 0033 made
 * between the API and kf-attestor exists to keep that to one. Over HTTP the MCP server holds no
 * credential of its own and no authority (KF-SAS-RQ-150): the API identifies the caller through
 * kf-attestor exactly as it identifies the web application's, the database binds the person on
 * the attestation and seals the agent from it (ADR 0035), and every refusal is the API's. There is
 * one enforcement path, and this is a client of it.
 */

import type { McpConfig } from './config.js';
import { TokenUnavailable } from './token.js';

export interface ApiAnswer {
  readonly status: number;
  readonly body: unknown;
}

export class FabricApi {
  constructor(
    private readonly config: Pick<
      McpConfig,
      'apiUrl' | 'tokens' | 'organizationId' | 'actingRoleId' | 'classification'
    >,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get organizationId(): string {
    return this.config.organizationId;
  }

  async call(
    method: 'GET' | 'POST',
    path: string,
    options: { readonly query?: Record<string, string>; readonly body?: unknown } = {},
  ): Promise<ApiAnswer> {
    let token: string;
    try {
      token = await this.config.tokens.token();
    } catch (error: unknown) {
      if (error instanceof TokenUnavailable) {
        return { status: 401, body: { error: 'no_delegated_token', message: error.message } };
      }
      throw error;
    }
    const url = new URL(path, this.config.apiUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'x-kf-organization': this.config.organizationId,
      'x-kf-classification': this.config.classification,
      accept: 'application/json',
    };
    if (this.config.actingRoleId !== undefined) {
      headers['x-kf-acting-role'] = this.config.actingRoleId;
    }
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        redirect: 'error',
      });
    } catch {
      return {
        status: 503,
        body: {
          error: 'api_unreachable',
          message: `the Fabric API at ${url.origin} did not answer`,
        },
      };
    }
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      // Not JSON: kept as text, and the status says what happened.
    }
    return { status: response.status, body };
  }
}
