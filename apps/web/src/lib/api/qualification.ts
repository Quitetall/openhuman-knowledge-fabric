/**
 * Start Here and the qualification gestures, as the API states them (ADR 0038; ADR 0040
 * decision 12; KF-SAS-RQ-275).
 *
 *   GET  /start-here                        kf-start-here-list-v1: the reader's records in force
 *   GET  /qualification/records/:id         one record's Start Here, for its person, contact or
 *                                           reviewers
 *   POST /qualification/records/:id/submit  the person names evidence; it credits nothing
 *   POST /qualification/records/:id/credit  a reviewer credits (the last credit closes the record),
 *                                           or the person acknowledges a self-acknowledged item
 *   GET  /invitations/:token                where the signed-in invited person goes next
 *
 * The page renders what these return and decides nothing: every status resolves to a
 * requirement and its evidence, and parsing fails closed (a body off contract is an error, never
 * a page guessed from part of it). Nothing here reads a role or a title.
 */

import {
  apiBaseUrl,
  callerHeaders,
  decodeSuccessfulResponse,
  get,
  parseResponse,
  type Caller,
} from './client';
import { nonNegativeInteger, record } from './validation';

export const STAGE_IDS = [
  'read_in',
  'role_read_in',
  'references',
  'execution',
  'first_contribution',
] as const;
export type StageId = (typeof STAGE_IDS)[number];

export type RequirementStatus =
  'satisfied' | 'gap_revised' | 'submitted' | 'open' | 'blocked_on_organization';

const STATUSES: readonly RequirementStatus[] = [
  'satisfied',
  'gap_revised',
  'submitted',
  'open',
  'blocked_on_organization',
];

export type Blocker =
  | { readonly kind: 'resource_not_granted'; readonly resourceId: string }
  | { readonly kind: 'resource_missing'; readonly resourceId: string }
  | { readonly kind: 'reviewer_unavailable'; readonly authority: string };

export interface StartHereItem {
  readonly key: string;
  readonly outcome: string;
  readonly mode: 'acknowledge' | 'locate' | 'demonstrate';
  readonly mandatory: boolean;
  readonly consequence: { readonly kind: string; readonly statement: string } | null;
  readonly acceptedBy: string;
  readonly status: RequirementStatus;
  readonly revision: number;
  readonly evidence: {
    readonly creditId: string;
    readonly revision: number;
    readonly evidenceObjectId: string | null;
    readonly creditedBy: string;
    readonly creditedAt: string;
  } | null;
  readonly submitted: readonly { readonly id: string; readonly evidenceObjectId: string }[];
  readonly blockers: readonly Blocker[];
  readonly resources: readonly {
    readonly id: string;
    readonly revision: string;
    readonly authorityClass: string;
    readonly label: string | null;
    readonly reach: string;
  }[];
  readonly awaiting: readonly string[];
}

export interface StartHereStage {
  readonly id: StageId;
  readonly title: string;
  readonly question: string;
  readonly items: readonly StartHereItem[];
  readonly done: number;
  readonly total: number;
}

export interface StartHere {
  readonly recordId: string;
  readonly personId: string;
  readonly contact: { readonly personId: string; readonly name: string | null };
  readonly scope: { readonly objectId: string | null; readonly title: string | null };
  readonly pack: { readonly title: string; readonly revision: number };
  readonly state: 'assigned' | 'qualified' | 'withdrawn' | 'superseded';
  readonly currency: 'qualified' | 'qualified_with_gap' | 'open' | 'withdrawn' | 'superseded';
  readonly complete: boolean;
  readonly missing: readonly string[];
  readonly gaps: readonly string[];
  readonly blocked: readonly string[];
  readonly stages: readonly StartHereStage[];
  readonly digest: string;
}

class ContractViolation extends Error {}

function fail(what: string): never {
  throw new ContractViolation(`start here: ${what}`);
}

function str(value: unknown, what: string): string {
  return typeof value === 'string' && value !== '' ? value : fail(what);
}

function list(value: unknown, what: string): readonly unknown[] {
  return Array.isArray(value) ? value : fail(what);
}

function strings(value: unknown, what: string): readonly string[] {
  return list(value, what).map((v) => str(v, what));
}

function count(value: unknown, what: string): number {
  return nonNegativeInteger(value) ? value : fail(what);
}

function oneOf<T extends string>(value: unknown, options: readonly T[], what: string): T {
  return options.includes(value as T) ? (value as T) : fail(what);
}

function parseBlocker(value: unknown): Blocker {
  const b = record(value) ?? fail('blocker');
  switch (b['kind']) {
    case 'resource_not_granted':
    case 'resource_missing':
      return { kind: b['kind'], resourceId: str(b['resourceId'], 'blocker.resourceId') };
    case 'reviewer_unavailable':
      return { kind: 'reviewer_unavailable', authority: str(b['authority'], 'blocker.authority') };
    default:
      return fail('blocker.kind');
  }
}

function parseItem(value: unknown): StartHereItem {
  const i = record(value) ?? fail('item');
  const consequence = record(i['consequence']);
  const evidence = record(i['evidence']);
  return {
    key: str(i['key'], 'item.key'),
    outcome: str(i['outcome'], 'item.outcome'),
    mode: oneOf(i['mode'], ['acknowledge', 'locate', 'demonstrate'] as const, 'item.mode'),
    mandatory: i['mandatory'] === true,
    consequence:
      consequence === undefined
        ? null
        : {
            kind: str(consequence['kind'], 'consequence.kind'),
            statement: str(consequence['statement'], 'consequence.statement'),
          },
    acceptedBy: str(i['acceptedBy'], 'item.acceptedBy'),
    status: oneOf(i['status'], STATUSES, 'item.status'),
    revision: count(i['revision'], 'item.revision'),
    evidence:
      evidence === undefined
        ? null
        : {
            creditId: str(evidence['creditId'], 'evidence.creditId'),
            revision: count(evidence['revision'], 'evidence.revision'),
            evidenceObjectId:
              typeof evidence['evidenceObjectId'] === 'string'
                ? evidence['evidenceObjectId']
                : null,
            creditedBy: str(evidence['creditedBy'], 'evidence.creditedBy'),
            creditedAt: str(evidence['creditedAt'], 'evidence.creditedAt'),
          },
    submitted: list(i['submitted'], 'item.submitted').map((s) => {
      const r = record(s) ?? fail('submitted');
      return {
        id: str(r['id'], 'submitted.id'),
        evidenceObjectId: str(r['evidenceObjectId'], 'submitted.evidence'),
      };
    }),
    blockers: list(i['blockers'], 'item.blockers').map(parseBlocker),
    resources: list(i['resources'], 'item.resources').map((r) => {
      const x = record(r) ?? fail('resource');
      return {
        id: str(x['id'], 'resource.id'),
        revision: str(x['revision'], 'resource.revision'),
        authorityClass: str(x['authorityClass'], 'resource.authorityClass'),
        label: typeof x['label'] === 'string' ? x['label'] : null,
        reach: str(x['reach'], 'resource.reach'),
      };
    }),
    awaiting: strings(i['awaiting'], 'item.awaiting'),
  };
}

/** kf-start-here-v1. */
export function parseStartHere(value: unknown): StartHere {
  const p = record(value) ?? fail('page');
  if (p['format'] !== 'kf-start-here-v1') fail('format');
  const contact = record(p['contact']) ?? fail('contact');
  const scope = record(p['scope']) ?? fail('scope');
  const pack = record(p['pack']) ?? fail('pack');
  const stages = list(p['stages'], 'stages').map((candidate, index): StartHereStage => {
    const s = record(candidate) ?? fail('stage');
    if (s['id'] !== STAGE_IDS[index]) fail('stage order');
    return {
      id: STAGE_IDS[index]!,
      title: str(s['title'], 'stage.title'),
      question: str(s['question'], 'stage.question'),
      items: list(s['items'], 'stage.items').map(parseItem),
      done: count(s['done'], 'stage.done'),
      total: count(s['total'], 'stage.total'),
    };
  });
  if (stages.length !== STAGE_IDS.length) fail('five stages');
  return {
    recordId: str(p['recordId'], 'recordId'),
    personId: str(p['personId'], 'personId'),
    contact: {
      personId: str(contact['personId'], 'contact.personId'),
      name: typeof contact['name'] === 'string' ? contact['name'] : null,
    },
    scope: {
      objectId: typeof scope['objectId'] === 'string' ? scope['objectId'] : null,
      title: typeof scope['title'] === 'string' ? scope['title'] : null,
    },
    pack: {
      title: str(pack['title'], 'pack.title'),
      revision: count(pack['revision'], 'pack.revision'),
    },
    state: oneOf(
      p['state'],
      ['assigned', 'qualified', 'withdrawn', 'superseded'] as const,
      'state',
    ),
    currency: oneOf(
      p['currency'],
      ['qualified', 'qualified_with_gap', 'open', 'withdrawn', 'superseded'] as const,
      'currency',
    ),
    complete: p['complete'] === true,
    missing: strings(p['missing'], 'missing'),
    gaps: strings(p['gaps'], 'gaps'),
    blocked: strings(p['blocked'], 'blocked'),
    stages,
    digest: str(p['digest'], 'digest'),
  };
}

export function parseStartHereList(value: unknown): readonly StartHere[] {
  const body = record(value) ?? fail('list');
  if (body['format'] !== 'kf-start-here-list-v1') fail('list.format');
  return list(body['pages'], 'list.pages').map(parseStartHere);
}

export function getStartHere(caller: Caller): Promise<readonly StartHere[]> {
  return get('/start-here', caller, parseStartHereList);
}

export function getQualificationRecord(caller: Caller, recordId: string): Promise<StartHere> {
  return get(`/qualification/records/${encodeURIComponent(recordId)}`, caller, parseStartHere);
}

async function post(caller: Caller, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    method: 'POST',
    headers: callerHeaders(caller),
    body: JSON.stringify(body),
  });
  return decodeSuccessfulResponse(await parseResponse(response), (value) => ({
    actionType: String(record(value)?.['actionType'] ?? ''),
  }));
}

export function submitEvidence(
  caller: Caller,
  recordId: string,
  input: {
    readonly requirementKey: string;
    readonly evidenceObjectId: string;
    readonly note?: string;
    readonly idempotencyKey: string;
  },
) {
  return post(caller, `/qualification/records/${encodeURIComponent(recordId)}/submit`, input);
}

export function creditEvidence(
  caller: Caller,
  recordId: string,
  input: {
    readonly credits: readonly Record<string, string>[];
    readonly idempotencyKey: string;
  },
) {
  return post(caller, `/qualification/records/${encodeURIComponent(recordId)}/credit`, input);
}

export interface InvitationAnswer {
  readonly organizationId: string;
  readonly recordId: string | null;
  readonly expired: boolean;
  readonly next: string;
}

export function getInvitation(caller: Caller, token: string): Promise<InvitationAnswer> {
  return get(`/invitations/${encodeURIComponent(token)}`, caller, (value) => {
    const v = record(value) ?? fail('invitation');
    if (v['format'] !== 'kf-invitation-v1') fail('invitation.format');
    const next = str(v['next'], 'invitation.next');
    return {
      organizationId: str(v['organizationId'], 'invitation.organizationId'),
      recordId: typeof v['recordId'] === 'string' ? v['recordId'] : null,
      expired: v['expired'] === true,
      // Only ever a path on this site.
      next: /^\/[a-z-]*$/.test(next) ? next : '/start-here',
    };
  });
}

/** How a status reads: words, never colour alone (ADR 0040 decision 11). */
export function statusLabel(status: RequirementStatus): string {
  switch (status) {
    case 'satisfied':
      return 'Done';
    case 'gap_revised':
      return 'Changed since you did it';
    case 'submitted':
      return 'Submitted, waiting for a reviewer';
    case 'open':
      return 'To do';
    case 'blocked_on_organization':
      return 'Blocked on the organization';
  }
}

/** How an evidence mode reads. */
export function modeLabel(mode: StartHereItem['mode']): string {
  return mode === 'acknowledge'
    ? 'Acknowledge: received and reviewed'
    : mode === 'locate'
      ? 'Locate: know where it lives and when to use it'
      : 'Demonstrate: accepted work that shows it';
}
