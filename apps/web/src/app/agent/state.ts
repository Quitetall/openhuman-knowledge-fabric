/**
 * What the chat holds: the conversation, in the page's memory and nowhere else.
 *
 * Nothing here is stored by the server (`@kf/agent` seal.ts says why). The browser keeps the
 * entries while the page is open and loses them on reload; each answer carries the seal over its
 * text and classification, so when it is sent back as context for the next turn its label cannot
 * be lowered.
 */

export interface ChatCitation {
  readonly n: number;
  readonly recordId: string;
  readonly title: string;
  readonly classification: string;
}

export interface QuestionEntry {
  readonly kind: 'question';
  readonly text: string;
}

export interface AnswerEntry {
  readonly kind: 'answer';
  readonly status: 'answered' | 'refused' | 'nothing_found';
  readonly text: string | null;
  readonly backend: { readonly kind: 'on_host' | 'provider'; readonly name: string } | null;
  readonly refusal?: { readonly rule: string; readonly message: string };
  readonly citations: readonly ChatCitation[];
  readonly consulted: readonly ChatCitation[];
  readonly withheldCount: number;
  readonly semanticRanking: boolean;
  readonly notes: readonly string[];
  readonly classification: string;
  /** The Start Here the answer was guided by, while the person's qualification is open. */
  readonly guide: { readonly recordId: string; readonly digest: string } | null;
  readonly seal: string;
}

export interface DraftFieldView {
  readonly name: string;
  readonly label: string;
  readonly kind: string;
  readonly required: boolean;
  readonly maxLength?: number;
  /** The value as the form shows it: lists joined with commas. */
  readonly value: string;
  readonly problem?: string;
}

export interface DraftEntry {
  readonly kind: 'draft';
  readonly act: string;
  readonly title: string;
  readonly description: string;
  readonly disposition: 'submit' | 'propose';
  readonly targets: 'none' | 'one';
  readonly targetKind?: string;
  readonly targetId: string;
  readonly reasonRequired: boolean;
  readonly reason: string;
  readonly fields: readonly DraftFieldView[];
  readonly problems: readonly string[];
  readonly filledBy: { readonly kind: 'on_host' | 'provider'; readonly name: string } | null;
  /** The commit gesture's key: a second click replays, never repeats. */
  readonly gestureId: string;
  readonly settled?: 'committed' | 'proposed';
}

export interface OutcomeEntry {
  readonly kind: 'outcome';
  readonly tone: 'success' | 'error' | 'neutral';
  readonly text: string;
  readonly recordIds?: readonly string[];
}

export type ChatEntry = QuestionEntry | AnswerEntry | DraftEntry | OutcomeEntry;

export interface ChatState {
  readonly entries: readonly ChatEntry[];
}

export const EMPTY_CHAT: ChatState = { entries: [] };

/** An earlier turn as the next question carries it back (@kf/agent `CarriedTurn`). */
export interface CarriedTurnView {
  readonly role: 'person' | 'agent';
  readonly text: string;
  readonly classification?: string;
  readonly seal?: string;
}

/** The earlier turns the next question carries back, as @kf/agent takes them. */
export function carriedHistory(entries: readonly ChatEntry[]): CarriedTurnView[] {
  return entries.flatMap((entry): CarriedTurnView[] => {
    if (entry.kind === 'question') return [{ role: 'person', text: entry.text }];
    if (entry.kind === 'answer' && entry.status === 'answered' && entry.text !== null) {
      return [
        { role: 'agent', text: entry.text, classification: entry.classification, seal: entry.seal },
      ];
    }
    return [];
  });
}
