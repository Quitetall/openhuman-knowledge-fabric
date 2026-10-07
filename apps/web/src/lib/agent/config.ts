/**
 * How this deployment's in-app agent is configured (ADR 0040 decisions 7 and 8; KF-WAR-0006).
 *
 *   KF_AGENT_LAMU_URL            LAMU on this host, `http://127.0.0.1:<port>`. Absent: no on-host
 *                                model, and confidential and restricted turns are refused.
 *   KF_AGENT_LAMU_MODEL          the model alias LAMU routes (optional)
 *   KF_AGENT_LAMU_TOKEN_FILE     LAMU's bearer, an owner-only file (optional)
 *   KF_AGENT_PROVIDER            `anthropic` or `none` (default `none`): the owner's choice
 *   KF_AGENT_PROVIDER_KEY_FILE   the provider's API key, an owner-only file; never an environment
 *                                variable (KF-WAR-0006 work order 3)
 *   KF_AGENT_PROVIDER_MODEL      `claude-opus-5-5` (default) or `claude-sonnet-5`
 *   KF_AGENT_PROVIDER_BASE_URL   the Messages API's address (default the provider's own; https, or
 *                                loopback http for a recording double in a test stack)
 *   KF_AGENT_PREFER              `provider` (default) or `on_host`, when both may answer
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
  PROVIDER_MODELS,
  ProviderBackend,
  providerBaseUrl,
  readOwnerOnlyFile,
  type Backends,
  type ProviderCeiling,
  type ProviderModel,
} from '@kf/agent';
import { loadWebIdentityConfig } from '../auth';

type Environment = Readonly<Record<string, string | undefined>>;

export interface AgentDelegation {
  readonly clientId: string;
  readonly secretFile: string;
}

export interface AgentConfig {
  readonly lamu?: { readonly url: string; readonly model?: string; readonly tokenFile?: string };
  readonly provider?: {
    readonly keyFile: string;
    readonly model: ProviderModel;
    readonly baseURL?: string;
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
  if (provider !== 'anthropic' && provider !== 'none') {
    throw new Error('KF_AGENT_PROVIDER must be anthropic or none');
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
  if (provider === 'anthropic') {
    const keyFile = optional(env, 'KF_AGENT_PROVIDER_KEY_FILE');
    if (keyFile === undefined) {
      throw new Error('KF_AGENT_PROVIDER=anthropic needs KF_AGENT_PROVIDER_KEY_FILE');
    }
    const model = optional(env, 'KF_AGENT_PROVIDER_MODEL') ?? 'claude-opus-5-5';
    if (!(PROVIDER_MODELS as readonly string[]).includes(model)) {
      throw new Error(`KF_AGENT_PROVIDER_MODEL must be one of ${PROVIDER_MODELS.join(', ')}`);
    }
    const baseURL = optional(env, 'KF_AGENT_PROVIDER_BASE_URL');
    providerConfig = {
      keyFile,
      model: model as ProviderModel,
      ...(baseURL === undefined ? {} : { baseURL: providerBaseUrl(baseURL) }),
    };
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

/** The models this deployment has, the provider behind its egress guard. */
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
          provider: new ProviderBackend(
            new AnthropicTransport({
              apiKey: () => readOwnerOnlyFile(provider.keyFile, 'provider API key'),
              model: provider.model,
              ...(provider.baseURL === undefined ? {} : { baseURL: provider.baseURL }),
            }),
            { ceiling },
          ),
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
