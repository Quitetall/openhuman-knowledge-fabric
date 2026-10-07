import {
  apiBaseUrl,
  callerHeaders,
  decodeSuccessfulResponse,
  get,
  parseResponse,
  type Caller,
} from './client';
import { record } from './validation';
import { parseVerification, type Verification } from './verification';

/**
 * Needs you, as the API states it (`GET /needs-you`; ADR 0040, SAS §24B, KF-SAS-RQ-263 to
 * RQ-266), and the gestures that answer it. The page decides nothing: every click is one API
 * call, which dispatches the act and meets every check that act meets.
 *
 *   verify   `POST /needs-you/verify` — one record the person OPENED, at `reviewed_individually`,
 *            naming the row version they opened (SAS §100.26: paced, not proven);
 *   bulk     `POST /verifications/bulk` — many, recorded `promoted_in_bulk`, one act each;
 *   confirm  `POST /needs-you/proposals/:id/confirm` — the person performs the act their agent
 *            proposed, exactly as proposed, on their own token;
 *   decline  `POST /needs-you/proposals/:id/decline`, with a reason.
 */

export interface NeedsYouRecord {
  readonly id: string;
  readonly objectType: string;
  readonly title: string;
  readonly classification: string;
  readonly lifecycleState: string;
  readonly rowVersion: number;
  readonly agentClientId: string;
  readonly writtenFor: string;
  readonly writtenAt: string;
  readonly verification: Verification;
}

export interface NeedsYouProposal {
  readonly id: string;
  readonly actionType: string;
  readonly targetIds: readonly string[];
  readonly reason: string | null;
  readonly agentClientId: string;
  readonly proposedAt: string;
  readonly confirmableHere: boolean;
}

/** Qualification evidence a person submitted that this reader may credit (ADR 0038). */
export interface NeedsYouEvidence {
  readonly submissionId: string;
  readonly recordId: string;
  readonly personName: string | null;
  readonly requirementKey: string;
  readonly outcome: string;
  readonly mode: string;
  readonly evidenceObjectId: string;
  readonly evidenceTitle: string | null;
  readonly evidenceVerified: boolean;
  readonly packTitle: string;
}

export interface NeedsYou {
  readonly toVerify: { readonly items: readonly NeedsYouRecord[]; readonly total: number };
  readonly awaitingOthers: { readonly items: readonly NeedsYouRecord[]; readonly total: number };
  readonly proposals: { readonly items: readonly NeedsYouProposal[]; readonly total: number };
  readonly toCredit: { readonly items: readonly NeedsYouEvidence[]; readonly total: number };
}

function list<T>(
  value: unknown,
  item: (v: Record<string, unknown>) => T,
): {
  items: T[];
  total: number;
} {
  const v = record(value);
  const items = v?.['items'];
  const total = v?.['total'];
  if (!Array.isArray(items) || typeof total !== 'number') {
    throw new Error('needs-you list did not match its contract');
  }
  return {
    items: items.map((entry) => {
      const r = record(entry);
      if (r === undefined) throw new Error('needs-you item is not an object');
      return item(r);
    }),
    total,
  };
}

function parseRecord(r: Record<string, unknown>): NeedsYouRecord {
  for (const field of [
    'id',
    'objectType',
    'title',
    'classification',
    'lifecycleState',
    'agentClientId',
    'writtenFor',
    'writtenAt',
  ]) {
    if (typeof r[field] !== 'string') throw new Error(`needs-you record lacks ${field}`);
  }
  if (typeof r['rowVersion'] !== 'number') throw new Error('needs-you record lacks rowVersion');
  return {
    id: r['id'] as string,
    objectType: r['objectType'] as string,
    title: r['title'] as string,
    classification: r['classification'] as string,
    lifecycleState: r['lifecycleState'] as string,
    rowVersion: r['rowVersion'],
    agentClientId: r['agentClientId'] as string,
    writtenFor: r['writtenFor'] as string,
    writtenAt: r['writtenAt'] as string,
    // Fail closed: anything that does not prove it verified is shown unverified.
    verification: parseVerification(r['verification']),
  };
}

function parseProposal(r: Record<string, unknown>): NeedsYouProposal {
  if (
    typeof r['id'] !== 'string' ||
    typeof r['actionType'] !== 'string' ||
    !Array.isArray(r['targetIds']) ||
    typeof r['agentClientId'] !== 'string' ||
    typeof r['proposedAt'] !== 'string' ||
    typeof r['confirmableHere'] !== 'boolean'
  ) {
    throw new Error('needs-you proposal did not match its contract');
  }
  return {
    id: r['id'],
    actionType: r['actionType'],
    targetIds: (r['targetIds'] as unknown[]).filter((id): id is string => typeof id === 'string'),
    reason: typeof r['reason'] === 'string' ? r['reason'] : null,
    agentClientId: r['agentClientId'],
    proposedAt: r['proposedAt'],
    confirmableHere: r['confirmableHere'],
  };
}

function parseEvidence(r: Record<string, unknown>): NeedsYouEvidence {
  for (const field of [
    'submissionId',
    'recordId',
    'requirementKey',
    'outcome',
    'mode',
    'evidenceObjectId',
    'packTitle',
  ]) {
    if (typeof r[field] !== 'string') throw new Error(`needs-you evidence lacks ${field}`);
  }
  return {
    submissionId: r['submissionId'] as string,
    recordId: r['recordId'] as string,
    personName: typeof r['personName'] === 'string' ? r['personName'] : null,
    requirementKey: r['requirementKey'] as string,
    outcome: r['outcome'] as string,
    mode: r['mode'] as string,
    evidenceObjectId: r['evidenceObjectId'] as string,
    evidenceTitle: typeof r['evidenceTitle'] === 'string' ? r['evidenceTitle'] : null,
    evidenceVerified: r['evidenceVerified'] === true,
    packTitle: r['packTitle'] as string,
  };
}

export function parseNeedsYou(value: unknown): NeedsYou {
  const v = record(value);
  if (v === undefined) throw new Error('needs-you response is not an object');
  return {
    toVerify: list(v['toVerify'], parseRecord),
    awaitingOthers: list(v['awaitingOthers'], parseRecord),
    proposals: list(v['proposals'], parseProposal),
    // Absent from an API before M5: nothing to credit, which is what absence means.
    toCredit:
      v['toCredit'] === undefined ? { items: [], total: 0 } : list(v['toCredit'], parseEvidence),
  };
}

export function getNeedsYou(caller: Caller): Promise<NeedsYou> {
  return get('/needs-you', caller, parseNeedsYou);
}

async function post(path: string, caller: Caller, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    method: 'POST',
    headers: callerHeaders(caller),
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  return decodeSuccessfulResponse(await parseResponse(response), (value) => value);
}

export function verifyOne(
  caller: Caller,
  input: { recordId: string; expectedVersion: number; reason: string; idempotencyKey: string },
): Promise<unknown> {
  return post('/needs-you/verify', caller, { ...input });
}

export function verifyMany(
  caller: Caller,
  input: { recordIds: readonly string[]; reason: string; idempotencyKey: string },
): Promise<unknown> {
  return post('/verifications/bulk', caller, { ...input, recordIds: [...input.recordIds] });
}

export function confirmProposal(caller: Caller, proposalId: string): Promise<unknown> {
  return post(`/needs-you/proposals/${encodeURIComponent(proposalId)}/confirm`, caller, {});
}

export function declineProposal(
  caller: Caller,
  proposalId: string,
  input: { reason: string; idempotencyKey: string },
): Promise<unknown> {
  return post(`/needs-you/proposals/${encodeURIComponent(proposalId)}/decline`, caller, {
    ...input,
  });
}
