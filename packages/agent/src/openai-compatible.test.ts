/**
 * A cloud model behind an OpenAI-compatible endpoint (openai-compatible.ts) sits behind the SAME
 * egress guard as Anthropic: what the organization's ceiling and ADR 0040's absolute limit hold
 * back never reaches its fetch, whichever vendor it is. And its key is sent only as the bearer of
 * the one request, never quoted in a failure.
 *
 * What this does NOT cover: a real vendor. The fetch here is a recording double; the vendors'
 * endpoints were not called.
 */
import { describe, expect, it } from 'vitest';
import {
  BackendUnavailable,
  EgressRefused,
  ProviderBackend,
  type ModelRequest,
} from './backends.js';
import type { ProviderCeiling } from './classification.js';
import { OpenAICompatibleTransport, cloudEndpointUrl } from './openai-compatible.js';

const KEY = 'kf-sentinel-cloud-key-5e2a91c0d7';

function request(classification: string, text = 'The bench measured 4.2 mm.'): ModelRequest {
  return {
    system: 'Answer from the sources.',
    history: [],
    context: [
      { n: 1, recordId: 'rec-1', revision: '1', title: 'Bench note', classification, text },
    ],
    question: 'What did the bench measure?',
    maxTokens: 200,
  };
}

function recordingFetch(reply: { status: number; body: unknown }) {
  const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    sent.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: String(init?.body),
    });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return { sent, impl };
}

const ANSWER = { choices: [{ message: { content: 'It measured 4.2 mm [1].' } }] };

function cloud(fetchImpl: typeof fetch) {
  return new OpenAICompatibleTransport({
    providerName: 'OpenAI',
    baseURL: 'https://api.openai.com/v1/',
    model: 'gpt-5',
    apiKey: () => KEY,
    fetchImpl,
  });
}

describe('every cloud provider passes the one egress guard', () => {
  for (const [classification, ceiling, leaves] of [
    ['public', 'internal', true],
    ['internal', 'internal', true],
    ['internal', 'public', false],
    ['confidential', 'internal', false],
    ['restricted', 'internal', false],
    ['public', 'none', false],
  ] as const) {
    it(`${classification} under a ${ceiling} ceiling ${leaves ? 'is sent' : 'never reaches the fetch'}`, async () => {
      const recorder = recordingFetch({ status: 200, body: ANSWER });
      const backend = new ProviderBackend(cloud(recorder.impl), {
        ceiling: () => ceiling as ProviderCeiling,
      });
      const outcome = backend.complete(request(classification, 'Halberd is the target.'));
      if (leaves) {
        await expect(outcome).resolves.toEqual({ text: 'It measured 4.2 mm [1].' });
        expect(recorder.sent).toHaveLength(1);
        expect(recorder.sent[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
        expect(recorder.sent[0]!.headers['authorization']).toBe(`Bearer ${KEY}`);
        expect(JSON.parse(recorder.sent[0]!.body)).toMatchObject({ model: 'gpt-5' });
      } else {
        await expect(outcome).rejects.toBeInstanceOf(EgressRefused);
        expect(recorder.sent).toHaveLength(0);
      }
    });
  }
});

describe('the key and the reply', () => {
  it('a refusal names the cause, never the body, which can quote the key', async () => {
    const recorder = recordingFetch({
      status: 401,
      body: { error: { message: `Incorrect API key provided: ${KEY}` } },
    });
    const error = await cloud(recorder.impl)
      .send(request('public'))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackendUnavailable);
    expect((error as Error).message).toBe('the provider refused the configured key');
    expect(JSON.stringify(error)).not.toContain(KEY);
    expect(recorder.sent[0]!.body).not.toContain(KEY);
  });

  it('an empty answer is unavailable, not an answer', async () => {
    const recorder = recordingFetch({ status: 200, body: { choices: [{ message: {} }] } });
    await expect(cloud(recorder.impl).send(request('public'))).rejects.toThrow(
      'the provider returned no answer',
    );
  });
});

describe('the address', () => {
  it('is https, or loopback http for a recording double, with no credentials or query', () => {
    expect(cloudEndpointUrl('https://generativelanguage.googleapis.com/v1beta/openai/')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai',
    );
    expect(cloudEndpointUrl('http://127.0.0.1:8999/v1')).toBe('http://127.0.0.1:8999/v1');
    expect(() => cloudEndpointUrl('http://api.openai.com/v1')).toThrow(/must be https/);
    expect(() => cloudEndpointUrl('https://user:pw@api.example.com/v1')).toThrow(/credentials/);
    expect(() => cloudEndpointUrl('https://api.example.com/v1?key=x')).toThrow(/query/);
  });

  it('refuses a model name that is not one', () => {
    expect(
      () =>
        new OpenAICompatibleTransport({
          providerName: 'OpenAI',
          baseURL: 'https://api.openai.com/v1',
          model: 'gpt 5; rm -rf',
          apiKey: () => KEY,
        }),
    ).toThrow(/not a model name/);
  });
});
