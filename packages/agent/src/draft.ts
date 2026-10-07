/**
 * The agent fills the real form; the person commits it (ADR 0040 decision 7, KF-SAS-RQ-266).
 *
 * Asked to record something, the agent chooses ONE act from M2's closed list (`AGENT_ACTS` in
 * @kf/domain) and fills that act's fields — the same fields, labels and limits a person filling the
 * form sees, because `draftAgentAct` is the one function that builds both. Nothing is written by
 * drafting. The person sees the fields, may change any of them, and commits with one gesture
 * (`submitDraft`); an institutional act is proposed into their Needs you instead, never performed.
 *
 * Which model fills the form. The request is the person's own words and the act catalog, with no
 * record content, so ADR 0040's routing would allow a provider. The drafter still prefers the host:
 * what a person dictates for the record is about to BECOME a record, of a classification it does
 * not have yet (KF-WAR-0006 RR-001). With no model at all it fills an observation from the words
 * as typed, which is a draft like any other.
 *
 * As the joining guide (guide.ts). The guide's one act, `submit_qualification_evidence`, is offered
 * only while the person's own qualification record is open, and only on that record: the draft's
 * target is the guide's record whatever the model says. The guide travels as a labelled source
 * (`confidential` at least), so only the host's model fills such a form; with none on the host the
 * form is filled from the words as typed, and nothing is sent to a provider. Crediting and
 * accepting are on no agent's list, so no reply can draft them: a reply naming one falls back to an
 * observation, as any act off the list does.
 */

import {
  AGENT_ACT_NAMES,
  AGENT_ACTS,
  agentAct,
  draftAgentAct,
  type AgentAct,
  type AgentDraft,
} from '@kf/domain';
import { BackendUnavailable, EgressRefused, type ModelBackend } from './backends.js';
import { record } from './fabric.js';
import type { ProviderCeiling } from './classification.js';
import type { Backends } from './router.js';
import { GUIDE_ACTS, guideItem, type Guide } from './guide.js';

/** Whether the person is asking to record something rather than asking a question. */
export function asksToRecord(text: string): boolean {
  return /^\s*(please\s+)?(record|log|note|capture|draft|propose|withdraw|promote|accept|reject|file)\b/iu.test(
    text,
  );
}

const DRAFT_SYSTEM = [
  'You fill in one form for a person, choosing the form from this closed list. Reply with ONE JSON',
  'object and nothing else: {"act": <act name>, "targetIds": [<record id>] or [], "fields":',
  '{<field name>: <value>}, "reason": <text or null>}. Use only the field names listed for the act;',
  'leave out a field you cannot fill from what the person said. Never invent record ids: use one only',
  'if the person gave it. Prefer record_observation when the person is noting something that',
  'happened.',
].join(' ');

/** The acts offered: the guide's only while a guide is given. */
function offered(guide: Guide | undefined): readonly AgentAct[] {
  return guide === undefined
    ? AGENT_ACTS.filter((act) => !(GUIDE_ACTS as readonly string[]).includes(act.act))
    : AGENT_ACTS;
}

function catalog(guide: Guide | undefined): string {
  return offered(guide)
    .map(
      (act) =>
        `- ${act.act} (${act.title}; ${act.targets === 'one' ? `acts on one ${act.targetKind ?? 'record'}` : 'creates a record'}` +
        `${act.reasonRequired ? '; needs a reason' : ''}): fields ${
          act.fields.length === 0
            ? 'none'
            : act.fields
                .map(
                  (field) => `${field.name} (${field.kind}${field.required ? ', required' : ''})`,
                )
                .join(', ')
        }`,
    )
    .join('\n');
}

/** The words after the verb: "record that the rail sagged" → "the rail sagged". */
export function strippedRequest(text: string): string {
  const stripped = text
    .trim()
    .replace(
      /^(please\s+)?(record|log|note|capture|file)\b\s*(that|an observation|this)?\s*:?\s*/iu,
      '',
    )
    .trim();
  return stripped === '' ? text.trim() : stripped;
}

export interface DraftOutcome {
  readonly act: AgentAct;
  readonly draft: AgentDraft;
  /** The model that filled it, or null when it was filled from the words as typed. */
  readonly filledBy: { readonly kind: 'on_host' | 'provider'; readonly name: string } | null;
}

function firstJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return record(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return undefined;
  }
}

function observationDraft(text: string): DraftOutcome {
  const act = agentAct('record_observation')!;
  return {
    act,
    draft: draftAgentAct(act, { fields: { body: strippedRequest(text) } }),
    filledBy: null,
  };
}

/** The model a drafter asks: the host's when there is one; a provider only if anything may leave. */
function drafter(backends: Backends, ceiling: ProviderCeiling): ModelBackend | undefined {
  return backends.onHost ?? (ceiling === 'none' ? undefined : backends.provider);
}

/** What the drafter is told about the guide: nothing from the record, which is source [1]. */
function guideDraftSystem(): string {
  return [
    'The person is qualifying, and source [1] is their own Start Here. To name a record as evidence',
    `for one of their requirements, use ${GUIDE_ACTS.join(', ')}: take requirement_key from the keys`,
    'in source [1], leave targetIds empty (it is always their own record), and never credit, accept',
    'or mark anything satisfied: no form here does.',
  ].join(' ');
}

export async function draftFromRequest(
  backends: Backends,
  ceiling: ProviderCeiling,
  text: string,
  guide?: Guide,
): Promise<DraftOutcome> {
  // A guide is confidential at least, so only the host's model may read it (guide.ts).
  const backend = guide === undefined ? drafter(backends, ceiling) : backends.onHost;
  if (backend === undefined) return observationDraft(text);
  let reply: string;
  try {
    reply = (
      await backend.complete({
        system:
          `${DRAFT_SYSTEM}\n\nThe forms:\n${catalog(guide)}` +
          (guide === undefined ? '' : `\n\n${guideDraftSystem()}`),
        history: [],
        context: guide === undefined ? [] : [guideItem(1, guide)],
        question: text,
        maxTokens: 1_024,
      })
    ).text;
  } catch (error: unknown) {
    if (error instanceof BackendUnavailable || error instanceof EgressRefused) {
      return observationDraft(text);
    }
    throw error;
  }
  const proposed = firstJsonObject(reply);
  const name = proposed?.['act'];
  if (
    typeof name !== 'string' ||
    !AGENT_ACT_NAMES.includes(name) ||
    !offered(guide).some((entry) => entry.act === name)
  ) {
    return observationDraft(text);
  }
  const act = agentAct(name)!;
  const fields = record(proposed?.['fields']) ?? {};
  // The guide's act is on the person's own open record and no other.
  const targetIds =
    guide !== undefined && (GUIDE_ACTS as readonly string[]).includes(act.act)
      ? [guide.recordId]
      : Array.isArray(proposed?.['targetIds'])
        ? (proposed['targetIds'] as unknown[]).filter((id): id is string => typeof id === 'string')
        : [];
  const reason = proposed?.['reason'];
  return {
    act,
    draft: draftAgentAct(act, {
      fields,
      targetIds,
      ...(typeof reason === 'string' ? { reason } : {}),
    }),
    filledBy: { kind: backend.kind, name: backend.name },
  };
}
