import { isProviderCeiling, type ProviderCeiling } from '@kf/agent';
import {
  apiBaseUrl,
  callerHeaders,
  decodeSuccessfulResponse,
  get,
  parseResponse,
  type Caller,
} from './client';
import { record } from './validation';

/**
 * The organization's model routing policy: what may leave this computer for a cloud model
 * (`GET /model-routing`), and the one act that changes it (`POST /actions/set_model_routing_policy`,
 * institutional: performed by the signed-in person, as their own act; the dispatcher and the
 * database refuse anyone without act authority over the organization, and refuse `confidential`
 * and `restricted` in every session, KF-ROUTE-001).
 */

export interface ModelRouting {
  readonly providerCeiling: ProviderCeiling;
  readonly revision: number | null;
}

export function parseModelRouting(value: unknown): ModelRouting {
  const v = record(value);
  const ceiling = v?.['providerCeiling'];
  if (!isProviderCeiling(ceiling)) throw new Error('model-routing did not match its contract');
  const revision = v?.['revision'];
  return { providerCeiling: ceiling, revision: typeof revision === 'number' ? revision : null };
}

export function getModelRouting(caller: Caller): Promise<ModelRouting> {
  return get('/model-routing', caller, parseModelRouting);
}

/** The person's own act. Only `none` and `internal` are ever sent from this application. */
export async function setModelRouting(
  caller: Caller,
  input: { ceiling: 'none' | 'internal'; reason: string; idempotencyKey: string },
): Promise<unknown> {
  const response = await fetch(`${apiBaseUrl()}/actions/set_model_routing_policy`, {
    method: 'POST',
    headers: callerHeaders(caller),
    body: JSON.stringify({
      targetIds: [caller.organizationId],
      payload: { provider_ceiling: input.ceiling },
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    }),
    cache: 'no-store',
  });
  return decodeSuccessfulResponse(await parseResponse(response), (value) => value);
}
