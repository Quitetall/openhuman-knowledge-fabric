import {
  apiBaseUrl,
  callerHeaders,
  decodeSuccessfulResponse,
  parseResponse,
  type Caller,
} from './client';
import { hasStrings, record } from './validation';
import type { DocumentProposalInput } from './document-proposal';

export interface DocumentProposalOutcome {
  readonly proposalId: string;
  readonly actionId: string;
  readonly replayed: boolean;
  readonly auditDigest: string;
}

function parseProposalOutcome(value: unknown): DocumentProposalOutcome {
  const outcome = record(value);
  if (
    outcome === undefined ||
    !hasStrings(outcome, ['proposalId', 'actionId', 'auditDigest']) ||
    typeof outcome['replayed'] !== 'boolean'
  ) {
    throw new Error('document proposal outcome did not match contract');
  }
  return outcome as unknown as DocumentProposalOutcome;
}

export async function postDocumentProposal(
  documentId: string,
  input: DocumentProposalInput,
  caller: Caller,
): Promise<DocumentProposalOutcome> {
  const response = await fetch(
    `${apiBaseUrl()}/documents/${encodeURIComponent(documentId)}/proposals`,
    {
      method: 'POST',
      headers: callerHeaders(caller),
      body: JSON.stringify(input),
    },
  );
  return decodeSuccessfulResponse(await parseResponse(response), parseProposalOutcome);
}

/** Fetch a bounded API download while leaving its verified byte stream untouched for proxying. */
export async function getDocumentDownload(path: string, caller: Caller): Promise<Response> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    headers: callerHeaders(caller),
    cache: 'no-store',
  });
  if (!response.ok) await parseResponse(response);
  return response;
}
