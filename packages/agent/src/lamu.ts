/**
 * LAMU on the host: the only model confidential and restricted content is ever sent to
 * (ADR 0040 decision 8, KF-SAS-RQ-271).
 *
 * LAMU serves an OpenAI-compatible `POST /v1/chat/completions` on loopback
 * (`lamu-rs/docs/API.md`). This adapter refuses, at construction, any address that is not a
 * loopback IP literal or `localhost` over plain HTTP: an "on-host" backend configured with a remote
 * address would make every confidential answer leave the host while its label said it had not.
 *
 * What it cannot see: LAMU itself may be configured to forward to a cloud gateway
 * (`LAMU_GATEWAY_URL`). That is LAMU's configuration, on the host, and is recorded as a limit in
 * docs/agents/in-app-agent.md; the host's commissioning must keep it unset.
 *
 * A failure is `BackendUnavailable`, and the caller refuses the turn. It never falls back to a
 * provider (KF-SAS-RQ-271: "refused rather than sent to a provider").
 */

import {
  BackendUnavailable,
  type ModelBackend,
  type ModelReply,
  type ModelRequest,
} from './backends.js';
import { renderMessages } from './prompt.js';

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** The largest reply body read, in bytes. */
const MAX_REPLY_BYTES = 512 * 1024;

export interface LamuOptions {
  /** `http://127.0.0.1:<port>`; the adapter appends `/v1/chat/completions`. */
  readonly url: string;
  /** The model alias LAMU routes; absent lets LAMU's router pick. */
  readonly model?: string;
  /** LAMU's static bearer (ADR 0012 there), when its serve requires one. */
  readonly token?: () => string | undefined;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/** Refuse any address that is not this host. */
export function onHostUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('the LAMU address is not a URL');
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      'the LAMU address must be loopback (http://127.0.0.1:<port>): an on-host model that is not ' +
        'on the host would carry confidential content off it under the wrong label',
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('the LAMU address must not carry credentials');
  }
  return url;
}

export class LamuBackend implements ModelBackend {
  readonly kind = 'on_host' as const;
  readonly name: string;
  private readonly endpoint: URL;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: LamuOptions) {
    const base = onHostUrl(options.url);
    this.endpoint = new URL('/v1/chat/completions', base);
    this.name = `LAMU on this host${options.model === undefined ? '' : ` (${options.model})`}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: ModelRequest): Promise<ModelReply> {
    const token = this.options.token?.();
    const body = {
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
      messages: [{ role: 'system', content: request.system }, ...renderMessages(request)],
      max_tokens: request.maxTokens,
      stream: false,
    };
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
      });
    } catch {
      throw new BackendUnavailable(this.name, 'LAMU did not answer on this host');
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_REPLY_BYTES) {
      throw new BackendUnavailable(this.name, 'LAMU’s reply was larger than an answer may be');
    }
    if (!response.ok) {
      // LAMU's error body names the model and the backend port; the status is enough to say.
      throw new BackendUnavailable(this.name, `LAMU answered ${String(response.status)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BackendUnavailable(this.name, 'LAMU’s reply was not JSON');
    }
    const content = (parsed as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]
      ?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new BackendUnavailable(this.name, 'LAMU returned no answer');
    }
    return { text: content.trim() };
  }
}
