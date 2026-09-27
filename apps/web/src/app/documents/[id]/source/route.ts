import type { NextRequest } from 'next/server';
import { proxyDocumentDownload, sourceDisposition } from '../../download-proxy';

export async function GET(
  request: NextRequest,
  context: { readonly params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const encodedId = encodeURIComponent(id);
  return proxyDocumentDownload(
    `/documents/${encodedId}/source${sourceDisposition(request.nextUrl.searchParams)}`,
    `/documents/${encodedId}`,
  );
}
