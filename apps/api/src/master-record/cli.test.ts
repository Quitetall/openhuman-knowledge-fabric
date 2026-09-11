import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchMasterRecord, parseMasterRecordArgs } from './cli.js';

/**
 * The command is three requests and nothing else. What it sends is asserted exactly — the
 * bearer, the two scoping headers, the idempotency key — and what it returns is the API's bytes
 * untouched, because "as made by the API" is the whole promise of the master record.
 */

const ORG = '019ff405-2ec7-736e-898a-1f5687a80a48';
const ROLE = '019ff405-2ecb-7e77-96cb-00990ac6f24c';

describe('parseMasterRecordArgs', () => {
  it('defaults to the master_sections projection as html, compiling first', () => {
    const args = parseMasterRecordArgs(['--token-file', 't', '--organization', ORG]);
    expect(args.projection).toBe('master_sections');
    expect(args.format).toBe('html');
    expect(args.compile).toBe(true);
  });

  it('refuses a format the API does not render', () => {
    expect(() => parseMasterRecordArgs(['--format', 'pdf'])).toThrow(/--format must be/);
  });

  it('refuses an unknown flag', () => {
    expect(() => parseMasterRecordArgs(['--person', 'x'])).toThrow(/unknown option --person/);
  });
});

describe('fetchMasterRecord', () => {
  async function tokenFile(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'kf-mr-'));
    const path = join(dir, 'token');
    await writeFile(path, 'tok.en.value\n');
    return path;
  }

  it('compiles, reads the claim, and returns the rendering byte for byte', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const html = '<!doctype html><p>as rendered</p>\n';
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/master-record/compile')) {
        return new Response(JSON.stringify({ actionId: 'a1', status: 'applied', reused: false }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/master-record')) {
        return new Response(JSON.stringify({ corpus_digest: 'c0ffee' }), { status: 200 });
      }
      return new Response(html, {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'x-kf-projection-digest': 'p1',
          'x-kf-corpus-digest': 'c0ffee',
        },
      });
    }) as typeof fetch;

    const result = await fetchMasterRecord(
      {
        tokenFile: await tokenFile(),
        organizationId: ORG,
        actingRoleId: ROLE,
        classification: 'restricted',
        projection: 'master_sections',
        format: 'html',
        compile: true,
      },
      { KF_API_ORIGIN: 'https://api.kf.internal/' },
      fake,
    );

    expect(calls.map((call) => call.url)).toEqual([
      'https://api.kf.internal/master-record/compile',
      'https://api.kf.internal/master-record',
      'https://api.kf.internal/master-record/projections/master_sections?format=html',
    ]);
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer tok.en.value');
    expect(headers['x-kf-organization']).toBe(ORG);
    expect(headers['x-kf-acting-role']).toBe(ROLE);
    expect(headers['x-kf-classification']).toBe('restricted');
    const body = JSON.parse(String(calls[0]!.init!.body)) as { idempotencyKey: string };
    expect(body.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(result.compiled).toEqual({ status: 201, actionId: 'a1', reused: false });
    expect(result.rendering.bytes.toString('utf8')).toBe(html);
    expect(result.rendering.projectionDigest).toBe('p1');
  });

  it('surfaces a refusal with its status and body rather than an empty file', async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ error: 'unknown_subject' }), { status: 401 })) as typeof fetch;
    await expect(
      fetchMasterRecord(
        {
          tokenFile: await tokenFile(),
          organizationId: ORG,
          actingRoleId: ROLE,
          projection: 'master_sections',
          format: 'html',
          compile: true,
        },
        { KF_API_ORIGIN: 'https://api.kf.internal' },
        fake,
      ),
    ).rejects.toThrow(/compile refused: 401 .*unknown_subject/);
  });

  it('refuses to run without an API origin', async () => {
    await expect(
      fetchMasterRecord(
        {
          tokenFile: 'x',
          organizationId: ORG,
          actingRoleId: ROLE,
          projection: 'master_sections',
          format: 'html',
          compile: false,
        },
        {},
      ),
    ).rejects.toThrow(/no API origin/);
  });
});
