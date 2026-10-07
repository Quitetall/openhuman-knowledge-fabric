/**
 * The in-app agent as the joining guide (ADR 0040 decision 12; ADR 0038 decision 10; SAS §24A,
 * §24B; KF-WAR-0007 deliverable 7).
 *
 * While the reader's own qualification record is open, every turn — a question or a request to
 * record something — carries their guide: `GET /start-here/guide` (`kf-agent-guide-context-v1`),
 * their next requirements, their named contact and the closed lists of what a guide may and may
 * not do. When they hold no open record the route answers 404 and the turn is exactly what it was
 * without this module.
 *
 * WHERE IT RIDES. The record-specific part (pack, scope, next items, contact) is ONE labelled
 * context item, so the router and the provider's egress guard (`ProviderBackend.complete`) treat it
 * as they treat any record: by its label. Only `GUIDE_RULES`, which names no record, goes into the
 * system prompt. There is no unlabelled field for the guide to ride in.
 *
 * ITS LABEL. The record's level: what the API serves, raised to `confidential` again here
 * (ADR 0038 decision 12), and `restricted` when the API serves none. `confidential` never leaves
 * the host (KF-SAS-RQ-271), so a guided turn is answered by LAMU or refused, and every later turn
 * of that conversation stays on the host through the sealed label of the answer (seal.ts).
 *
 * WHAT IT MAY DO is the guide's closed list. Its one act, `submit_qualification_evidence`, is on
 * M2's closed list (`AGENT_ACTS`) and drafts against the person's own open record only; it credits
 * nothing. Crediting and accepting are on no agent's list, the API refuses an agent's credit at the
 * route and the database refuses it again (KF-QUAL-011).
 *
 * NOT stored, like everything else a turn reads: the guide is read for the turn and forgotten.
 *
 * Not covered: what the person TYPES is not classified (KF-WAR-0006 RR-001), and the model's
 * prose is not checked against the may-not list. The rules tell it not to claim a requirement is
 * satisfied; the record, not the chat, is what says whether one is.
 */

import {
  AGENT_GUIDE_FORMAT,
  GUIDE_ACTS,
  GUIDE_CLASSIFICATION_FLOOR,
  GUIDE_MAY,
  GUIDE_MAY_NOT,
  GUIDE_RULES,
} from '@kf/qualification/agent-guide';
import type { ContextItem } from './backends.js';
import { highestOf } from './classification.js';
import { record, type FabricClient } from './fabric.js';

export { GUIDE_ACTS, GUIDE_MAY, GUIDE_MAY_NOT };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One next requirement, as much of it as the guide renders. */
export interface GuideNext {
  readonly key: string;
  readonly stage: string;
  readonly outcome: string;
  readonly mode: string;
  readonly status: string;
  readonly acceptedBy: string;
  readonly awaiting: readonly string[];
  readonly blockedOnOrganization: boolean;
  /** The resources the item names: label and authority class, never an id (prompt.ts). */
  readonly resources: readonly { readonly label: string; readonly authorityClass: string }[];
}

/** The guide as one turn holds it. */
export interface Guide {
  readonly recordId: string;
  /** The Start Here digest the guide was given: what the person sees. */
  readonly digest: string;
  readonly packTitle: string;
  readonly packRevision: number;
  readonly scopeTitle: string | null;
  readonly contactName: string | null;
  readonly next: readonly GuideNext[];
  /** The label every word of it carries: never below `confidential`. */
  readonly classification: string;
}

export type GuideRead =
  | { readonly kind: 'guide'; readonly guide: Guide }
  | { readonly kind: 'none' }
  | { readonly kind: 'unreadable' };

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/**
 * The label the guide carries: the served one, never below `confidential`, `restricted` when
 * absent or unknown. The API raises it too (`guideClassification`); this does not rely on that.
 */
export function guideLabel(served: unknown): string {
  return (
    highestOf([typeof served === 'string' ? served : 'restricted', GUIDE_CLASSIFICATION_FLOOR]) ??
    'restricted'
  );
}

/** The resources each requirement names, from the Start Here the guide was given. */
function resourcesByKey(startHere: Record<string, unknown> | undefined) {
  const found = new Map<string, GuideNext['resources']>();
  const stages = startHere?.['stages'];
  if (!Array.isArray(stages)) return found;
  for (const stage of stages) {
    const items = record(stage)?.['items'];
    if (!Array.isArray(items)) continue;
    for (const value of items) {
      const item = record(value);
      const key = text(item?.['key']);
      const resources = item?.['resources'];
      if (key === undefined || !Array.isArray(resources)) continue;
      found.set(
        key,
        resources.flatMap((r) => {
          const resource = record(r);
          const authorityClass = text(resource?.['authorityClass']);
          if (authorityClass === undefined) return [];
          return [{ label: text(resource?.['label']) ?? 'an unnamed reference', authorityClass }];
        }),
      );
    }
  }
  return found;
}

/** Parse the API's guide context. Anything malformed is `undefined`: no guide, never a partial one. */
export function parseGuide(body: unknown): Guide | undefined {
  const guide = record(body);
  if (guide?.['format'] !== AGENT_GUIDE_FORMAT) return undefined;
  const recordId = text(guide['recordId']);
  const startHere = record(guide['startHere']);
  const pack = record(startHere?.['pack']);
  const digest = text(startHere?.['digest']);
  const packTitle = text(pack?.['title']);
  const packRevision = pack?.['revision'];
  if (
    recordId === undefined ||
    !UUID.test(recordId) ||
    digest === undefined ||
    packTitle === undefined ||
    typeof packRevision !== 'number' ||
    !Array.isArray(guide['next'])
  ) {
    return undefined;
  }
  const resources = resourcesByKey(startHere);
  const next: GuideNext[] = [];
  for (const value of guide['next'] as unknown[]) {
    const item = record(value);
    const key = text(item?.['key']);
    const stage = text(item?.['stage']);
    const outcome = text(item?.['outcome']);
    if (key === undefined || stage === undefined || outcome === undefined) return undefined;
    next.push({
      key,
      stage,
      outcome,
      mode: text(item?.['mode']) ?? 'unknown',
      status: text(item?.['status']) ?? 'unknown',
      acceptedBy: text(item?.['acceptedBy']) ?? 'unknown',
      awaiting: strings(item?.['awaiting']),
      blockedOnOrganization: item?.['blockedOnOrganization'] === true,
      resources: resources.get(key) ?? [],
    });
  }
  return {
    recordId,
    digest,
    packTitle,
    packRevision,
    scopeTitle: text(record(startHere?.['scope'])?.['title']) ?? null,
    contactName: text(record(guide['contact'])?.['name']) ?? null,
    next,
    classification: guideLabel(guide['classification']),
  };
}

/**
 * The reader's guide, when their own qualification is open. 404 is "none"; any other answer, or a
 * failed call, is "unreadable" and the turn goes on without one — which sends less, never more.
 */
export async function readGuide(fabric: FabricClient): Promise<GuideRead> {
  try {
    const answer = await fabric.call('GET', '/start-here/guide');
    if (answer.status === 404) return { kind: 'none' };
    const guide = answer.status === 200 ? parseGuide(answer.body) : undefined;
    return guide === undefined ? { kind: 'unreadable' } : { kind: 'guide', guide };
  } catch {
    return { kind: 'unreadable' };
  }
}

/** The title the guide's source carries in a prompt and in the chat's list of what was read. */
export function guideTitle(guide: Guide): string {
  return `Your Start Here: ${guide.packTitle}${guide.scopeTitle === null ? '' : ` — ${guide.scopeTitle}`}`;
}

/** The guide as one numbered, LABELLED source of this turn. */
export function guideItem(n: number, guide: Guide): ContextItem {
  const lines = [
    `Start Here for ${guide.packTitle} (revision ${String(guide.packRevision)})` +
      (guide.scopeTitle === null ? '.' : `, scope ${guide.scopeTitle}.`),
    `Named contact: ${guide.contactName ?? 'not named on the record'}.`,
    guide.next.length === 0
      ? 'Nothing is open: every requirement shows satisfied.'
      : 'Open requirements, the one to work on first at the top:',
    ...guide.next.map((item, i) =>
      [
        `${String(i + 1)}. ${item.key} (${item.stage}): ${item.outcome}`,
        `   status ${item.status}; evidence mode ${item.mode}; accepted by ${item.acceptedBy}`,
        ...(item.awaiting.length === 0 ? [] : [`   do first: ${item.awaiting.join(', ')}`]),
        ...(item.blockedOnOrganization
          ? ['   blocked on the organization, not on the person: tell the named contact']
          : []),
        ...item.resources.map((r) => `   reference: ${r.label} (${r.authorityClass})`),
      ].join('\n'),
    ),
    `A guide may: ${GUIDE_MAY.join(', ')}.`,
    `A guide may not: ${GUIDE_MAY_NOT.join(', ')}.`,
    `The only act a guide may draft for the person: ${GUIDE_ACTS.join(', ')}, on this record.`,
  ];
  return {
    n,
    recordId: guide.recordId,
    revision: guide.digest,
    title: guideTitle(guide),
    classification: guide.classification,
    text: lines.join('\n'),
  };
}

/** The system prompt's guide part: rules that name no record, and where the record part is. */
export function guideSystem(n: number): string {
  return [
    GUIDE_RULES,
    `Source [${String(n)}] is the person's own Start Here: their open requirements, their named`,
    'contact, and the closed lists of what you may and may not do as their guide. Stay within',
    'those lists. To give the person a reference, name it as the source does and send them to',
    'Start Here for the link.',
  ].join('\n');
}

/** Whether the guide permits an act to be drafted, and on which record. */
export function guidePermits(act: string): boolean {
  return (GUIDE_ACTS as readonly string[]).includes(act);
}
