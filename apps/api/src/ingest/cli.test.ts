import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  parseIngestArgs,
  parseReferenceManifest,
  runIngest,
  runIngestCommand,
  runIngestViaApi,
} from './cli.js';

describe('kf ingest argument boundary', () => {
  it('parses explicit mode, identity, metadata, and paths', () => {
    expect(
      parseIngestArgs([
        '--mode=copy',
        '--classification=internal',
        '--identity=dev',
        '--kind=document',
        '--reason=constitution dogfood',
        '/tmp/one.md',
        '/tmp/two.md',
      ]),
    ).toEqual({
      mode: 'copy',
      classification: 'internal',
      identity: 'dev',
      artifactKind: 'document',
      reason: 'constitution dogfood',
      revisionLabel: undefined,
      referenceManifest: undefined,
      organizationId: undefined,
      actingRoleId: undefined,
      tokenFile: undefined,
      json: false,
      paths: ['/tmp/one.md', '/tmp/two.md'],
    });
  });

  it('accepts repeated --drive references and one export MIME type', () => {
    const args = parseIngestArgs([
      '--mode=copy',
      '--classification=internal',
      '--identity=dev',
      '--drive=F1234567890@r7',
      '--drive',
      'G1234567890',
      '--export-mime=application/pdf',
    ]);
    expect(args.driveRefs).toEqual(['F1234567890@r7', 'G1234567890']);
    expect(args.exportMimeType).toBe('application/pdf');
    expect(args.paths).toEqual([]);
    expect(() => parseIngestArgs(['--export-mime=a/b', '--export-mime=c/d', 'x'])).toThrow(
      'duplicate option --export-mime',
    );
  });

  it('does not accept inline bearer tokens', () => {
    expect(() => parseIngestArgs(['--identity=oidc', '--token=secret', '/tmp/a.md'])).toThrow(
      'unknown option --token; use --token-file',
    );
  });

  it('parses exact reference manifests and matches paths lexically', () => {
    const manifest = parseReferenceManifest(
      JSON.stringify({
        entries: [
          {
            path: './vendor/part.pdf',
            source_system: 'document_system',
            authority: 'evidence',
            locator_system: 'vendor-portal',
            external_id: 'ADS-1',
            title: 'Part datasheet',
            uri: 'https://vendor.example/ADS-1',
          },
        ],
      }),
      ['/workspace/vendor/part.pdf'],
      '/workspace',
    );
    expect(manifest.get('/workspace/vendor/part.pdf')).toEqual({
      path: './vendor/part.pdf',
      source_system: 'document_system',
      authority: 'evidence',
      locator_system: 'vendor-portal',
      external_id: 'ADS-1',
      title: 'Part datasheet',
      uri: 'https://vendor.example/ADS-1',
    });
  });

  it('refuses a manifest that omits or adds a CLI path', () => {
    expect(() =>
      parseReferenceManifest(JSON.stringify({ entries: [] }), ['/workspace/a.pdf'], '/workspace'),
    ).toThrow('reference manifest entries must match CLI paths exactly');
  });

  it('refuses duplicate CLI paths instead of making idempotency ambiguous', () => {
    expect(() =>
      parseReferenceManifest(
        JSON.stringify({
          entries: [
            {
              path: 'a.md',
              source_system: 'git',
              authority: 'evidence',
              locator_system: 'git',
              external_id: 'a',
            },
          ],
        }),
        ['/workspace/a.md', '/workspace/./a.md'],
        '/workspace',
      ),
    ).toThrow('reference manifest entries must match CLI paths exactly');
  });

  it('refuses planner-invalid input before opening credentials or a database', async () => {
    const error = await runIngest(
      { identity: 'dev', paths: ['/workspace/a.md'], json: false },
      {},
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: 'IngestCliError' });
    expect((error as { refusals?: readonly string[] }).refusals?.[0]).toContain(
      'no --mode given. State copy or reference explicitly:',
    );
  });

  it('prints every planner refusal verbatim and exits non-zero', async () => {
    let stderr = '';
    const sink = {
      write(chunk: string | Uint8Array): boolean {
        stderr += chunk.toString();
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const status = await runIngestCommand(
      [
        '--mode=copy',
        '--classification=internal',
        '--identity=dev',
        '/workspace/docs/ours.md',
        '/workspace/vendor/theirs.pdf',
      ],
      {},
      sink,
      sink,
    );
    expect(status).toBe(1);
    expect(stderr).toBe(
      'refusing to copy /workspace/vendor/theirs.pdf: rule vendor-tree — vendor material is ' +
        'third-party copyright. Re-run this batch with --mode=reference --revision=<document revision>.\n',
    );
  });
});

describe('kf ingest --via=api', () => {
  it('posts each file to /ingest as the person, and needs no database credential', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kf-ingest-api-'));
    await writeFile(join(dir, 'note.md'), '# note\n');
    await writeFile(join(dir, 'token'), 'tok.en\n', { mode: 0o600 });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          artifactId: 'art-1',
          actionId: 'act-1',
          sha256: 'x',
          sizeBytes: 7,
          replayed: false,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const result = await runIngestViaApi(
      {
        mode: 'copy',
        classification: 'internal',
        identity: 'oidc',
        organizationId: '44444444-4444-7444-8444-444444444444',
        actingRoleId: '66666666-6666-7666-8666-666666666666',
        tokenFile: join(dir, 'token'),
        json: true,
        paths: [join(dir, 'note.md')],
        via: 'api',
      },
      { KF_API_ORIGIN: 'https://api.kf.internal/' },
      dir,
      fake,
    );
    expect(calls.map((c) => c.url)).toEqual(['https://api.kf.internal/ingest']);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer tok.en');
    expect(headers['x-kf-classification']).toBe('internal');
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body['title']).toBe('note.md');
    expect(body['artifactKind']).toBe('document');
    expect(body['classification']).toBe('internal');
    expect(Buffer.from(String(body['contentBase64']), 'base64').toString()).toBe('# note\n');
    expect(result.items[0]).toMatchObject({
      artifactId: 'art-1',
      actionId: 'act-1',
      replayed: false,
    });
  });

  it('refuses reference mode and Drive sources, which stay on the database path', async () => {
    await expect(
      runIngestViaApi(
        { mode: 'reference', identity: 'oidc', json: false, paths: ['x.md'], via: 'api' },
        { KF_API_ORIGIN: 'https://api' },
        '/tmp',
      ),
    ).rejects.toThrow(/reference mode|--reference-manifest|copies only/);
  });
});
