/**
 * One urgent push to one person's own destination (ADR 0040 decision 9, KF-SAS-RQ-274;
 * 20261011500000).
 *
 * What a push may say is decided by the database (`core.urgent_pushes()`): a title only for an item
 * every record of which may leave the host under its organization's provider ceiling, and which the
 * person reads now; otherwise no title. This composer is the second line, as the digest's is: it
 * never prints a title from a row not marked disclosed, whatever the row carries.
 *
 * The sender POSTs the message to an ntfy topic the person chose, on a push server the deployment
 * names, with the stance `alert-dispatch.sh` takes for the operational alerts: the URL is
 * validated again before every send, redirects are refused, the request is bounded in time, the
 * response must echo the message as ntfy's own JSON, and no error names the URL or quotes the
 * server's answer — either can carry the topic, which is the capability.
 */

import { parseDestination } from '@kf/authorization';

export interface UrgentRow {
  readonly organizationId: string;
  readonly personId: string;
  readonly kind: string;
  readonly aroseAt: string;
  readonly itemId: string;
  readonly disclosed: boolean;
  readonly title: string | null;
  readonly destination: string | null;
}

export interface PushMessage {
  /** Fixed: a lock screen shows the title line first. */
  readonly title: string;
  readonly body: string;
  /** Where tapping it leads: Needs you, never a record's own address. */
  readonly click?: string;
}

/** The line the alert path sends, and every push about an item whose content stays on the host. */
export const UNDISCLOSED_PUSH = 'Something in Knowledge Fabric needs you. Open Needs you.';

/** A title on one line, bounded: it is shown, not parsed. */
function line(title: string): string {
  const flat = title.replace(/[\r\n\t]+/gu, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat;
}

export function composePush(row: UrgentRow, webOrigin?: string): PushMessage {
  const shown = row.disclosed && row.title !== null && row.title.trim() !== '';
  const click =
    webOrigin === undefined ? {} : { click: `${webOrigin.replace(/\/+$/u, '')}/needs-you` };
  return {
    title: 'Knowledge Fabric',
    body: shown ? `Needs you: ${line(row.title!)}` : UNDISCLOSED_PUSH,
    ...click,
  };
}

/** Sends one message to one destination URL; rejects with a message that names neither. */
export type PushSender = (destination: string, message: PushMessage) => Promise<void>;

export class PushFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushFailed';
  }
}

/** ntfy's publish API: POST the body to the topic URL, with Title and Click headers. */
export function ntfySender(
  servers: readonly string[],
  options: { readonly timeoutMs?: number; readonly fetch?: typeof fetch } = {},
): PushSender {
  const send = options.fetch ?? fetch;
  return async (destination, message) => {
    // Again here, not only when it was set: the servers this host sends to may have narrowed.
    const url = parseDestination(destination, servers);
    let response: Response;
    try {
      response = await send(url, {
        method: 'POST',
        body: message.body,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          title: message.title,
          ...(message.click === undefined ? {} : { click: message.click }),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
      });
    } catch {
      throw new PushFailed('the push server could not be reached');
    }
    if (!response.ok) throw new PushFailed(`the push server answered ${String(response.status)}`);
    let echoed: unknown;
    try {
      echoed = JSON.parse(await response.text());
    } catch {
      throw new PushFailed('the push server did not answer as ntfy');
    }
    const answer = echoed as { event?: unknown; message?: unknown } | null;
    if (answer?.event !== 'message' || answer.message !== message.body) {
      throw new PushFailed('the push server did not accept the message');
    }
  };
}
