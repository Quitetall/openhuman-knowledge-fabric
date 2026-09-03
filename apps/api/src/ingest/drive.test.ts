/**
 * Drive is an external Source Holder (ADR 0022). What is tested is what the adapter must
 * NOT do — write, cite a revision it did not read, claim bytes it did not export — and that
 * what it records (id, revision, exporter) is exactly what it did.
 */

import { describe, expect, it } from 'vitest';
import {
  DRIVE_EXPORTER,
  DRIVE_SCOPE,
  GoogleDriveClient,
  exportTargetFor,
  parseDriveRef,
} from './drive.js';

// A throwaway RSA key generated for this test only; it signs nothing outside it.
import { generateKeyPairSync } from 'node:crypto';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ACCOUNT = {
  client_email: 'kf-ingest@example.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  token_uri: 'https://oauth2.example/token',
};

interface Seen {
  method: string;
  url: string;
}

function fakeDrive(meta: Record<string, unknown>, bytesByPath: Record<string, string>) {
  const seen: Seen[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    seen.push({ method, url });
    if (url === ACCOUNT.token_uri) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
        status: 200,
      });
    }
    const path = url.replace('https://www.googleapis.com/drive/v3/', '');
    if (path.startsWith('files/F1234567890?fields=')) {
      return new Response(JSON.stringify(meta), { status: 200 });
    }
    for (const [prefix, body] of Object.entries(bytesByPath)) {
      if (path.startsWith(prefix)) return new Response(body, { status: 200 });
    }
    return new Response('nope', { status: 404 });
  };
  return { seen, client: new GoogleDriveClient(ACCOUNT, fetchImpl) };
}

describe('Drive references', () => {
  it('parses <fileId> and <fileId>@<revisionId>, nothing else', () => {
    expect(parseDriveRef('F1234567890')).toEqual({ fileId: 'F1234567890' });
    expect(parseDriveRef('F1234567890@r42')).toEqual({ fileId: 'F1234567890', revisionId: 'r42' });
    expect(() => parseDriveRef('short')).toThrow('not a Drive reference');
    expect(() => parseDriveRef('https://docs.google.com/document/d/F1234567890')).toThrow(
      'not a Drive reference',
    );
  });

  it('exports Google-native types to a pinned target and leaves bytes-bearing types alone', () => {
    expect(exportTargetFor('application/vnd.google-apps.document')).toBe('text/markdown');
    expect(exportTargetFor('application/pdf')).toBeUndefined();
    expect(exportTargetFor('application/vnd.google-apps.document', 'application/pdf')).toBe(
      'application/pdf',
    );
  });
});

describe('GoogleDriveClient', () => {
  const base = {
    id: 'F1234567890',
    name: 'Spec.gdoc',
    headRevisionId: 'head9',
    modifiedTime: '2026-09-01T00:00:00Z',
    webViewLink: 'https://docs.google.com/d/F1234567890',
  };

  it('exports a native document at its head revision and names the exporter', async () => {
    const { seen, client } = fakeDrive(
      { ...base, mimeType: 'application/vnd.google-apps.document' },
      { 'files/F1234567890/export?mimeType=text%2Fmarkdown': '# Spec\n' },
    );
    const fetched = await client.fetch('F1234567890', {});
    expect(fetched.bytes.toString()).toBe('# Spec\n');
    expect(fetched.mediaType).toBe('text/markdown');
    expect(fetched.sourceMimeType).toBe('application/vnd.google-apps.document');
    expect(fetched.revisionId).toBe('head9');
    expect(fetched.exporter).toBe(`${DRIVE_EXPORTER} files.export mimeType=text/markdown`);
    // Read-only: the only non-GET is the token exchange.
    expect(seen.filter((s) => s.method !== 'GET').map((s) => s.url)).toEqual([ACCOUNT.token_uri]);
    expect(DRIVE_SCOPE.endsWith('drive.readonly')).toBe(true);
  });

  it('refuses to export a native document at a revision it cannot read', async () => {
    const { seen, client } = fakeDrive(
      { ...base, mimeType: 'application/vnd.google-apps.document' },
      { 'files/F1234567890/export': '# Spec\n' },
    );
    await expect(client.fetch('F1234567890', { revisionId: 'old1' })).rejects.toThrow(
      'can only be exported at its head revision (head9), not old1',
    );
    expect(seen.some((s) => s.url.includes('/export'))).toBe(false);
  });

  it('reads a bytes-bearing file at the requested revision through the revisions endpoint', async () => {
    const { seen, client } = fakeDrive(
      { ...base, mimeType: 'application/pdf', name: 'part.pdf' },
      {
        'files/F1234567890/revisions/old1?alt=media': 'OLD',
        'files/F1234567890?alt=media': 'HEAD',
      },
    );
    const fetched = await client.fetch('F1234567890', { revisionId: 'old1' });
    expect(fetched.bytes.toString()).toBe('OLD');
    expect(fetched.revisionId).toBe('old1');
    expect(fetched.mediaType).toBe('application/pdf');
    expect(fetched.exporter).toBe(`${DRIVE_EXPORTER} files.get alt=media`);
    expect(seen.some((s) => s.url.endsWith('/revisions/old1?alt=media'))).toBe(true);
  });

  it('refuses a file that reports no head revision rather than citing none', async () => {
    const { client } = fakeDrive(
      { ...base, headRevisionId: undefined, mimeType: 'application/pdf' },
      { 'files/F1234567890?alt=media': 'HEAD' },
    );
    await expect(client.fetch('F1234567890', {})).rejects.toThrow('reports no head revision');
  });
});
