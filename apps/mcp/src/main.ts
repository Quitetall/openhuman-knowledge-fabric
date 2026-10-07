#!/usr/bin/env node
/**
 * kf-mcp: the KF MCP server, for one person's agent.
 *
 *   kf-mcp            stdio — Claude Code, LAMU and Codex launch it as a subprocess
 *   kf-mcp --http     streamable HTTP on 127.0.0.1:$KF_MCP_HTTP_PORT, loopback only, Host and
 *                     Origin checked (for a later client that cannot spawn a process)
 *
 * Configuration is the environment (`config.ts`); docs/agents/mcp.md has the client snippets.
 * stdout belongs to the protocol under stdio, so everything this process says goes to stderr.
 */

import { createServer } from 'node:http';
import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from '@modelcontextprotocol/node';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { FabricApi } from './api.js';
import { ConfigRefused, loadConfig } from './config.js';
import { createKfMcpServer } from './server.js';

function say(line: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ service: 'kf-mcp', ...line })}\n`);
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error: unknown) {
    if (error instanceof ConfigRefused) {
      say({ outcome: 'refused', problems: error.problems });
      process.exit(2);
    }
    throw error;
  }
  const api = new FabricApi(config);
  const http = process.argv.includes('--http');
  say({
    outcome: 'starting',
    transport: http ? 'streamable-http' : 'stdio',
    api: config.apiUrl.origin,
    token: config.tokens.describe,
  });

  if (!http) {
    await createKfMcpServer(api).connect(new StdioServerTransport());
    return;
  }

  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  createServer((request, response) => {
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;
    if (new URL(request.url ?? '/', 'http://127.0.0.1').pathname !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    // Stateless: one server and transport per request, every one over the same person's token.
    const server = createKfMcpServer(api);
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    void server
      .connect(transport)
      .then(() => transport.handleRequest(request, response))
      .catch(() => {
        if (!response.headersSent) response.writeHead(500).end();
      });
  }).listen(config.httpPort, '127.0.0.1', () => {
    say({ outcome: 'listening', address: `http://127.0.0.1:${String(config.httpPort)}/mcp` });
  });
}

main().catch((error: unknown) => {
  say({ outcome: 'error', message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
