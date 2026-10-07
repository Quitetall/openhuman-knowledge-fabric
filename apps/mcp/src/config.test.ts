import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigRefused, loadConfig } from './config.js';
import { fileTokenSource, TokenUnavailable } from './token.js';

const ORG = '01a114e0-339e-7463-afe2-e09d9261e893';
const dir = mkdtempSync(join(tmpdir(), 'kf-mcp-config-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const base = { KF_ORGANIZATION: ORG, KF_MCP_TOKEN_FILE: join(dir, 'token') };

function problems(env: Record<string, string>): readonly string[] {
  try {
    loadConfig(env);
  } catch (error: unknown) {
    if (error instanceof ConfigRefused) return error.problems;
    throw error;
  }
  return [];
}

describe('kf-mcp configuration', () => {
  it('accepts a loopback API and a token file', () => {
    expect(problems(base)).toEqual([]);
    expect(loadConfig(base).apiUrl.origin).toBe('http://127.0.0.1:4000');
  });

  it('refuses an inline token: a token is named by file or command, never by value', () => {
    expect(problems({ ...base, KF_MCP_TOKEN: 'eyJ.x.y' }).join()).toMatch(/inline token/);
  });

  it('refuses plain http to anything but loopback', () => {
    expect(problems({ ...base, KF_API_URL: 'http://kf.example.org' }).join()).toMatch(/loopback/);
    expect(problems({ ...base, KF_API_URL: 'https://kf.example.org' })).toEqual([]);
  });

  it('needs exactly one token source and an organization', () => {
    expect(problems({ KF_ORGANIZATION: ORG }).join()).toMatch(/exactly one/);
    expect(problems({ ...base, KF_MCP_TOKEN_COMMAND: 'printf x' }).join()).toMatch(/exactly one/);
    expect(problems({ KF_MCP_TOKEN_FILE: base.KF_MCP_TOKEN_FILE }).join()).toMatch(
      /KF_ORGANIZATION/,
    );
  });
});

describe('the token file', () => {
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln';

  it('is read when it is the owner’s alone', async () => {
    const path = join(dir, 'owner-only');
    writeFileSync(path, `${jwt}\n`);
    chmodSync(path, 0o600);
    expect(await fileTokenSource(path).token()).toBe(jwt);
  });

  it('is refused when anyone else can read it', async () => {
    const path = join(dir, 'shared');
    writeFileSync(path, jwt);
    chmodSync(path, 0o644);
    await expect(fileTokenSource(path).token()).rejects.toThrow(TokenUnavailable);
  });

  it('is refused when it does not hold a token', async () => {
    const path = join(dir, 'not-a-token');
    writeFileSync(path, 'password123');
    chmodSync(path, 0o600);
    await expect(fileTokenSource(path).token()).rejects.toThrow(/does not hold a bearer token/);
  });
});
