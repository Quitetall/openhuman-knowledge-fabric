import { proxyDocumentDownload } from '../../../download-proxy';

export async function GET(
  _request: Request,
  context: { readonly params: Promise<{ id: string; viewId: string }> },
): Promise<Response> {
  const { id, viewId } = await context.params;
  const encodedId = encodeURIComponent(id);
  return proxyDocumentDownload(
    `/documents/${encodedId}/projections/${encodeURIComponent(viewId)}`,
    `/documents/${encodedId}`,
  );
}
