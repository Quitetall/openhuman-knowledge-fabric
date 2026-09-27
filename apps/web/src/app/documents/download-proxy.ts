import { ApiError, getDocumentDownload } from '../../lib/api';
import { webCaller } from '../../lib/session';

const FORWARDED_HEADERS = [
  'cache-control',
  'content-disposition',
  'content-length',
  'content-type',
  'etag',
  'x-content-type-options',
] as const;

/**
 * The one query the source route forwards: `disposition=inline`, which asks the API to let the
 * browser display a PDF or plain text rather than save it. Any other value, or any other
 * parameter, is dropped, so a link cannot smuggle options to the API through this proxy. The API
 * still decides the disposition by media type; this only relays the request for it.
 */
export function sourceDisposition(params: URLSearchParams): string {
  return params.getAll('disposition').length === 1 && params.get('disposition') === 'inline'
    ? '?disposition=inline'
    : '';
}

export function safeDownloadResponse(upstream: Response): Response {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set('cache-control', 'private, no-store');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(upstream.body, { status: 200, headers });
}

export async function proxyDocumentDownload(path: string, returnTo: string): Promise<Response> {
  try {
    const upstream = await getDocumentDownload(path, await webCaller(returnTo));
    return safeDownloadResponse(upstream);
  } catch (error: unknown) {
    if (error instanceof ApiError) {
      return Response.json({ error: error.code }, { status: error.status });
    }
    throw error;
  }
}
