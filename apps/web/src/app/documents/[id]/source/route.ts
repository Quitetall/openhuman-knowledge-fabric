import { proxyDocumentDownload } from '../../download-proxy';

export async function GET(
  _request: Request,
  context: { readonly params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const encodedId = encodeURIComponent(id);
  return proxyDocumentDownload(`/documents/${encodedId}/source`, `/documents/${encodedId}`);
}
