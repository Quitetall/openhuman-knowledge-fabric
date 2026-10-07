/**
 * A provider's model: the Claude API, through the official SDK (the deployment's choice, owner-only
 * in KF-WAR-0006: a key in the secrets store, or none).
 *
 * This is a TRANSPORT. It is reached only through `ProviderBackend` (backends.ts), whose guard
 * re-checks every item's classification before `send` is called, so nothing here decides what may
 * leave. The key is read from a file the caller names, on every call, never from the environment
 * (KF-WAR-0006 work order 3): the SDK is constructed with an explicit `apiKey` so it never looks at
 * `ANTHROPIC_API_KEY` or a local profile either.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  BackendUnavailable,
  type ModelReply,
  type ModelRequest,
  type ProviderTransport,
} from './backends.js';
import { renderMessages } from './prompt.js';

/** ADR 0040 leaves the provider's model to the deployment; the owner named these two. */
export const PROVIDER_MODELS = ['claude-opus-5-5', 'claude-sonnet-5'] as const;
export type ProviderModel = (typeof PROVIDER_MODELS)[number];
export const DEFAULT_PROVIDER_MODEL: ProviderModel = 'claude-opus-5-5';

export interface AnthropicTransportOptions {
  /** The API key, read from its credential file on each call. */
  readonly apiKey: () => string;
  readonly model?: ProviderModel;
  readonly timeoutMs?: number;
  /**
   * Where the Messages API is. Absent: the provider's own (`https://api.anthropic.com`). Passed to
   * the SDK explicitly, so `ANTHROPIC_BASE_URL` in the environment never redirects it.
   */
  readonly baseURL?: string;
}

/** The provider's address: https, or loopback http (a recording double in a test stack). */
export function providerBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('the provider address is not a URL');
  }
  const loopback =
    url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error('the provider address must be https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('the provider address must not carry credentials');
  }
  return url.origin;
}

export class AnthropicTransport implements ProviderTransport {
  readonly name: string;
  private readonly model: ProviderModel;

  constructor(private readonly options: AnthropicTransportOptions) {
    this.model = options.model ?? DEFAULT_PROVIDER_MODEL;
    this.name = `Anthropic (${this.model})`;
  }

  async send(request: ModelRequest): Promise<ModelReply> {
    const client = new Anthropic({
      apiKey: this.options.apiKey(),
      baseURL: this.options.baseURL ?? 'https://api.anthropic.com',
      // Bounded: a chat turn a person waits on, not a batch job. The SDK retries 429/5xx twice.
      timeout: this.options.timeoutMs ?? 90_000,
    });
    let message;
    try {
      message = await client.messages.create({
        model: this.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: renderMessages(request),
        // Short, cited answers to a waiting person: medium effort, set explicitly (Claude Opus
        // 5.5 defaults to medium; Sonnet 5 to high).
        output_config: { effort: 'medium' },
      });
    } catch (error: unknown) {
      // Never the SDK's message: it can quote the request.
      if (error instanceof Anthropic.AuthenticationError) {
        throw new BackendUnavailable(this.name, 'the provider refused the configured key');
      }
      if (error instanceof Anthropic.RateLimitError) {
        throw new BackendUnavailable(this.name, 'the provider is rate limiting; try again shortly');
      }
      if (error instanceof Anthropic.APIConnectionError) {
        throw new BackendUnavailable(this.name, 'the provider could not be reached');
      }
      if (error instanceof Anthropic.APIError) {
        throw new BackendUnavailable(
          this.name,
          `the provider answered ${String(error.status ?? 'an error')}`,
        );
      }
      throw new BackendUnavailable(this.name, 'the provider call failed');
    }
    if (message.stop_reason === 'refusal') {
      throw new BackendUnavailable(this.name, 'the provider’s model declined to answer');
    }
    const text = message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('')
      .trim();
    if (text === '') throw new BackendUnavailable(this.name, 'the provider returned no answer');
    return { text };
  }
}
