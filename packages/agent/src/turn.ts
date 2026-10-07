/**
 * One chat turn: retrieve under the reader's grants, route by classification, answer, cite, count
 * what was withheld (ADR 0040 decision 7; KF-SAS-RQ-115, RQ-216, RQ-222, RQ-250, RQ-271, RQ-272).
 *
 *   1. `GET /search` for the question: the fused ranking's titles, whether semantic ranking was
 *      available (RQ-216), and `withheldCount` — how many matching records within the reader's
 *      ceiling no grant of theirs reaches (ADR 0037, RQ-222). The count the answer shows is that
 *      number, the one the search page shows for the same query.
 *   2. `POST /context-source/retrieve`, then `POST /context-source/read` for each reference: the
 *      reader's agent_context, re-checked against current authority on every call, each read
 *      recorded as a disclosure by the API (RQ-250). A missing or stale master record is compiled
 *      once, as the person's act with this agent's participation, and the retrieval retried.
 *   3. The router chooses a backend from the highest classification of the context and of every
 *      earlier answer the browser carried back (seal.ts). Above the organization's ceiling only the
 *      host's model answers; with none, the turn is refused and lists what it found.
 *   4. The answer is accepted only if every citation it makes is a source of this turn and every
 *      record id it mentions is one (prompt.ts). Otherwise it is refused, not trimmed.
 *
 * While the reader's own qualification record is open, the turn also carries their guide
 * (guide.ts): one more source, labelled at the record's level — never below confidential — so step
 * 3 keeps it on the host like any record of that label, plus the guide's rules in the system
 * prompt, which name no record. With no open record nothing here changes.
 *
 * Nothing is kept: the answer is returned, sealed, and forgotten (seal.ts says why).
 */

import {
  BackendUnavailable,
  EgressRefused,
  type ContextItem,
  type ModelRequest,
} from './backends.js';
import {
  DEFAULT_PROVIDER_CEILING,
  highestOf,
  isProviderCeiling,
  type MayLeaveHost,
  type ProviderCeiling,
} from './classification.js';
import { record, refusalRule, type ApiAnswer, type FabricClient } from './fabric.js';
import { guideItem, guideSystem, readGuide } from './guide.js';
import { checkCitations, SYSTEM_PROMPT } from './prompt.js';
import { chooseBackend, type Backends } from './router.js';
import { sealTurn, verifiedHistory, type CarriedTurn } from './seal.js';

/** How many records one turn reads at most. */
export const DEFAULT_CONTEXT_LIMIT = 8;
/** The most text one record contributes to a prompt, in characters. */
export const MAX_ITEM_CHARACTERS = 12_000;
/** The most a question may be, as the search route bounds a query. */
export const MAX_QUESTION_CHARACTERS = 512;
/** Earlier turns carried back, newest kept. */
export const MAX_HISTORY_TURNS = 12;

export interface Citation {
  readonly n: number;
  readonly recordId: string;
  readonly revision: string;
  readonly title: string;
  readonly classification: string;
}

export interface ChatAnswer {
  readonly status: 'answered' | 'refused' | 'nothing_found';
  /** The model's answer with its [n] markers, or null when there is none. */
  readonly text: string | null;
  /** The backend that produced `text` (KF-SAS-RQ-272); null when no model was asked. */
  readonly backend: { readonly kind: 'on_host' | 'provider'; readonly name: string } | null;
  readonly refusal?: { readonly rule: string; readonly message: string };
  /** The sources the answer cites. */
  readonly citations: readonly Citation[];
  /** Every record read for this turn, cited or not. */
  readonly consulted: readonly Citation[];
  /** Matching records within the reader's ceiling that no grant of theirs reaches (ADR 0037). */
  readonly withheldCount: number;
  /** False when semantic ranking was unavailable, and the answer says so (KF-SAS-RQ-216). */
  readonly semanticRanking: boolean;
  readonly notes: readonly string[];
  /** The highest classification of what produced this turn; sealed for the next one. */
  readonly classification: string;
  /**
   * The Start Here the turn was given as guide (its record and digest), or null when the reader
   * holds no open qualification record. The guide is also in `consulted`.
   */
  readonly guide: { readonly recordId: string; readonly digest: string } | null;
  readonly seal: string;
}

export interface AgentDependencies {
  readonly fabric: FabricClient;
  readonly backends: Backends;
  /** The key that seals answers carried by the browser (seal.ts). */
  readonly sealKey: Uint8Array;
  readonly limit?: number;
  /** A test seam for the router's comparison; production uses `mayLeaveHost`. */
  readonly mayLeave?: MayLeaveHost;
  /** A fresh idempotency key; random in production. */
  readonly newKey?: () => string;
}

export interface TurnInput {
  readonly question: string;
  readonly history?: readonly CarriedTurn[];
}

/**
 * What may leave the host for this organization, as the API reports it. Fails closed: anything
 * but a well-formed answer is `none`, so a broken read keeps every turn on the host.
 */
export async function providerCeiling(fabric: FabricClient): Promise<ProviderCeiling> {
  try {
    const answer = await fabric.call('GET', '/model-routing');
    const value = record(answer.body)?.['providerCeiling'];
    return answer.status === 200 && isProviderCeiling(value) ? value : 'none';
  } catch {
    return 'none';
  }
}

interface Found {
  readonly title: string;
  readonly classification: string;
}

function hitsOf(body: Record<string, unknown> | undefined): Map<string, Found> {
  const found = new Map<string, Found>();
  for (const list of ['ranked', 'semantic', 'lexical']) {
    const hits = record(body?.[list])?.['hits'];
    if (!Array.isArray(hits)) continue;
    for (const hit of hits) {
      const h = record(hit);
      const id = h?.['objectId'];
      const title = h?.['title'];
      const classification = h?.['classification'];
      if (typeof id === 'string' && typeof title === 'string' && !found.has(id)) {
        found.set(id, {
          title,
          classification: typeof classification === 'string' ? classification : 'restricted',
        });
      }
    }
  }
  return found;
}

interface SourceRef {
  readonly adapter: string;
  readonly record: string;
  readonly revision: string;
  readonly digest: string;
}

function refsOf(answer: ApiAnswer): SourceRef[] {
  const refs = record(answer.body)?.['references'];
  if (!Array.isArray(refs)) return [];
  return refs.flatMap((value) => {
    const ref = record(value);
    return ref !== undefined &&
      typeof ref['adapter'] === 'string' &&
      typeof ref['record'] === 'string' &&
      typeof ref['revision'] === 'string' &&
      typeof ref['digest'] === 'string'
      ? [ref as unknown as SourceRef]
      : [];
  });
}

const NEEDS_COMPILE: ReadonlySet<string> = new Set(['KF-CTX-004', 'KF-CTX-005']);

function citationOf(item: ContextItem): Citation {
  return {
    n: item.n,
    recordId: item.recordId,
    revision: item.revision,
    title: item.title,
    classification: item.classification,
  };
}

export async function answerTurn(deps: AgentDependencies, input: TurnInput): Promise<ChatAnswer> {
  const question = input.question.trim().slice(0, MAX_QUESTION_CHARACTERS);
  const limit = deps.limit ?? DEFAULT_CONTEXT_LIMIT;
  const newKey = deps.newKey ?? (() => `agent-${crypto.randomUUID()}`);
  const notes: string[] = [];
  const history = verifiedHistory(deps.sealKey, (input.history ?? []).slice(-MAX_HISTORY_TURNS));

  // 1. Search: titles, the semantic ranking's availability, and what was withheld.
  const search = await deps.fabric.call('GET', '/search', {
    query: { q: question, limit: String(limit) },
  });
  const searchBody = search.status === 200 ? record(search.body) : undefined;
  const withheldCount =
    typeof searchBody?.['withheldCount'] === 'number' ? searchBody['withheldCount'] : 0;
  const found = hitsOf(searchBody);
  let semanticRanking = searchBody?.['semantic'] !== undefined;
  if (search.status !== 200) notes.push('Search could not be read for this question.');

  // 2. The context source: references, then each one's text under current authority.
  let compiled = false;
  const compile = async (): Promise<boolean> => {
    if (compiled) return false;
    compiled = true;
    const result = await deps.fabric.call('POST', '/master-record/compile', {
      body: {
        idempotencyKey: newKey(),
        reason: 'compiled so the in-app agent can read for its person',
      },
    });
    return result.status === 200 || result.status === 201;
  };

  let context: ContextItem[] = [];
  let unreadable = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    context = [];
    unreadable = 0;
    const retrieved = await deps.fabric.call('POST', '/context-source/retrieve', {
      body: { query: question, limit },
    });
    const rule = refusalRule(retrieved);
    if (retrieved.status !== 200) {
      if (rule !== undefined && NEEDS_COMPILE.has(rule) && (await compile())) continue;
      if (rule === 'KF-CTX-006') semanticRanking = false;
      else notes.push('The context source could not retrieve for this question.');
      break;
    }
    let stale = false;
    for (const ref of refsOf(retrieved)) {
      const read = await deps.fabric.call('POST', '/context-source/read', { body: ref });
      const body = record(read.body);
      if (read.status === 200 && typeof body?.['text'] === 'string') {
        const text = body['text'];
        context.push({
          n: context.length + 1,
          recordId: ref.record,
          revision: ref.revision,
          title: found.get(ref.record)?.title ?? 'Untitled record',
          // The record's own label, as the context source served it. Absent means unknown, and
          // unknown is treated as the highest.
          classification:
            typeof body['classification'] === 'string' ? body['classification'] : 'restricted',
          text:
            text.length > MAX_ITEM_CHARACTERS
              ? `${text.slice(0, MAX_ITEM_CHARACTERS)}\n… (shortened for this answer)`
              : text,
        });
      } else if (NEEDS_COMPILE.has(refusalRule(read) ?? '')) {
        stale = true;
        break;
      } else {
        unreadable += 1;
      }
    }
    if (stale && (await compile())) continue;
    break;
  }
  if (!semanticRanking) {
    notes.push(
      'Semantic ranking was unavailable, so no record was found by meaning for this answer ' +
        '(KF-SAS-RQ-216).',
    );
  }
  if (unreadable > 0) {
    notes.push(
      `${String(unreadable)} record(s) matched but could not be read now (moved, revised or no ` +
        'longer yours to read), and were left out.',
    );
  }

  // The guide, while the reader's own qualification is open: one more labelled source.
  const guideRead = await readGuide(deps.fabric);
  const guide = guideRead.kind === 'guide' ? guideRead.guide : undefined;
  if (guideRead.kind === 'unreadable') {
    notes.push(
      'Your Start Here could not be read for this answer, so it was not given to the agent.',
    );
  }
  if (guide !== undefined) context.push(guideItem(context.length + 1, guide));

  const consulted = context.map(citationOf);
  const classification =
    highestOf([
      ...context.map((item) => item.classification),
      ...history.filter((t) => t.role === 'agent').map((t) => t.classification ?? 'restricted'),
    ]) ?? 'public';
  const finish = (
    answer: Omit<
      ChatAnswer,
      | 'classification'
      | 'seal'
      | 'withheldCount'
      | 'semanticRanking'
      | 'notes'
      | 'consulted'
      | 'guide'
    >,
  ): ChatAnswer => {
    const text = answer.text ?? '';
    return {
      ...answer,
      consulted,
      withheldCount,
      semanticRanking,
      notes,
      classification,
      guide: guide === undefined ? null : { recordId: guide.recordId, digest: guide.digest },
      seal: sealTurn(deps.sealKey, text, classification),
    };
  };

  if (context.length === 0 && history.length === 0) {
    return finish({
      status: 'nothing_found',
      text: null,
      backend: null,
      citations: [],
    });
  }

  // 3. Route by the highest classification the turn carries.
  const ceiling = await providerCeiling(deps.fabric).catch(() => DEFAULT_PROVIDER_CEILING);
  const decision = chooseBackend(
    [
      ...context.map((item) => item.classification),
      ...history.filter((t) => t.role === 'agent').map((t) => t.classification ?? 'restricted'),
    ],
    ceiling,
    deps.backends,
    deps.mayLeave,
  );
  if ('refused' in decision) {
    return finish({
      status: 'refused',
      text: null,
      backend: null,
      refusal: { rule: decision.refused, message: decision.message },
      citations: [],
    });
  }

  const request: ModelRequest = {
    system:
      guide === undefined ? SYSTEM_PROMPT : `${SYSTEM_PROMPT}\n\n${guideSystem(context.length)}`,
    history,
    context,
    question,
    maxTokens: 2_048,
  };
  let text: string;
  try {
    text = (await decision.backend.complete(request)).text;
  } catch (error: unknown) {
    if (error instanceof EgressRefused) {
      return finish({
        status: 'refused',
        text: null,
        backend: null,
        refusal: { rule: error.rule, message: error.message },
        citations: [],
      });
    }
    if (error instanceof BackendUnavailable) {
      // Never another backend instead: a provider is not a fallback for the host (RQ-271), and
      // a second provider attempt is not what the person was told would answer.
      return finish({
        status: 'refused',
        text: null,
        backend: { kind: decision.backend.kind, name: decision.backend.name },
        refusal: {
          rule: 'KF-CHAT-001',
          message: `KF-CHAT-001: ${error.backend} could not answer: ${error.message}. Nothing was sent elsewhere.`,
        },
        citations: [],
      });
    }
    throw error;
  }

  // 4. Every citation must be a source of this turn.
  const check = checkCitations(text, context);
  if (check.unknownNumbers.length > 0 || check.unknownIds.length > 0) {
    return finish({
      status: 'refused',
      text: null,
      backend: { kind: decision.backend.kind, name: decision.backend.name },
      refusal: {
        rule: 'KF-CHAT-002',
        message:
          'KF-CHAT-002: the answer cited a source that was not given to it for this turn, so it is ' +
          'not shown. The records actually read are listed below.',
      },
      citations: [],
    });
  }
  return finish({
    status: 'answered',
    text,
    backend: { kind: decision.backend.kind, name: decision.backend.name },
    citations: check.cited.map((n) => citationOf(context[n - 1]!)),
  });
}
