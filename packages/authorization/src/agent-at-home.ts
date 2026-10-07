/**
 * The agent at home (ADR 0040 decisions 8 and 9, KF-SAS-RQ-271, RQ-274; 20261007300000).
 *
 * Two acts, and the database decides both again (`20261007300000_the_agent_at_home.sql`):
 *
 * - `set_model_routing_policy` — institutional. Records, for the organization it targets, the
 *   highest classification of content that may leave the host, to a provider's model or in a
 *   notification: `none`, `public` or `internal`. `confidential` and `restricted` are refused here
 *   and by the database in every session (KF-ROUTE-001): ADR 0040 decision 8 is not an
 *   organization's to change.
 * - `set_notification_preference` — the performing person's own digest (`daily` or `off`) and
 *   urgent push (`urgent` or `off`). The database takes the person from the sealed context and
 *   refuses an agent (KF-NOTIFY-001).
 */

import {
  ActionRejected,
  assertMeaningfulReason,
  type ActionEffect,
  type ActionReceiptReader,
  type ActionRequest,
  type PreconditionCheck,
} from '@kf/actions';

/** What may leave the host, lowest first. `none` keeps everything on it. */
export const PROVIDER_CEILINGS = ['none', 'public', 'internal'] as const;
export type ProviderCeiling = (typeof PROVIDER_CEILINGS)[number];

/** ADR 0040's default when an organization has set nothing. */
export const DEFAULT_PROVIDER_CEILING: ProviderCeiling = 'internal';

export const DIGEST_SETTINGS = ['daily', 'off'] as const;
export const PUSH_SETTINGS = ['urgent', 'off'] as const;

export const AGENT_AT_HOME_ACTION_IDS = [
  'set_model_routing_policy',
  'set_notification_preference',
] as const;

function refuse(message: string, detail: Record<string, unknown> = {}): never {
  throw new ActionRejected('precondition_failed', message, detail);
}

function oneOf<T extends string>(
  request: ActionRequest,
  key: string,
  allowed: readonly T[],
  fallback?: T,
): T {
  const value = request.payload?.[key] ?? fallback;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    refuse(`${request.actionType} ${key} must be one of ${allowed.join(', ')}`, { field: key });
  }
  return value as T;
}

function assertTargetsOrganization(request: ActionRequest): void {
  if (request.targetIds.length !== 1 || request.targetIds[0] !== request.organizationId) {
    refuse(`${request.actionType} targets the organization it is made in, and nothing else`, {
      expected: [request.organizationId],
      named: [...request.targetIds],
    });
  }
}

// set_model_routing_policy -------------------------------------------------------------------

function ceilingOf(request: ActionRequest): ProviderCeiling {
  const value = request.payload?.['provider_ceiling'];
  if (value === 'confidential' || value === 'restricted') {
    // Said here with the reason; the database says it again in every session (KF-ROUTE-001).
    refuse(
      `KF-ROUTE-001: ${value} content is answered only on the host and never sent to a ` +
        'provider’s model or in a notification (ADR 0040, KF-SAS-RQ-271)',
      { rule: 'KF-ROUTE-001', field: 'provider_ceiling' },
    );
  }
  return oneOf(request, 'provider_ceiling', PROVIDER_CEILINGS);
}

const assertSetModelRoutingPolicy: PreconditionCheck = async (_tx, request) => {
  assertTargetsOrganization(request);
  assertMeaningfulReason(request);
  ceilingOf(request);
};

const setModelRoutingPolicy: ActionEffect = async (tx, request, _objects, ctx) => {
  // organization, set_by, set_by_action, set_at and revision are drawn again by the database from
  // the sealed context (model_routing_policy_bounded); stated so the row satisfies the policy.
  await tx.query(
    `insert into core.model_routing_policy
       (organization_id, provider_ceiling, reason, set_by, set_by_action)
     values ($1, $2, $3, $4, $5)`,
    [
      request.organizationId,
      ceilingOf(request),
      request.reason?.trim() ?? '',
      request.actorId,
      ctx.actionId,
    ],
  );
};

const readRoutingReceipt: ActionReceiptReader = async (tx, actionId) => {
  const row = await tx.maybeOne<{ id: string; revision: string; provider_ceiling: string }>(
    `select id, revision::text, provider_ceiling
       from core.model_routing_policy where set_by_action = $1`,
    [actionId],
  );
  return row === undefined
    ? {}
    : { policyId: row.id, revision: Number(row.revision), providerCeiling: row.provider_ceiling };
};

// set_notification_preference ----------------------------------------------------------------

const assertSetNotificationPreference: PreconditionCheck = async (_tx, request) => {
  assertTargetsOrganization(request);
  oneOf(request, 'digest', DIGEST_SETTINGS, 'daily');
  oneOf(request, 'push', PUSH_SETTINGS, 'urgent');
};

const setNotificationPreference: ActionEffect = async (tx, request, _objects, ctx) => {
  await tx.query(
    `insert into core.notification_preference
       (organization_id, person_id, digest, push, set_by_action)
     values ($1, $2, $3, $4, $5)`,
    [
      request.organizationId,
      request.actorId,
      oneOf(request, 'digest', DIGEST_SETTINGS, 'daily'),
      oneOf(request, 'push', PUSH_SETTINGS, 'urgent'),
      ctx.actionId,
    ],
  );
};

const readPreferenceReceipt: ActionReceiptReader = async (tx, actionId) => {
  const row = await tx.maybeOne<{ digest: string; push: string }>(
    'select digest, push from core.notification_preference where set_by_action = $1',
    [actionId],
  );
  return row === undefined ? {} : { digest: row.digest, push: row.push };
};

export const AGENT_AT_HOME_PRECONDITIONS: Readonly<Record<string, PreconditionCheck>> = {
  set_model_routing_policy: assertSetModelRoutingPolicy,
  set_notification_preference: assertSetNotificationPreference,
};

export const AGENT_AT_HOME_EFFECTS: Readonly<Record<string, ActionEffect>> = {
  set_model_routing_policy: setModelRoutingPolicy,
  set_notification_preference: setNotificationPreference,
};

export const AGENT_AT_HOME_RECEIPTS: Readonly<Record<string, ActionReceiptReader>> = {
  set_model_routing_policy: readRoutingReceipt,
  set_notification_preference: readPreferenceReceipt,
};
