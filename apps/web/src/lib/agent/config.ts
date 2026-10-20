/**
 * How this deployment's in-app agent is configured (ADR 0040 decisions 7 and 8; KF-WAR-0006).
 *
 *   KF_AGENT_LAMU_URL            the model on this host, `http://127.0.0.1:<port>`: LAMU, or any
 *                                OpenAI-compatible local server (Ollama, LM Studio). Loopback only.
 *                                Absent: no on-host model, and confidential and restricted turns
 *                                are refused.
 *   KF_AGENT_LAMU_MODEL          the model it serves (optional for LAMU, which routes; required by
 *                                Ollama and LM Studio)
 *   KF_AGENT_LAMU_TOKEN_FILE     its bearer, an owner-only file (optional)
 *   KF_AGENT_PROVIDER            the cloud model, if any (default `none`): `anthropic`, or
 *                                `openai_compatible` (OpenAI, Google Gemini, Mistral, OpenRouter, …
 *                                through their OpenAI-compatible Chat Completions endpoint)
 *   KF_AGENT_PROVIDER_KEY_FILE   the provider's API key, an owner-only file; never an environment
 *                                variable (KF-WAR-0006 work order 3)
 *   KF_AGENT_PROVIDER_MODEL      anthropic: `claude-opus-5-5` (default) or `claude-sonnet-5`;
 *                                openai_compatible: the endpoint's model name (required)
 *   KF_AGENT_PROVIDER_BASE_URL   anthropic: the Messages API's origin (default the provider's own);
 *                                openai_compatible: the base before `/chat/completions` (required).
 *                                https, or loopback http for a recording double in a test stack
 *   KF_AGENT_PROVIDER_NAME       openai_compatible: the provider's name as a person reads it
 *                                (`OpenAI`, `Google Gemini`, …; default `Cloud model`)
 *   KF_AGENT_PREFER              `provider` (default) or `on_host`, when both may answer
 *
 * Every cloud provider sits behind the same egress guard (`ProviderBackend`): the organization's
 * ceiling and ADR 0040's absolute limit apply to all of them identically.
 *   KF_WEB_AGENT_CLIENT_ID       the in-app agent's OAuth client, declared with `kf declare-agent`
 *   KF_WEB_AGENT_CLIENT_SECRET_FILE  its client secret, an owner-only file
 *
 * Whether a provider may receive anything is still the ORGANIZATION's, per turn
 * (`GET /model-routing`); this only says which provider, if any, exists here.
 */

import { createHmac, randomBytes } from 'node:crypto';
import {
  AnthropicTransport,
  LamuBackend,
  OpenAICompatibleTransport,
  PROVIDER_MODELS,
  ProviderBackend,
  cloudEndpointUrl,
  isCloudModelName,
  providerBaseUrl,
  readOwnerOnlyFile,
  type Backends,
  type ProviderCeiling,
  type ProviderModel,
  type ProviderTransport,
} from '@kf/agent';
import { loadWebIdentityConfig } from '../auth';

type Environment = Readonly<Record<string, string | undefined>>;

export interface AgentDelegation {
  readonly clientId: string;
  readonly secretFile: string;
}

export interface AgentConfig {
  readonly lamu?: { readonly url: string; readonly model?: string; readonly tokenFile?: string };
  readonly provider?:
    | {
        readonly kind: 'anthropic';
        /** The provider's name as a person reads it. */
        readonly name: 'Anthropic';
        readonly keyFile: string;
        readonly model: ProviderModel;
        readonly baseURL?: string;
      }
    | {
        readonly kind: 'openai_compatible';
        readonly name: string;
        readonly keyFile: string;
        readonly model: string;
        readonly baseURL: string;
      };
  readonly prefer: 'provider' | 'on_host';
  /** Absent: no in-app agent identity, so a draft cannot be committed from chat here. */
  readonly delegation?: AgentDelegation;
}

function optional(env: Environment, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

export function loadAgentConfig(env: Environment = process.env): AgentConfig {
  const lamuUrl = optional(env, 'KF_AGENT_LAMU_URL');
  const lamuModel = optional(env, 'KF_AGENT_LAMU_MODEL');
  const lamuToken = optional(env, 'KF_AGENT_LAMU_TOKEN_FILE');
  const provider = optional(env, 'KF_AGENT_PROVIDER') ?? 'none';
  if (provider !== 'anthropic' && provider !== 'openai_compatible' && provider !== 'none') {
    throw new Error('KF_AGENT_PROVIDER must be anthropic, openai_compatible or none');
  }
  if (optional(env, 'ANTHROPIC_API_KEY') !== undefined) {
    // Refused rather than ignored: a key in the environment is readable from /proc by anything
    // running as this user, and its presence says somebody believes it is in use.
    throw new Error(
      'ANTHROPIC_API_KEY is set in the web application’s environment; put the key in an ' +
        'owner-only file and name it with KF_AGENT_PROVIDER_KEY_FILE',
    );
  }
  let providerConfig: AgentConfig['provider'];
  if (provider !== 'none') {
    const keyFile = optional(env, 'KF_AGENT_PROVIDER_KEY_FILE');
    if (keyFile === undefined) {
      throw new Error(`KF_AGENT_PROVIDER=${provider} needs KF_AGENT_PROVIDER_KEY_FILE`);
    }
    const baseURL = optional(env, 'KF_AGENT_PROVIDER_BASE_URL');
    if (provider === 'anthropic') {
      const model = optional(env, 'KF_AGENT_PROVIDER_MODEL') ?? 'claude-opus-5-5';
      if (!(PROVIDER_MODELS as readonly string[]).includes(model)) {
        throw new Error(`KF_AGENT_PROVIDER_MODEL must be one of ${PROVIDER_MODELS.join(', ')}`);
      }
      providerConfig = {
        kind: 'anthropic',
        name: 'Anthropic',
        keyFile,
        model: model as ProviderModel,
        ...(baseURL === undefined ? {} : { baseURL: providerBaseUrl(baseURL) }),
      };
    } else {
      const model = optional(env, 'KF_AGENT_PROVIDER_MODEL');
      if (model === undefined || !isCloudModelName(model)) {
        throw new Error('KF_AGENT_PROVIDER=openai_compatible needs KF_AGENT_PROVIDER_MODEL');
      }
      if (baseURL === undefined) {
        throw new Error('KF_AGENT_PROVIDER=openai_compatible needs KF_AGENT_PROVIDER_BASE_URL');
      }
      const name = optional(env, 'KF_AGENT_PROVIDER_NAME') ?? 'Cloud model';
      if (name.length > 60) throw new Error('KF_AGENT_PROVIDER_NAME is at most 60 characters');
      providerConfig = {
        kind: 'openai_compatible',
        name,
        keyFile,
        model,
        baseURL: cloudEndpointUrl(baseURL),
      };
    }
  }
  const prefer = optional(env, 'KF_AGENT_PREFER') ?? 'provider';
  if (prefer !== 'provider' && prefer !== 'on_host') {
    throw new Error('KF_AGENT_PREFER must be provider or on_host');
  }
  const clientId = optional(env, 'KF_WEB_AGENT_CLIENT_ID');
  const secretFile = optional(env, 'KF_WEB_AGENT_CLIENT_SECRET_FILE');
  if ((clientId === undefined) !== (secretFile === undefined)) {
    throw new Error(
      'set both KF_WEB_AGENT_CLIENT_ID and KF_WEB_AGENT_CLIENT_SECRET_FILE, or neither',
    );
  }
  return {
    ...(lamuUrl === undefined
      ? {}
      : {
          lamu: {
            url: lamuUrl,
            ...(lamuModel === undefined ? {} : { model: lamuModel }),
            ...(lamuToken === undefined ? {} : { tokenFile: lamuToken }),
          },
        }),
    ...(providerConfig === undefined ? {} : { provider: providerConfig }),
    prefer,
    ...(clientId === undefined || secretFile === undefined
      ? {}
      : { delegation: { clientId, secretFile } }),
  };
}

/** The cloud provider's transport: whichever vendor, it is wrapped by the same egress guard. */
function transportFor(provider: NonNullable<AgentConfig['provider']>): ProviderTransport {
  const apiKey = () => readOwnerOnlyFile(provider.keyFile, 'provider API key');
  if (provider.kind === 'anthropic') {
    return new AnthropicTransport({
      apiKey,
      model: provider.model,
      ...(provider.baseURL === undefined ? {} : { baseURL: provider.baseURL }),
    });
  }
  return new OpenAICompatibleTransport({
    providerName: provider.name,
    baseURL: provider.baseURL,
    model: provider.model,
    apiKey,
  });
}

/** The models this deployment has, every cloud provider behind the one egress guard. */
export function backendsFor(
  config: AgentConfig,
  ceiling: () => Promise<ProviderCeiling>,
): Backends {
  const lamu = config.lamu;
  const provider = config.provider;
  return {
    ...(lamu === undefined
      ? {}
      : {
          onHost: new LamuBackend({
            url: lamu.url,
            ...(lamu.model === undefined ? {} : { model: lamu.model }),
            ...(lamu.tokenFile === undefined
              ? {}
              : { token: () => readOwnerOnlyFile(lamu.tokenFile!, 'LAMU token') }),
          }),
        }),
    ...(provider === undefined
      ? {}
      : {
          provider: new ProviderBackend(transportFor(provider), { ceiling }),
        }),
    prefer: config.prefer,
  };
}

let developmentSealKey: Uint8Array | undefined;

/**
 * The key that seals the answers the browser carries back. Derived from the web session key, so it
 * is as secret as the sessions it serves and rotates with them; in development, one per process.
 */
export function sealKey(): Uint8Array {
  const identity = loadWebIdentityConfig();
  if (identity.profile === 'dogfood') {
    return createHmac('sha256', identity.sessionKey).update('kf-agent-turn-seal-v1').digest();
  }
  developmentSealKey ??= randomBytes(32);
  return developmentSealKey;
}
