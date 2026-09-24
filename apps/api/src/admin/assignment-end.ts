/**
 * When a role assignment made by an admin command ends (ADR 0036).
 *
 * Every new assignment carries a review date at most a year and a day after it starts, and the
 * database refuses one that does not (`20260925153600`). The commands that write assignments ask
 * for it as `--valid-to` and default it to one year, so an operator who says nothing still makes
 * an assignment that ends — and the refusal for a date the database would refuse is made here,
 * with the reason, before anything is written.
 */

/** The longest an assignment may run: a year and a day. The database holds the same number. */
export const ASSIGNMENT_MAX_DAYS = 366;

/**
 * The default: one year. 365 rather than a calendar year, which is 366 days across a leap day and
 * would then sit on the ceiling, where the database's clock (the transaction's start, slightly
 * before this one) would put it a few milliseconds over.
 */
export const ASSIGNMENT_DEFAULT_DAYS = 365;

const DAY_MS = 86_400_000;

export type AssignmentEnd =
  | { readonly ok: true; readonly validTo: Date; readonly defaulted: boolean }
  | { readonly ok: false; readonly refusal: string };

/**
 * `YYYY-MM-DD` (the start of that day, UTC) or a full ISO-8601 instant. Must be in the future and
 * no more than {@link ASSIGNMENT_MAX_DAYS} days after `now`.
 */
export function resolveAssignmentEnd(
  value: string | undefined,
  now: Date,
  flag = '--valid-to',
): AssignmentEnd {
  if (value === undefined) {
    return {
      ok: true,
      validTo: new Date(now.getTime() + ASSIGNMENT_DEFAULT_DAYS * DAY_MS),
      defaulted: true,
    };
  }
  const text = value.trim();
  const shaped =
    /^\d{4}-\d{2}-\d{2}$/.test(text) ||
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.test(text);
  const parsed = shaped
    ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : text)
    : undefined;
  if (parsed === undefined || Number.isNaN(parsed.getTime())) {
    return {
      ok: false,
      refusal: `${flag} must be a date (YYYY-MM-DD) or an ISO-8601 instant with a zone, got ${JSON.stringify(value)}`,
    };
  }
  if (parsed.getTime() <= now.getTime()) {
    return {
      ok: false,
      refusal: `${flag} ${text} is not in the future: an assignment that has already ended grants nothing`,
    };
  }
  if (parsed.getTime() > now.getTime() + ASSIGNMENT_MAX_DAYS * DAY_MS) {
    return {
      ok: false,
      refusal:
        `${flag} ${text} is more than ${ASSIGNMENT_MAX_DAYS} days away. A year and a day is the ` +
        'longest an assignment runs before somebody reviews it (ADR 0036); renew it before then ' +
        'with --renew.',
    };
  }
  return { ok: true, validTo: parsed, defaulted: false };
}
