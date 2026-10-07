'use server';

import { randomUUID } from 'node:crypto';
import {
  answerTurn,
  asksToRecord,
  draftFromRequest,
  providerCeiling,
  submitDraft,
  type FabricClient,
} from '@kf/agent';
import { AGENT_ACTS, agentAct } from '@kf/domain';
import { webCaller } from '../../lib/session';
import { backendsFor, loadAgentConfig, sealKey } from '../../lib/agent/config';
import { DelegationUnavailable, exchangeForAgent, fabricClient } from '../../lib/agent/fabric';
import {
  carriedHistory,
  type ChatEntry,
  type ChatState,
  type DraftEntry,
  type DraftFieldView,
  type OutcomeEntry,
} from './state';

/**
 * The chat's two gestures (ADR 0040 decision 7). Each runs on the server, as the signed-in person,
 * through the in-app agent's exchanged token; the API decides everything; nothing is kept.
 *
 *   ask     a question → an answer that names its backend, cites and counts what was withheld;
 *           a request to record something → the real form of one act, filled, not yet written.
 *   commit  the form as the person left it → ONE act: submitted unverified, or, for an
 *           institutional act, proposed into their Needs you and not performed.
 */

const MAX_ENTRIES = 40;

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function appended(previous: ChatState, ...entries: ChatEntry[]): ChatState {
  return { entries: [...previous.entries, ...entries].slice(-MAX_ENTRIES) };
}

/** The agent's view of the Fabric, and whether it holds an agent identity for writing. */
async function agentFabric(
  returnTo: string,
): Promise<{ fabric: FabricClient; delegated: boolean; why?: string }> {
  const caller = await webCaller(returnTo);
  const config = loadAgentConfig();
  try {
    const bearer = await exchangeForAgent(caller, config);
    return { fabric: fabricClient(caller, bearer), delegated: true };
  } catch (error: unknown) {
    if (error instanceof DelegationUnavailable) {
      // Reads are the person's own and are recorded as theirs; writing waits for an identity.
      return { fabric: fabricClient(caller, undefined), delegated: false, why: error.message };
    }
    throw error;
  }
}

function fieldValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(String).join(', ');
  return String(value);
}

async function ask(previous: ChatState, form: FormData): Promise<ChatState> {
  const question = text(form, 'question').slice(0, 2000);
  const returnTo = text(form, 'returnTo') || '/agent';
  if (question === '') return previous;
  const { fabric, delegated, why } = await agentFabric(returnTo);
  const config = loadAgentConfig();
  const ceiling = () => providerCeiling(fabric);
  const backends = backendsFor(config, ceiling);

  if (asksToRecord(question)) {
    const outcome = await draftFromRequest(backends, await ceiling(), question);
    const draft: DraftEntry = {
      kind: 'draft',
      act: outcome.act.act,
      title: outcome.act.title,
      description: outcome.act.description,
      disposition: outcome.act.disposition,
      targets: outcome.act.targets,
      ...(outcome.act.targetKind === undefined ? {} : { targetKind: outcome.act.targetKind }),
      targetId: outcome.draft.targetIds[0] ?? '',
      reasonRequired: outcome.act.reasonRequired,
      reason: outcome.draft.reason ?? '',
      fields: outcome.draft.fields.map((field): DraftFieldView => {
        const declared = outcome.act.fields.find((f) => f.name === field.name)!;
        return {
          name: field.name,
          label: field.label,
          kind: declared.kind,
          required: field.required,
          ...(declared.maxLength === undefined ? {} : { maxLength: declared.maxLength }),
          value: fieldValue(field.value),
          ...(field.problem === undefined ? {} : { problem: field.problem }),
        };
      }),
      problems: outcome.draft.problems,
      filledBy: outcome.filledBy,
      gestureId: randomUUID(),
    };
    const notice: OutcomeEntry[] = delegated
      ? []
      : [
          {
            kind: 'outcome',
            tone: 'neutral',
            text: `This draft cannot be committed from chat here: ${why ?? 'no agent identity'}. Use the capture form instead.`,
          },
        ];
    return appended(previous, { kind: 'question', text: question }, draft, ...notice);
  }

  const answer = await answerTurn(
    { fabric, backends, sealKey: sealKey() },
    { question, history: carriedHistory(previous.entries) },
  );
  return appended(
    previous,
    { kind: 'question', text: question },
    {
      kind: 'answer',
      status: answer.status,
      text: answer.text,
      backend: answer.backend,
      ...(answer.refusal === undefined ? {} : { refusal: answer.refusal }),
      citations: answer.citations.map(({ n, recordId, title, classification }) => ({
        n,
        recordId,
        title,
        classification,
      })),
      consulted: answer.consulted.map(({ n, recordId, title, classification }) => ({
        n,
        recordId,
        title,
        classification,
      })),
      withheldCount: answer.withheldCount,
      semanticRanking: answer.semanticRanking,
      notes: delegated ? answer.notes : [...answer.notes, `Read as you: ${why ?? ''}`.trim()],
      classification: answer.classification,
      seal: answer.seal,
    },
  );
}

/** The form's fields as the act takes them: lists split on commas, empty left out. */
function fieldsFromForm(act: string, form: FormData): Record<string, unknown> {
  const entry = agentAct(act);
  const fields: Record<string, unknown> = {};
  for (const field of entry?.fields ?? []) {
    const raw = text(form, `field:${field.name}`);
    if (raw === '') continue;
    fields[field.name] =
      field.kind === 'uuid_list' || field.kind === 'text_list'
        ? raw
            .split(',')
            .map((value) => value.trim())
            .filter((value) => value !== '')
        : raw;
  }
  return fields;
}

async function commit(previous: ChatState, form: FormData): Promise<ChatState> {
  const act = text(form, 'act');
  const gestureId = text(form, 'gestureId');
  const returnTo = text(form, 'returnTo') || '/agent';
  if (!AGENT_ACTS.some((entry) => entry.act === act) || gestureId.length < 8) return previous;
  const { fabric, delegated, why } = await agentFabric(returnTo);
  if (!delegated) {
    return appended(previous, {
      kind: 'outcome',
      tone: 'error',
      text: `Not committed: ${why ?? 'the in-app agent has no identity here'}. Nothing was written.`,
    });
  }
  const targetId = text(form, 'targetId');
  const reason = text(form, 'reason');
  const outcome = await submitDraft(fabric, {
    act,
    ...(targetId === '' ? {} : { targetIds: [targetId] }),
    fields: fieldsFromForm(act, form),
    ...(reason === '' ? {} : { reason }),
    idempotencyKey: `chat-${gestureId}`,
  });
  const settle = (settled: 'committed' | 'proposed'): ChatEntry[] =>
    previous.entries.map((entry) =>
      entry.kind === 'draft' && entry.gestureId === gestureId ? { ...entry, settled } : entry,
    );
  if (outcome.disposition === 'submitted') {
    return {
      entries: [
        ...settle('committed'),
        {
          kind: 'outcome' as const,
          tone: 'success' as const,
          text:
            'Recorded as your act, with the in-app agent’s participation. It is unverified until ' +
            'someone with authority verifies it.',
          recordIds: outcome.recordIds,
        },
      ].slice(-MAX_ENTRIES),
    };
  }
  if (outcome.disposition === 'proposed') {
    return {
      entries: [
        ...settle('proposed'),
        {
          kind: 'outcome' as const,
          tone: 'neutral' as const,
          text: `${act} is an institutional act, so it was proposed, not performed. It waits in your Needs you; only you can perform it there.`,
        },
      ].slice(-MAX_ENTRIES),
    };
  }
  return appended(previous, {
    kind: 'outcome',
    tone: 'error',
    text: `Not committed: ${outcome.message}${
      outcome.problems === undefined ? '' : ` (${outcome.problems.join('; ')})`
    }. Nothing was written.`,
  });
}

/** The chat's one server action: both gestures share the conversation as its state. */
export async function chat(previous: ChatState, form: FormData): Promise<ChatState> {
  return text(form, 'intent') === 'commit' ? commit(previous, form) : ask(previous, form);
}
