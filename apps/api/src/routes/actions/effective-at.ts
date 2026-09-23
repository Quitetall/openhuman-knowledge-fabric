const CANONICAL_EFFECTIVE_AT =
  /^(?!0000-)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;

export function parseEffectiveAt(value: unknown): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !CANONICAL_EFFECTIVE_AT.test(value)) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    return undefined;
  }
  return new Date(milliseconds);
}

/**
 * How far a caller-supplied effective time may sit from now.
 *
 * `effectiveAt` states when something happened, as opposed to when it was recorded, and it is
 * what an audit reader believes. Unbounded, any caller could date an approval before the
 * review it depended on or after a deadline it missed, and the record would say so forever.
 * The format check proved only that the value was a timestamp.
 */
export interface EffectiveAtBounds {
  /** Clock skew tolerated for a value slightly ahead of this host. */
  readonly maxFutureSkewMs: number;
  /** How far back a caller may date an action by default. */
  readonly maxBackdateMs: number;
  /** Action types that may be dated further back than that (a deliberate, reviewed list). */
  readonly backdatableActions: ReadonlySet<string>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_EFFECTIVE_AT_BOUNDS: EffectiveAtBounds = {
  maxFutureSkewMs: 5 * 60 * 1000,
  maxBackdateMs: 30 * DAY_MS,
  backdatableActions: new Set(),
};

/** Why this effective time is refused, or undefined when it is within bounds. */
export function effectiveAtOutOfBounds(
  effectiveAt: Date,
  actionType: string,
  bounds: EffectiveAtBounds,
  now: number = Date.now(),
): string | undefined {
  const at = effectiveAt.valueOf();
  // Future is refused for every action type: nothing has happened yet at a future instant.
  if (at > now + bounds.maxFutureSkewMs) {
    return 'effectiveAt is in the future; an action cannot have taken effect yet';
  }
  if (at < now - bounds.maxBackdateMs && !bounds.backdatableActions.has(actionType)) {
    const days = Math.round(bounds.maxBackdateMs / DAY_MS);
    return `effectiveAt is more than ${days} day(s) in the past, and ${actionType} may not be backdated that far`;
  }
  return undefined;
}
