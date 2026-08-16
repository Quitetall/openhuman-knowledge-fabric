import { ApiError, parseDocumentProposalInput, postDocumentProposal } from '../../../../lib/api';
import { webCaller } from '../../../../lib/session';

const MAX_PROPOSAL_BYTES = 64 * 1024;

async function boundedBody(request: Request): Promise<string | undefined> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_PROPOSAL_BYTES)) {
    return undefined;
  }
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_PROPOSAL_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(joined);
}

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ id: string }> },
): Promise<Response> {
  const origin = request.headers.get('origin');
  if (origin === null || origin !== new URL(request.url).origin) {
    return Response.json({ error: 'cross_origin_proposal_refused' }, { status: 403 });
  }
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') {
    return Response.json({ error: 'unsupported_proposal_media_type' }, { status: 415 });
  }
  try {
    const body = await boundedBody(request);
    if (body === undefined) {
      return Response.json({ error: 'proposal_too_large' }, { status: 413 });
    }
    const input = parseDocumentProposalInput(JSON.parse(body) as unknown);
    const { id } = await context.params;
    const outcome = await postDocumentProposal(
      id,
      input,
      await webCaller(`/documents/${encodeURIComponent(id)}`),
    );
    return Response.json(outcome, { status: 201 });
  } catch (error: unknown) {
    if (error instanceof ApiError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    if (error instanceof Error) {
      return Response.json({ error: 'invalid_document_proposal' }, { status: 400 });
    }
    throw error;
  }
}
