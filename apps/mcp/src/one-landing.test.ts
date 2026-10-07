/**
 * The KF MCP server lands a draft through @kf/agent's submitDraft and has no write path of its own
 * (docs/agents/in-app-agent.md, "The KF MCP server lands drafts the same way"). A copy of the
 * landing here would drift from the chat's, as it had before: the two read a record's verification
 * differently. This reads the source, so it says nothing about behaviour; the permissions suite
 * (tests/permissions/mcp-server.test.ts) exercises that end to end.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');

describe('the MCP server has one landing for a draft', () => {
  it('submits through submitDraft and names no write route itself', () => {
    expect(source).toMatch(/from '@kf\/agent\/submit'/);
    expect(source).toMatch(/await submitDraft\(api,/);
    for (const route of ['/actions/', '/capture/observation', 'propose_act']) {
      expect(source.includes(`'${route}`) || source.includes(`\`${route}`), route).toBe(false);
    }
  });
});
