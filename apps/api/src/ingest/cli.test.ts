import { describe, expect, it } from 'vitest';
import { parseIngestArgs, parseReferenceManifest, runIngest, runIngestCommand } from './cli.js';

describe('kf ingest argument boundary', () => {
  it('parses explicit mode, identity, metadata, and paths', () => {
    expect(
      parseIngestArgs([
        '--mode=copy',
        '--classification=internal',
        '--identity=dev',
        '--kind=specification',
        '--reason=constitution dogfood',
        '/tmp/one.md',
        '/tmp/two.md',
      ]),
    ).toEqual({
      mode: 'copy',
      classification: 'internal',
      identity: 'dev',
      artifactKind: 'specification',
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
