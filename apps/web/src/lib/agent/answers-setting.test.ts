/**
 * Who writes answers, in plain words; which ceiling the AI answers button may ask for; and the
 * deployment's configuration for each kind of cloud model.
 *
 * What this does NOT cover: the button's act against the API (tests/permissions and
 * tests/database/agent-at-home.test.ts hold set_model_routing_policy), or a rendered browser page.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PROVIDER_CEILINGS, ProviderBackend } from '@kf/agent';
import { NoModelNotice } from '../../app/components/no-model-notice';
import {
  AI_ANSWERS_PATH,
  answeredBy,
  answersSetting,
  routingAdvice,
  routingRequest,
  settingWords,
  type AnswersSetting,
} from './answers-setting';
import { backendsFor, loadAgentConfig } from './config';

describe('which model answered, in plain words', () => {
  it('says "on this computer" or names the cloud model', () => {
    expect(answeredBy({ kind: 'on_host', name: 'LAMU on this host (qwen3)' })).toBe(
      'Answered on this computer',
    );
    expect(answeredBy({ kind: 'provider', name: 'OpenAI (gpt-5)' })).toBe(
      'Answered by a cloud model: OpenAI (gpt-5)',
    );
    expect(answeredBy(null)).toBe('No model wrote this; nothing was sent to one.');
  });
});

describe('with no model, the answer area says so and links to where to turn it on', () => {
  it('renders the notice with its link', () => {
    const html = renderToStaticMarkup(createElement(NoModelNotice));
    expect(html).toContain('data-ask="no-model"');
    expect(html).toContain(`href="${AI_ANSWERS_PATH}"`);
    expect(html).toContain('Turn on AI answers');
    expect(html).toContain('here are the records that match your words');
  });
});

describe('the deployment’s choice, read from its configuration', () => {
  const keyFile = '/state/provider-api-key';

  it('off, on this computer, a cloud model, or both', () => {
    expect(answersSetting(loadAgentConfig({}))).toEqual({ choice: 'off' });
    expect(
      answersSetting(loadAgentConfig({ KF_AGENT_LAMU_URL: 'http://127.0.0.1:11434' })),
    ).toEqual({ choice: 'on_host' });
    const openai = loadAgentConfig({
      KF_AGENT_PROVIDER: 'openai_compatible',
      KF_AGENT_PROVIDER_KEY_FILE: keyFile,
      KF_AGENT_PROVIDER_MODEL: 'gpt-5',
      KF_AGENT_PROVIDER_BASE_URL: 'https://api.openai.com/v1',
      KF_AGENT_PROVIDER_NAME: 'OpenAI',
    });
    expect(openai.provider).toEqual({
      kind: 'openai_compatible',
      name: 'OpenAI',
      keyFile,
      model: 'gpt-5',
      baseURL: 'https://api.openai.com/v1',
    });
    expect(answersSetting(openai)).toEqual({ choice: 'cloud', cloudName: 'OpenAI' });
    // Whichever vendor, the cloud model is reached only through the one egress guard.
    const provider = backendsFor(openai, () => Promise.resolve('internal')).provider;
    expect(provider).toBeInstanceOf(ProviderBackend);
    expect(provider?.name).toBe('OpenAI (gpt-5)');
    const both = loadAgentConfig({
      KF_AGENT_LAMU_URL: 'http://127.0.0.1:11434',
      KF_AGENT_PROVIDER: 'anthropic',
      KF_AGENT_PROVIDER_KEY_FILE: keyFile,
    });
    expect(answersSetting(both)).toEqual({ choice: 'both', cloudName: 'Anthropic' });
    expect(settingWords(answersSetting(both))).toMatch(/^Both: Cloud model \(Anthropic\)/);
  });

  it('refuses a cloud model at a plain-http address, or one without its model or key file', () => {
    const base = {
      KF_AGENT_PROVIDER: 'openai_compatible',
      KF_AGENT_PROVIDER_KEY_FILE: keyFile,
      KF_AGENT_PROVIDER_MODEL: 'gpt-5',
    };
    expect(() =>
      loadAgentConfig({ ...base, KF_AGENT_PROVIDER_BASE_URL: 'http://api.example.com/v1' }),
    ).toThrow(/must be https/);
    expect(() => loadAgentConfig({ ...base })).toThrow(/needs KF_AGENT_PROVIDER_BASE_URL/);
    expect(() =>
      loadAgentConfig({
        ...base,
        KF_AGENT_PROVIDER_MODEL: '',
        KF_AGENT_PROVIDER_BASE_URL: 'https://api.openai.com/v1',
      }),
    ).toThrow(/needs KF_AGENT_PROVIDER_MODEL/);
    expect(() =>
      loadAgentConfig({ KF_AGENT_PROVIDER: 'openai_compatible', KF_AGENT_PROVIDER_MODEL: 'm' }),
    ).toThrow(/needs KF_AGENT_PROVIDER_KEY_FILE/);
    expect(() => loadAgentConfig({ KF_AGENT_PROVIDER: 'gemini' })).toThrow(/must be anthropic/);
  });
});

describe('the organization’s routing: the button never asks for more than internal', () => {
  const settings: AnswersSetting[] = [
    { choice: 'off' },
    { choice: 'on_host' },
    { choice: 'cloud', cloudName: 'Mistral' },
    { choice: 'both', cloudName: 'Anthropic' },
  ];

  it('offers internal when a cloud model is set up and nothing may leave; none for on-host only', () => {
    const offered = settings.flatMap((setting) =>
      PROVIDER_CEILINGS.map((ceiling) => [
        setting.choice,
        ceiling,
        routingAdvice(setting, ceiling)?.ceiling,
      ]),
    );
    expect(offered).toEqual([
      ['off', 'none', undefined],
      ['off', 'public', undefined],
      ['off', 'internal', undefined],
      ['on_host', 'none', undefined],
      ['on_host', 'public', 'none'],
      ['on_host', 'internal', 'none'],
      ['cloud', 'none', 'internal'],
      ['cloud', 'public', undefined],
      ['cloud', 'internal', undefined],
      ['both', 'none', 'internal'],
      ['both', 'public', undefined],
      ['both', 'internal', undefined],
    ]);
  });

  it('a submitted form may ask for none or internal, and nothing else is sent', () => {
    expect(routingRequest('internal')?.ceiling).toBe('internal');
    expect(routingRequest('none')?.ceiling).toBe('none');
    for (const value of ['confidential', 'restricted', 'public', '', undefined, ['internal']]) {
      expect(routingRequest(value)).toBeUndefined();
    }
  });
});
