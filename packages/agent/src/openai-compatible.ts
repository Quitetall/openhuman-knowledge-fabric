/**
 * A cloud model behind any OpenAI-compatible Chat Completions endpoint (OpenAI, Google Gemini's
 * OpenAI-compatible endpoint, Mistral, OpenRouter, …): the deployment's choice of cloud provider,
 * beside the Anthropic transport (anthropic.ts).
 *
 * This is a TRANSPORT, exactly like `AnthropicTransport`. It is reached only through
 * `ProviderBackend` (backends.ts), whose guard re-checks every item's classification against the
 * organization's ceiling before `send` is called, so a cloud model of any vendor receives exactly
 * what the guard lets leave and nothing else; nothing here decides what may leave.
 *
 * The key is read from a file the caller names, on every call, never from the environment
 * (KF-WAR-0006 work order 3). The endpoint is https, or loopback http for a recording double in a
 * test stack, and never carries credentials. A failure never quotes the provider's body: it can
 * echo the request.
 *
 * What it does NOT cover: whether the named vendor keeps or trains on what it is sent. That is the
 * vendor's contract with the deployment's owner, and the reason the organization's ceiling, not
 * this file, decides what may leave.
 */

import {
  BackendUnavailable,
  type ModelReply,
  type ModelRequest,
  type ProviderTransport,
} from './backends.js';
import { renderMessages } from './prompt.js';

/** The largest reply body read, in bytes. */
const MAX_REPLY_BYTES = 512 * 1024;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** A model name as the endpoint takes it (`gpt-5`, `gemini-2.5-pro`, `mistral/large`, …). */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/u;

/**
 * The endpoint's base (the part before `/chat/completions`), path kept: https, or loopback http.
 * No credentials, query or fragment: a key in an address is a key in every log that prints it.
 */
export function cloudEndpointUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('the cloud model’s address is not a URL');
  }
  const loopback = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error('the cloud model’s address must be https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('the cloud model’s address must not carry credentials');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('the cloud model’s address must not carry a query or a fragment');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
}

export function isCloudModelName(value: string): boolean {
  return MODEL_NAME.test(value);
}

export interface OpenAICompatibleOptions {
  /** The provider's name as a person reads it: `OpenAI`, `Google Gemini`, `Mistral`, … */
  readonly providerName: string;
  /** The base the endpoint is under, e.g. `https://api.openai.com/v1`. */
  readonly baseURL: string;
  readonly model: string;
  /** The API key, read from its credential file on each call. */
  readonly apiKey: () => string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export class OpenAICompatibleTransport implements ProviderTransport {
  readonly name: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAICompatibleOptions) {
    if (!isCloudModelName(options.model)) {
      throw new Error('the cloud model’s name is not a model name');
    }
    const providerName = options.providerName.trim();
    if (providerName === '' || providerName.length > 60) {
      throw new Error('the cloud provider needs a name of 1 to 60 characters');
    }
    this.endpoint = `${cloudEndpointUrl(options.baseURL)}/chat/completions`;
    this.name = `${providerName} (${options.model})`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(request: ModelRequest): Promise<ModelReply> {
    const body = {
      model: this.options.model,
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
          authorization: `Bearer ${this.options.apiKey()}`,
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 90_000),
      });
    } catch {
      throw new BackendUnavailable(this.name, 'the cloud model could not be reached');
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_REPLY_BYTES) {
      throw new BackendUnavailable(this.name, 'the cloud model’s reply was larger than an answer');
    }
    if (response.status === 401 || response.status === 403) {
      throw new BackendUnavailable(this.name, 'the provider refused the configured key');
    }
    if (response.status === 429) {
      throw new BackendUnavailable(this.name, 'the provider is rate limiting; try again shortly');
    }
    if (!response.ok) {
      throw new BackendUnavailable(this.name, `the provider answered ${String(response.status)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BackendUnavailable(this.name, 'the provider’s reply was not JSON');
    }
    const choice = (
      parsed as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] }
    ).choices?.[0];
    if (choice?.finish_reason === 'content_filter') {
      throw new BackendUnavailable(this.name, 'the provider’s model declined to answer');
    }
    const content = choice?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new BackendUnavailable(this.name, 'the provider returned no answer');
    }
    return { text: content.trim() };
  }
}
