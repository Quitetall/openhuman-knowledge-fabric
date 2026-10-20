// AI answers: who writes the answers to "Ask" in one's own Knowledge Fabric. The decisions only,
// pure, so tests/deployment/workspace.test.ts proves each one without a machine.
//
// Four choices, in the words the setup page uses: Off, On this computer, Cloud model, Both. What
// each starts the web application with is `agentEnv` (apps/web/src/lib/agent/config.ts reads it);
// what the organization's routing policy should say for it is `ceilingFor`. They are separate
// decisions on purpose: the deployment says which models EXIST here; the organization says what may
// LEAVE (ADR 0040 decision 8, KF-SAS-RQ-271). No choice here can make `confidential` or
// `restricted` content leave: `ceilingFor` never names more than `internal`, the database refuses
// more (KF-ROUTE-001), and every cloud provider, whichever vendor, sits behind the one egress guard
// (@kf/agent ProviderBackend).
//
// NOT covered here: whether a cloud vendor keeps what it is sent. That is the vendor's contract
// with the person who pastes the key, and why the organization's ceiling, not this file, decides
// what may leave.

import path from 'node:path';
import { WorkspaceError } from './plan.mjs';

export const ANSWER_CHOICES = Object.freeze(['off', 'on_host', 'cloud', 'both']);

/** Model servers on this computer the on-host backend can speak to: Ollama, then LM Studio. */
export const ON_HOST_MODEL_CANDIDATES = Object.freeze([
  'http://127.0.0.1:11434',
  'http://127.0.0.1:1234',
]);

/**
 * The cloud providers the page offers. `anthropic` uses its own transport; the rest are reached
 * through their OpenAI-compatible Chat Completions endpoint (@kf/agent openai-compatible.ts), and
 * `other` is any such endpoint, named by the person.
 */
export const CLOUD_PROVIDERS = Object.freeze({
  anthropic: {
    name: 'Anthropic',
    transport: 'anthropic',
    // @kf/agent PROVIDER_MODELS; the first is its default.
    models: ['claude-opus-5-5', 'claude-sonnet-5'],
  },
  openai: { name: 'OpenAI', transport: 'openai_compatible', baseUrl: 'https://api.openai.com/v1' },
  gemini: {
    name: 'Google Gemini',
    transport: 'openai_compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  mistral: {
    name: 'Mistral',
    transport: 'openai_compatible',
    baseUrl: 'https://api.mistral.ai/v1',
  },
  openrouter: {
    name: 'OpenRouter',
    transport: 'openai_compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
  other: { name: 'Cloud model', transport: 'openai_compatible' },
});

export function answersPaths(state) {
  return {
    settings: path.join(state, 'answers.json'),
    // The cloud provider's API key, owner-only, written by the workspace and read by the web
    // application on each call. Never an environment variable, an argv, a log line or a page.
    keyFile: path.join(state, 'provider-api-key'),
  };
}

export const usesOnHost = (choice) => choice === 'on_host' || choice === 'both';
export const usesCloud = (choice) => choice === 'cloud' || choice === 'both';

/** The rule the on-host backend applies (@kf/agent lamu.ts onHostUrl): loopback http only. */
export function isLoopbackModelUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    url.username === '' &&
    url.password === ''
  );
}

/** A cloud endpoint the person typed: https, no credentials, no query. Returned without a trailing slash. */
export function cloudBaseUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined;
  if (url.search !== '' || url.hash !== '') return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
}

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/u;
const KEY_SHAPE = /^[\x21-\x7e]{16,512}$/u;

/** "Cloud model (OpenAI)": what the person reads for a saved cloud provider. */
export function cloudLabel(cloud) {
  return `Cloud model (${cloud?.name ?? 'not chosen'})`;
}

/**
 * The cloud provider a form names, resolved and checked: `{ cloud }` or `{ problems }`. A problem
 * never quotes the key.
 */
export function resolveCloud(form = {}) {
  const id = form.provider;
  const entry = CLOUD_PROVIDERS[id];
  if (entry === undefined) return { problems: ['Choose which cloud model.'] };
  const problems = [];
  const model = typeof form.model === 'string' ? form.model.trim() : '';
  const cloud = { provider: id, name: entry.name, transport: entry.transport };
  if (entry.transport === 'anthropic') {
    cloud.model = entry.models.includes(model) ? model : entry.models[0];
  } else {
    if (!MODEL_NAME.test(model)) problems.push('Type the model’s name, as the provider spells it.');
    cloud.model = model;
    if (id === 'other') {
      const name = typeof form.name === 'string' ? form.name.trim() : '';
      if (name.length > 60) problems.push('The provider’s name is at most 60 characters.');
      if (name !== '') cloud.name = name;
      const base = cloudBaseUrl(form.baseUrl ?? '');
      if (base === undefined) {
        problems.push('Type the provider’s address; it starts with https://.');
      } else cloud.baseUrl = base;
    } else {
      cloud.baseUrl = entry.baseUrl;
    }
  }
  return problems.length > 0 ? { problems } : { cloud };
}

/**
 * What is wrong with an AI-answers form, in plain words. `onHost` is what detection found
 * (`{ url, models }` or `{ reason }`); `keyOnFile` whether a key is already saved, and for which
 * provider (a key is never reused for another provider).
 */
export function answersProblems({ choice, key, localModel, cloud }, { onHost, keyOnFile }) {
  if (!ANSWER_CHOICES.includes(choice)) return ['Choose who writes answers.'];
  const problems = [];
  if (usesOnHost(choice)) {
    if (onHost?.url === undefined) {
      problems.push(
        `${onHost?.reason ?? 'No model is running on this computer'}. Start one (for example ` +
          'Ollama or LM Studio, with a model downloaded), or choose another option.',
      );
    } else if (
      typeof localModel === 'string' &&
      localModel !== '' &&
      !onHost.models.includes(localModel)
    ) {
      problems.push('That model is not on this computer any more; choose one from the list.');
    }
  }
  if (usesCloud(choice)) {
    const resolved = resolveCloud(cloud);
    if (resolved.problems !== undefined) problems.push(...resolved.problems);
    const typed = typeof key === 'string' ? key.trim() : '';
    const sameProvider = keyOnFile !== undefined && keyOnFile === cloud?.provider;
    if (typed === '' && !sameProvider) problems.push('Paste the API key for the cloud model.');
    else if (typed !== '' && !KEY_SHAPE.test(typed)) {
      problems.push('That does not look like an API key (one line, no spaces).');
    }
  }
  return problems;
}

/**
 * What the web application is started with for `answers` (the saved answers.json, or null for
 * none). The cloud provider is named by its key FILE; the key itself is never in this environment.
 * `providerBaseUrl` is a loopback recording double's address (KF_LOCAL_PROVIDER_BASE_URL, tests
 * only), never a saved setting.
 */
export function agentEnv(answers, { keyFile, providerBaseUrl } = {}) {
  const choice = ANSWER_CHOICES.includes(answers?.choice) ? answers.choice : 'off';
  const env = { KF_AGENT_PROVIDER: 'none' };
  if (usesOnHost(choice)) {
    const url = answers.onHost?.url;
    if (url === undefined || !isLoopbackModelUrl(url)) {
      throw new WorkspaceError(
        'answers_not_on_host',
        'The model saved for “on this computer” is not on this computer.',
        'Choose AI answers again.',
      );
    }
    env.KF_AGENT_LAMU_URL = url;
    if (answers.onHost.model !== undefined) env.KF_AGENT_LAMU_MODEL = answers.onHost.model;
  }
  if (usesCloud(choice)) {
    const cloud = answers.cloud;
    if (keyFile === undefined) throw new Error('agentEnv: a cloud model needs its key file');
    if (cloud?.transport === 'anthropic') {
      env.KF_AGENT_PROVIDER = 'anthropic';
    } else if (cloud?.transport === 'openai_compatible' && cloud.baseUrl !== undefined) {
      env.KF_AGENT_PROVIDER = 'openai_compatible';
      env.KF_AGENT_PROVIDER_BASE_URL = cloud.baseUrl;
      env.KF_AGENT_PROVIDER_NAME = cloud.name;
    } else {
      throw new WorkspaceError(
        'answers_no_cloud',
        'The cloud model saved for AI answers is incomplete.',
        'Choose AI answers again.',
      );
    }
    env.KF_AGENT_PROVIDER_KEY_FILE = keyFile;
    env.KF_AGENT_PROVIDER_MODEL = cloud.model;
    if (providerBaseUrl !== undefined) env.KF_AGENT_PROVIDER_BASE_URL = providerBaseUrl;
  }
  // Both: the cloud model for what may leave, this computer for the rest. Above the organization's
  // ceiling the router sends a turn to the host only, whatever is preferred (@kf/agent router.ts).
  if (choice === 'both') env.KF_AGENT_PREFER = 'provider';
  return env;
}

/**
 * The organization's provider ceiling that matches a choice, or undefined when the choice has no
 * opinion (Off: nothing answers, so nothing is changed). Never above `internal`, the highest ADR
 * 0040 lets leave.
 */
export function ceilingFor(choice) {
  if (usesCloud(choice)) return 'internal';
  if (choice === 'on_host') return 'none';
  return undefined;
}

/** What the page shows about the saved choice: never the key, only whether one is saved. */
export function answersView(answers, { keyOnFile }) {
  const choice = ANSWER_CHOICES.includes(answers?.choice) ? answers.choice : 'off';
  return {
    choice,
    keyOnFile: keyOnFile !== undefined,
    ...(answers?.onHost?.model === undefined ? {} : { localModel: answers.onHost.model }),
    ...(answers?.cloud === undefined
      ? {}
      : {
          cloud: {
            provider: answers.cloud.provider,
            name: answers.cloud.name,
            model: answers.cloud.model,
            ...(answers.cloud.provider === 'other' ? { baseUrl: answers.cloud.baseUrl } : {}),
            label: cloudLabel(answers.cloud),
          },
        }),
  };
}
