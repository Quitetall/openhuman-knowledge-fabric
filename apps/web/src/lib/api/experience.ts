/**
 * The experience's reads (ADR 0040; SAS §24B): the dashboard and the master document.
 *
 * The web application renders what these return and decides nothing about scope. Which panels
 * exist, in what order, and what is inside them is the API's answer for the signed-in reader
 * (`GET /dashboard`, kf-dashboard-v1): nothing here, and nothing that renders it, reads a role or
 * a job title (KF-SAS-RQ-262). Parsing fails closed: a body that does not match the contract is a
 * 502 `invalid_api_response`, never a page guessed from part of it. Verification labels go through
 * `parseVerification`, which can only ever read a record as less checked than claimed.
 */

import { randomUUID } from 'node:crypto';
import {
  apiBaseUrl,
  callerHeaders,
  decodeSuccessfulResponse,
  get,
  parseResponse,
  type Caller,
} from './client';
import { nonNegativeInteger, record } from './validation';
import { parseVerification, type Verification } from './verification';

export const DASHBOARD_PANELS = [
  'overview',
  'master_document',
  'needs_you',
  'work_in_flight',
  'recent_record',
  'people',
] as const;
export type DashboardPanelId = (typeof DASHBOARD_PANELS)[number];

export interface OverviewStatement {
  readonly objectId: string;
  readonly objectType: string;
  readonly title: string;
  readonly lifecycleState: string | null;
  readonly verification: Verification;
  readonly text: string;
}

export interface OverviewSection {
  readonly id: string;
  readonly title: string;
  readonly statements: readonly OverviewStatement[];
  /** How many statements the section has in all, when `statements` is its leading part. */
  readonly total: number;
}

export interface OverviewReading {
  readonly overviewId: string;
  readonly title: string;
  readonly verification: Verification;
  readonly sections: readonly OverviewSection[];
  readonly withheld: number;
  readonly statementCount: number;
  readonly corpusMemberCount: number;
  readonly projectionDigest: string;
}

export interface RecordLine {
  readonly id: string;
  readonly objectType: string;
  readonly title: string;
  readonly lifecycleState: string;
  readonly updatedAt?: string;
  readonly verification: Verification;
}

export type ClaimHeader =
  | { readonly status: 'missing' }
  | {
      readonly status: 'compiled';
      readonly id: string;
      readonly compiledAt: string;
      readonly corpusDigest: string;
      readonly memberCount: number;
      readonly currency: 'current' | 'unknown';
    };

export interface HeldAssignment {
  readonly assignmentId: string;
  readonly roleId: string;
  readonly organizationWide: boolean;
  readonly validTo: string | null;
  readonly reaches: readonly (readonly string[])[];
}

export type DashboardPanel =
  | { readonly id: 'overview'; readonly empty: boolean; readonly overview?: OverviewReading }
  | { readonly id: 'master_document'; readonly empty: false; readonly claim: ClaimHeader }
  | { readonly id: 'needs_you'; readonly slot: 'needs-you' }
  | {
      readonly id: 'work_in_flight' | 'recent_record';
      readonly empty: boolean;
      readonly total: number;
      readonly records: readonly RecordLine[];
    }
  | {
      readonly id: 'people';
      readonly empty: boolean;
      readonly assignments: readonly HeldAssignment[];
      readonly presetGrants: number;
    };

export interface Dashboard {
  readonly layout: readonly DashboardPanelId[];
  readonly panels: readonly DashboardPanel[];
}

export interface MasterDocumentSection {
  readonly objectType: string;
  readonly title: string;
  readonly count: number;
  readonly items: readonly RecordLine[];
  readonly noLongerInScope: number;
  readonly next: string | null;
}

export interface MasterDocument {
  readonly claim: ClaimHeader;
  readonly overview: OverviewReading | null;
  readonly sections: readonly MasterDocumentSection[];
}

class ContractViolation extends Error {}

function fail(what: string): never {
  throw new ContractViolation(what);
}

function str(value: unknown, what: string): string {
  return typeof value === 'string' && value !== '' ? value : fail(what);
}

function list(value: unknown, what: string): readonly unknown[] {
  return Array.isArray(value) ? value : fail(what);
}

function count(value: unknown, what: string): number {
  return nonNegativeInteger(value) ? value : fail(what);
}

function parseStatement(value: unknown): OverviewStatement {
  const s = record(value) ?? fail('statement');
  return {
    objectId: str(s['objectId'], 'statement.objectId'),
    objectType: str(s['objectType'], 'statement.objectType'),
    title: str(s['title'], 'statement.title'),
    lifecycleState: typeof s['lifecycleState'] === 'string' ? s['lifecycleState'] : null,
    verification: parseVerification(s['verification']),
    text: str(s['text'], 'statement.text'),
  };
}

export function parseOverview(value: unknown): OverviewReading {
  const o = record(value) ?? fail('overview');
  if (o['status'] !== 'ready') fail('overview.status');
  const head = record(o['overview']) ?? fail('overview.overview');
  const projection = record(o['projection']) ?? fail('overview.projection');
  return {
    overviewId: str(head['id'], 'overview.id'),
    title: str(head['title'], 'overview.title'),
    verification: parseVerification(head['verification']),
    sections: list(o['sections'], 'overview.sections').map((candidate) => {
      const section = record(candidate) ?? fail('section');
      const statements = list(section['statements'], 'section.statements').map(parseStatement);
      return {
        id: str(section['id'], 'section.id'),
        title: str(section['title'], 'section.title'),
        statements,
        total:
          section['total'] === undefined ? statements.length : count(section['total'], 'total'),
      };
    }),
    withheld: count(o['withheld'], 'overview.withheld'),
    statementCount: count(o['statementCount'], 'overview.statementCount'),
    corpusMemberCount: count(o['corpusMemberCount'], 'overview.corpusMemberCount'),
    projectionDigest: str(projection['projectionDigest'], 'overview.projectionDigest'),
  };
}

function parseRecordLine(value: unknown): RecordLine {
  const r = record(value) ?? fail('record');
  const id = r['id'] ?? r['objectId'];
  return {
    id: str(id, 'record.id'),
    objectType: str(r['objectType'], 'record.objectType'),
    title: str(r['title'], 'record.title'),
    lifecycleState: str(r['lifecycleState'], 'record.lifecycleState'),
    ...(typeof r['updatedAt'] === 'string' ? { updatedAt: r['updatedAt'] } : {}),
    verification: parseVerification(r['verification']),
  };
}

function parseClaim(value: unknown): ClaimHeader {
  const c = record(value) ?? fail('claim');
  if (c['status'] === 'missing') return { status: 'missing' };
  if (c['status'] !== 'compiled') fail('claim.status');
  const currency = c['currency'];
  if (currency !== 'current' && currency !== 'unknown') fail('claim.currency');
  return {
    status: 'compiled',
    id: str(c['id'], 'claim.id'),
    compiledAt: str(c['compiledAt'], 'claim.compiledAt'),
    corpusDigest: str(c['corpusDigest'], 'claim.corpusDigest'),
    memberCount: count(c['memberCount'], 'claim.memberCount'),
    currency,
  };
}

function parsePanel(value: unknown, expected: DashboardPanelId): DashboardPanel {
  const p = record(value) ?? fail('panel');
  if (p['id'] !== expected) fail(`panel order: expected ${expected}`);
  const empty = p['empty'] === true;
  switch (expected) {
    case 'overview':
      return empty || p['overview'] === undefined
        ? { id: 'overview', empty: true }
        : { id: 'overview', empty: false, overview: parseOverview(p['overview']) };
    case 'master_document':
      return { id: 'master_document', empty: false, claim: parseClaim(p['claim']) };
    case 'needs_you':
      return { id: 'needs_you', slot: 'needs-you' };
    case 'work_in_flight':
    case 'recent_record':
      return {
        id: expected,
        empty,
        total: count(p['total'], 'panel.total'),
        records: list(p['records'], 'panel.records').map(parseRecordLine),
      };
    case 'people':
      return {
        id: 'people',
        empty,
        presetGrants: count(p['presetGrants'], 'people.presetGrants'),
        assignments: list(p['assignments'], 'people.assignments').map((candidate) => {
          const a = record(candidate) ?? fail('assignment');
          return {
            assignmentId: str(a['assignmentId'], 'assignment.id'),
            roleId: str(a['roleId'], 'assignment.roleId'),
            organizationWide: a['organizationWide'] === true,
            validTo: typeof a['validTo'] === 'string' ? a['validTo'] : null,
            reaches: list(a['reaches'], 'assignment.reaches').map((path) =>
              list(path, 'path').map((role) => str(role, 'path.role')),
            ),
          };
        }),
      };
  }
}

/** kf-dashboard-v1. The layout must be exactly the declared one, and the panels in its order. */
export function parseDashboard(value: unknown): Dashboard {
  const body = record(value) ?? fail('dashboard');
  if (body['format'] !== 'kf-dashboard-v1') fail('dashboard.format');
  const layout = list(body['layout'], 'dashboard.layout');
  if (layout.join() !== DASHBOARD_PANELS.join()) fail('dashboard.layout');
  const panels = list(body['panels'], 'dashboard.panels');
  if (panels.length !== DASHBOARD_PANELS.length) fail('dashboard.panels');
  return {
    layout: DASHBOARD_PANELS,
    panels: DASHBOARD_PANELS.map((id, index) => parsePanel(panels[index], id)),
  };
}

/** kf-master-document-v1. */
export function parseMasterDocument(value: unknown): MasterDocument {
  const body = record(value) ?? fail('master document');
  if (body['format'] !== 'kf-master-document-v1') fail('master document.format');
  return {
    claim: parseClaim(body['claim']),
    overview:
      body['overview'] === null || body['overview'] === undefined
        ? null
        : parseOverview({ status: 'ready', ...(record(body['overview']) ?? {}) }),
    sections: list(body['sections'], 'sections').map((candidate) => {
      const s = record(candidate) ?? fail('section');
      return {
        objectType: str(s['objectType'], 'section.objectType'),
        title: str(s['title'], 'section.title'),
        count: count(s['count'], 'section.count'),
        items: list(s['items'], 'section.items').map(parseRecordLine),
        noLongerInScope: count(s['noLongerInScope'], 'section.noLongerInScope'),
        next: typeof s['next'] === 'string' ? s['next'] : null,
      };
    }),
  };
}

export function getDashboard(caller: Caller): Promise<Dashboard> {
  return get('/dashboard', caller, parseDashboard);
}

export function getMasterDocument(
  caller: Caller,
  page: { readonly type?: string; readonly after?: string } = {},
): Promise<MasterDocument> {
  const query = new URLSearchParams();
  if (page.type !== undefined) query.set('type', page.type);
  if (page.after !== undefined) query.set('after', page.after);
  if (page.type !== undefined) query.set('limit', '50');
  const suffix = query.size === 0 ? '' : `?${query.toString()}`;
  return get(`/master-document${suffix}`, caller, parseMasterDocument);
}

/**
 * Compile the reader's master record: an act, `POST /master-record/compile`, recorded as the
 * person. The idempotency key is formed once per rendered page, so a double submit replays.
 */
export async function compileMasterRecord(
  caller: Caller,
  idempotencyKey: string = `web-compile-${randomUUID()}`,
): Promise<{ readonly reused: boolean }> {
  const response = await fetch(`${apiBaseUrl()}/master-record/compile`, {
    method: 'POST',
    headers: callerHeaders(caller),
    body: JSON.stringify({ idempotencyKey }),
  });
  return decodeSuccessfulResponse(await parseResponse(response), (body) => ({
    reused: record(body)?.['reused'] === true,
  }));
}

/** A record's type as a reader says it: `decision_record` is "decision record". */
export function typeLabel(objectType: string): string {
  return objectType.replace(/_/g, ' ');
}

/** A state as a reader says it. */
export function stateLabel(state: string | null): string {
  return state === null ? '' : state.replace(/_/g, ' ');
}
