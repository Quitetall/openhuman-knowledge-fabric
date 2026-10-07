/**
 * The backend router (ADR 0040 decision 8, KF-SAS-RQ-271, RQ-272).
 *
 * The highest classification of everything a turn carries — this turn's context and every earlier
 * answer in the conversation — decides:
 *
 *   - at or below the organization's ceiling (and never above `internal`): a provider's model may
 *     answer, when the deployment configured one; otherwise LAMU on the host;
 *   - above it: LAMU on the host, and only LAMU. With no on-host model, the turn is REFUSED
 *     (KF-ROUTE-004). There is no fallback to a provider, by design and by test.
 *
 * The router chooses; `ProviderBackend` re-checks at the point of egress, so the router is not the
 * only thing between a restricted record and a provider.
 */

import {
  highestOf,
  mayLeaveHost,
  type Classification,
  type MayLeaveHost,
  type ProviderCeiling,
} from './classification.js';
import type { ModelBackend } from './backends.js';

export interface Backends {
  /** LAMU, when the host runs one. */
  readonly onHost?: ModelBackend | undefined;
  /** A provider's model behind its egress guard, when the deployment configured one. */
  readonly provider?: ModelBackend | undefined;
  /** When both may answer, which answers. The deployment's choice; default the provider. */
  readonly prefer?: 'provider' | 'on_host';
}

export type RouteDecision =
  | {
      readonly backend: ModelBackend;
      readonly classification: Classification | undefined;
      readonly why: string;
    }
  | {
      readonly refused: 'KF-ROUTE-004' | 'KF-ROUTE-005';
      readonly classification: Classification | undefined;
      readonly message: string;
    };

export function chooseBackend(
  classifications: Iterable<string>,
  ceiling: ProviderCeiling,
  backends: Backends,
  mayLeave: MayLeaveHost = mayLeaveHost,
): RouteDecision {
  const classification = highestOf(classifications);
  // Nothing from the record at all (an empty context, a first question): as low as it gets.
  const leaves = mayLeave(classification ?? 'public', ceiling);
  if (leaves && backends.provider !== undefined) {
    if (backends.prefer !== 'on_host' || backends.onHost === undefined) {
      return {
        backend: backends.provider,
        classification,
        why: `${classification ?? 'no record'} content, within what this organization lets leave the host (${ceiling})`,
      };
    }
  }
  if (backends.onHost !== undefined) {
    return {
      backend: backends.onHost,
      classification,
      why: leaves
        ? 'answered on the host, as this deployment prefers'
        : `${classification ?? 'record'} content is answered only on the host`,
    };
  }
  if (!leaves) {
    return {
      refused: 'KF-ROUTE-004',
      classification,
      message:
        `KF-ROUTE-004: this turn carries ${classification ?? 'controlled'} content, which is ` +
        'answered only by a model on this host, and none is running. It is not sent to a ' +
        'provider instead (KF-SAS-RQ-271). The records found are listed below.',
    };
  }
  return {
    refused: 'KF-ROUTE-005',
    classification,
    message:
      'KF-ROUTE-005: no model is configured to answer here (no on-host model and no provider). ' +
      'The records found are listed below.',
  };
}
