/**
 * The MCP server's configuration, from the environment, refused whole when any part is wrong.
 *
 *   KF_API_URL            the Fabric API. Loopback over http, or https anywhere: a delegated token
 *                         never crosses a network in clear. Default http://127.0.0.1:4000.
 *   KF_MCP_TOKEN_FILE     a file holding the person's delegated token (owner-only), re-read on
 *                         every call; or
 *   KF_MCP_TOKEN_COMMAND  a command printing one. Exactly one of the two. Never an inline token:
 *                         there is no variable that takes a token's value.
 *   KF_ORGANIZATION       the organization the person acts in (uuid).
 *   KF_ACTING_ROLE        the assignment they act under (uuid); optional for capture, which derives
 *                         the person's only one, required for everything else the API binds.
 *   KF_CLASSIFICATION     the ceiling asked for (public | internal | confidential | restricted);
 *                         default internal. The database clamps it to the person's clearance and
 *                         refuses one above it (ADR 0033).
 *   KF_MCP_HTTP_PORT      with --http: the loopback port for streamable HTTP (default 4310).
 */

import { commandTokenSource, fileTokenSource, type TokenSource } from './token.js';

export interface McpConfig {
  readonly apiUrl: URL;
  readonly tokens: TokenSource;
  readonly organizationId: string;
  readonly actingRoleId?: string;
  readonly classification: string;
  readonly httpPort: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLASSIFICATIONS = new Set(['public', 'internal', 'confidential', 'restricted']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export class ConfigRefused extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`kf-mcp refuses to start: ${problems.join('; ')}`);
    this.name = 'ConfigRefused';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const problems: string[] = [];

  let apiUrl: URL | undefined;
  try {
    apiUrl = new URL(env['KF_API_URL'] ?? 'http://127.0.0.1:4000');
    if (apiUrl.protocol === 'http:' && !LOOPBACK.has(apiUrl.hostname)) {
      problems.push('KF_API_URL over http must be loopback; use https for anything else');
    } else if (apiUrl.protocol !== 'http:' && apiUrl.protocol !== 'https:') {
      problems.push('KF_API_URL must be http (loopback) or https');
    }
    if (apiUrl.username !== '' || apiUrl.password !== '') {
      problems.push('KF_API_URL must not carry credentials');
    }
  } catch {
    problems.push('KF_API_URL is not a URL');
  }

  // There is deliberately no variable that takes a token's value: an inline token sits in a
  // client's configuration file, its process listing and its shell history.
  if (env['KF_MCP_TOKEN'] !== undefined || env['KF_TOKEN'] !== undefined) {
    problems.push(
      'an inline token is refused; name a file (KF_MCP_TOKEN_FILE) or a command ' +
        '(KF_MCP_TOKEN_COMMAND) that holds it',
    );
  }
  const file = env['KF_MCP_TOKEN_FILE'];
  const command = env['KF_MCP_TOKEN_COMMAND'];
  let tokens: TokenSource | undefined;
  if ((file === undefined) === (command === undefined)) {
    problems.push('set exactly one of KF_MCP_TOKEN_FILE and KF_MCP_TOKEN_COMMAND');
  } else {
    tokens = file !== undefined ? fileTokenSource(file) : commandTokenSource(command!);
  }

  const organizationId = env['KF_ORGANIZATION'] ?? '';
  if (!UUID.test(organizationId)) problems.push('KF_ORGANIZATION must name an organization (uuid)');
  const actingRoleId = env['KF_ACTING_ROLE'];
  if (actingRoleId !== undefined && !UUID.test(actingRoleId)) {
    problems.push('KF_ACTING_ROLE must name an assignment (uuid)');
  }
  const classification = env['KF_CLASSIFICATION'] ?? 'internal';
  if (!CLASSIFICATIONS.has(classification)) {
    problems.push('KF_CLASSIFICATION must be public, internal, confidential or restricted');
  }
  const httpPort = Number(env['KF_MCP_HTTP_PORT'] ?? '4310');
  if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) {
    problems.push('KF_MCP_HTTP_PORT must be a port number');
  }

  if (problems.length > 0 || apiUrl === undefined || tokens === undefined) {
    throw new ConfigRefused(problems);
  }
  return {
    apiUrl,
    tokens,
    organizationId,
    ...(actingRoleId === undefined ? {} : { actingRoleId }),
    classification,
    httpPort,
  };
}
