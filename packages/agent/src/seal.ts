/**
 * The conversation is kept by the person's browser and nowhere else, so its labels are sealed.
 *
 * WHY NOTHING IS STORED (KF-WAR-0006 work order; ADR 0040). A chat answer is a projection of
 * records the reader may read NOW. Stored, it becomes a copy of record text outside the record —
 * with its own retention, its own export and backup exposure, and the grant-withdrawal problem the
 * context source exists to avoid (a withdrawn grant would leave the answer quoting the record).
 * What a turn disclosed is already recorded where disclosures are recorded: each context read in
 * `search.context_disclosure` and each query in `search.recorded_query`, both transient (§64B).
 * So the server keeps no question, no answer and no conversation; the page holds it in memory and
 * loses it on reload.
 *
 * WHY A SEAL. A follow-up turn carries the earlier answers back as context, and an earlier answer
 * drawn from a restricted record is restricted content (KF-WAR-0006, "a follow-up turn whose
 * context carries an earlier restricted answer"). The browser could drop or lower that label, so
 * each answer is returned with an HMAC over its text and its classification, keyed by a secret the
 * browser never sees. An earlier answer whose seal does not verify — edited, relabelled, forged, or
 * sealed under a key since rotated — is treated as `restricted`. Lowering a label can only ever
 * keep a conversation on the host.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ConversationTurn } from './backends.js';

const FORMAT = 'kf-agent-turn-seal-v1';

/** An earlier turn as the browser sends it back. */
export interface CarriedTurn {
  readonly role: 'person' | 'agent';
  readonly text: string;
  /** For an agent turn: the label it was sealed with. */
  readonly classification?: string;
  readonly seal?: string;
}

/** The MAC over the tagged format, the label and the text itself, in that order. */
function mac(key: Uint8Array, text: string, classification: string): Buffer {
  return createHmac('sha256', key).update(`${FORMAT}\n${classification}\n${text}`, 'utf8').digest();
}

export function sealTurn(key: Uint8Array, text: string, classification: string): string {
  return mac(key, text, classification).toString('base64url');
}

/** The label an earlier agent turn may be trusted to carry: its own when sealed, else restricted. */
export function verifiedClassification(key: Uint8Array, turn: CarriedTurn): string {
  if (turn.classification === undefined || turn.seal === undefined) return 'restricted';
  let presented: Buffer;
  try {
    presented = Buffer.from(turn.seal, 'base64url');
  } catch {
    return 'restricted';
  }
  const expected = mac(key, turn.text, turn.classification);
  return presented.length === expected.length && timingSafeEqual(presented, expected)
    ? turn.classification
    : 'restricted';
}

/** The conversation as the model may be given it, every agent turn's label verified. */
export function verifiedHistory(
  key: Uint8Array,
  turns: readonly CarriedTurn[],
): ConversationTurn[] {
  return turns.map((turn) =>
    turn.role === 'person'
      ? { role: 'person', text: turn.text }
      : { role: 'agent', text: turn.text, classification: verifiedClassification(key, turn) },
  );
}
