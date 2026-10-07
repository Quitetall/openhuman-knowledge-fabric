/**
 * What may leave the host, decided by classification (ADR 0040 decision 8, KF-SAS-RQ-271, RQ-274).
 *
 * One comparison, used by the router, the provider's egress guard and the notifications alike,
 * so the three cannot disagree. Two limits apply at once:
 *
 *   - the ABSOLUTE limit: `confidential` and `restricted` never leave, whatever an organization
 *     set. ADR 0040 decision 8 is not an organization's to change, and the database refuses such a
 *     ceiling too (KF-ROUTE-001);
 *   - the organization's CEILING (`none`, `public` or `internal`, `core.model_routing_policy`).
 *
 * Fail closed throughout: an unknown classification ranks above everything, so it never leaves.
 */

export const CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const PROVIDER_CEILINGS = ['none', 'public', 'internal'] as const;
export type ProviderCeiling = (typeof PROVIDER_CEILINGS)[number];

/** ADR 0040's default when an organization has set nothing. */
export const DEFAULT_PROVIDER_CEILING: ProviderCeiling = 'internal';

/** The highest classification anything may carry off the host, whatever the ceiling says. */
export const ABSOLUTE_LIMIT: Classification = 'internal';

const RANK: Readonly<Record<string, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

/** A classification's rank; anything unknown ranks above `restricted`. */
export function rankOf(classification: string): number {
  return RANK[classification] ?? Number.POSITIVE_INFINITY;
}

/** The highest of `classifications`, or undefined for none. An unknown one is `restricted`. */
export function highestOf(classifications: Iterable<string>): Classification | undefined {
  let highest: Classification | undefined;
  for (const classification of classifications) {
    const known = (CLASSIFICATIONS as readonly string[]).includes(classification)
      ? (classification as Classification)
      : 'restricted';
    if (highest === undefined || rankOf(known) > rankOf(highest)) highest = known;
  }
  return highest;
}

export function isProviderCeiling(value: unknown): value is ProviderCeiling {
  return typeof value === 'string' && (PROVIDER_CEILINGS as readonly string[]).includes(value);
}

/**
 * Whether content of `classification` may leave the host under `ceiling`: to a provider's model,
 * or in a notification. Never above `internal`; never under `none`.
 */
export type MayLeaveHost = (classification: string, ceiling: ProviderCeiling) => boolean;

export const mayLeaveHost: MayLeaveHost = (classification, ceiling) => {
  if (ceiling === 'none' || !isProviderCeiling(ceiling)) return false;
  const rank = rankOf(classification);
  return rank <= rankOf(ABSOLUTE_LIMIT) && rank <= rankOf(ceiling);
};
