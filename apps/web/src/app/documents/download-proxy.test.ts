import { describe, expect, it } from 'vitest';
import { safeDownloadResponse, sourceDisposition } from './download-proxy.js';

describe('document download proxy', () => {
  it('forwards only content headers and preserves the byte stream', async () => {
    const upstream = new Response('exact bytes', {
      headers: {
        'content-type': 'text/plain',
        'content-disposition': 'attachment; filename="exact.txt"',
        etag: '"sha256:abc"',
        'set-cookie': 'must-not-cross-boundary=1',
        'x-storage-key': 'secret/object/key',
      },
    });

    const response = safeDownloadResponse(upstream);

    expect(await response.text()).toBe('exact bytes');
    expect(response.headers.get('content-disposition')).toContain('exact.txt');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-storage-key')).toBeNull();
  });

  it('forwards only disposition=inline to the API, and nothing else', () => {
    const q = (query: string) => sourceDisposition(new URLSearchParams(query));
    expect(q('disposition=inline')).toBe('?disposition=inline');
    expect(q('')).toBe('');
    expect(q('disposition=attachment')).toBe('');
    expect(q('disposition=inline&disposition=inline')).toBe('');
    expect(q('disposition=inline%0d%0aX-Evil:1')).toBe('');
    expect(q('other=1')).toBe('');
  });
});
