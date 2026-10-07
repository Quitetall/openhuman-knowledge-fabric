/**
 * The two kinds of model, and the one place content leaves the host (ADR 0040 decision 8,
 * KF-SAS-RQ-271).
 *
 * Every model call is a `ModelRequest`, and every piece of record content in one is LABELLED: a
 * context item carries its record's classification, and an earlier answer carries the highest
 * classification of what produced it. There is no unlabelled field for record content to ride in;
 * the system prompt is this module's own text and the person's typed words are what they typed
 * (KF-WAR-0006 RR-001: not classified, because KF did not put them there).
 *
 * THE ENFORCEMENT POINT is `ProviderBackend.complete`. The router decides where a turn goes; this
 * re-decides, on the exact request about to be serialized, immediately before the transport is
 * handed a byte. A request carrying any item or earlier answer that may not leave the host is
 * refused with KF-ROUTE-003 naming the records, and the transport is never called. So a router
 * bug, a caller that skips the router, or a history item that lost its label (an unlabelled one
 * is `restricted`) cannot send controlled content to a provider; the worst it can do is refuse.
 *
 * An on-host backend (LAMU) has no such guard because nothing it is sent leaves the host — which
 * is why `lamu.ts` refuses any address that is not loopback.
 */

import {
  highestOf,
  mayLeaveHost,
  type MayLeaveHost,
  type ProviderCeiling,
} from './classification.js';

/** One record the reader may read now, as the context source served it. */
export interface ContextItem {
  /** Its citation number in this turn, from 1. */
  readonly n: number;
  readonly recordId: string;
  readonly revision: string;
  readonly title: string;
  readonly classification: string;
  readonly text: string;
}

/** An earlier turn of the conversation, as the model sees it. */
export interface ConversationTurn {
  readonly role: 'person' | 'agent';
  readonly text: string;
  /**
   * The highest classification of what produced an agent turn (its context), or `restricted`
   * when that cannot be shown. Absent for what the person typed.
   */
  readonly classification?: string;
}

export interface ModelRequest {
  readonly system: string;
  readonly history: readonly ConversationTurn[];
  readonly context: readonly ContextItem[];
  /** What the person asked this turn: their own words. */
  readonly question: string;
  readonly maxTokens: number;
}

export interface ModelReply {
  readonly text: string;
}

export interface ModelBackend {
  /** `on_host` never leaves the host; `provider` does, and is guarded. */
  readonly kind: 'on_host' | 'provider';
  /** What the answer names as its backend (KF-SAS-RQ-272). */
  readonly name: string;
  complete(request: ModelRequest): Promise<ModelReply>;
}

/** A model call that failed for a reason that is not a refusal (unreachable, bad reply). */
export class BackendUnavailable extends Error {
  constructor(
    readonly backend: string,
    message: string,
  ) {
    super(message);
    this.name = 'BackendUnavailable';
  }
}

/** Controlled content was about to leave the host, and did not (KF-ROUTE-003). */
export class EgressRefused extends Error {
  readonly rule = 'KF-ROUTE-003';
  constructor(
    readonly recordIds: readonly string[],
    readonly classification: string,
  ) {
    super(
      `KF-ROUTE-003: ${classification} content (${recordIds.length === 0 ? 'an earlier answer' : recordIds.join(', ')}) ` +
        'may not be sent to a provider’s model; it is answered on the host or not at all (KF-SAS-RQ-271)',
    );
    this.name = 'EgressRefused';
  }
}

/** The highest classification a request carries: its context and every earlier agent turn. */
export function requestClassification(request: ModelRequest): string | undefined {
  return highestOf([
    ...request.context.map((item) => item.classification),
    ...request.history
      .filter((turn) => turn.role === 'agent')
      .map((turn) => turn.classification ?? 'restricted'),
  ]);
}

/** What a provider adapter is: something that sends a request off the host. */
export interface ProviderTransport {
  readonly name: string;
  send(request: ModelRequest): Promise<ModelReply>;
}

export interface ProviderBackendOptions {
  /** The organization's ceiling at the moment of the call, asked on every call. */
  readonly ceiling: () => ProviderCeiling | Promise<ProviderCeiling>;
  /** The comparison. A test seam only: production uses the one `mayLeaveHost`. */
  readonly mayLeave?: MayLeaveHost;
}

/** A provider's model, behind the egress guard. */
export class ProviderBackend implements ModelBackend {
  readonly kind = 'provider' as const;
  readonly name: string;
  private readonly mayLeave: MayLeaveHost;

  constructor(
    private readonly transport: ProviderTransport,
    private readonly options: ProviderBackendOptions,
  ) {
    this.name = transport.name;
    this.mayLeave = options.mayLeave ?? mayLeaveHost;
  }

  async complete(request: ModelRequest): Promise<ModelReply> {
    const ceiling = await this.options.ceiling();
    // An organization that lets nothing leave sends a provider nothing, typed words included.
    if (ceiling === 'none') {
      throw new EgressRefused(
        request.context.map((item) => item.recordId),
        requestClassification(request) ?? 'any',
      );
    }
    const held = request.context.filter((item) => !this.mayLeave(item.classification, ceiling));
    const heldHistory = request.history.filter(
      (turn) =>
        turn.role === 'agent' && !this.mayLeave(turn.classification ?? 'restricted', ceiling),
    );
    if (held.length > 0 || heldHistory.length > 0) {
      throw new EgressRefused(
        held.map((item) => item.recordId),
        requestClassification(request) ?? 'restricted',
      );
    }
    return this.transport.send(request);
  }
}
