import type { CheckFn } from './contracts.js';

/**
 * Live authority with no review date (ADR 0036).
 *
 * Every role assignment and project membership made since ADR 0036 ends within 366 days — the
 * database refuses one that does not. The rows this counts were made before it: grandfathered,
 * still granting, and never reviewed. They stay "no review date" until someone renews them
 * (`kf:grant-authority --renew`), which is a new, attributed assignment.
 *
 * Counts only, per organization, through `core.readiness_assignments_without_review_date()` —
 * the federated shape the search-index check uses — so this runs as the readiness login without
 * a view of anybody's assignments. Assignments the bootstrap identity wrote (the local dogfood
 * loader) are the declared exception and are reported apart: they do not degrade the check.
 */
export const assignmentReviewDates: CheckFn = async (tx) => {
  const rows = await tx.query<{
    organization_id: string;
    role_assignments: string;
    bootstrap_assignments: string;
    project_memberships: string;
  }>(
    `select organization_id, role_assignments::text, bootstrap_assignments::text,
            project_memberships::text
       from core.readiness_assignments_without_review_date()`,
  );
  const sum = (key: 'role_assignments' | 'bootstrap_assignments' | 'project_memberships') =>
    rows.reduce((total, row) => total + Number(row[key]), 0);
  const assignments = sum('role_assignments');
  const bootstrap = sum('bootstrap_assignments');
  const memberships = sum('project_memberships');
  const organizations = rows.filter(
    (row) => Number(row.role_assignments) + Number(row.project_memberships) > 0,
  ).length;
  const measured = {
    organizations: rows.length,
    organizations_with_no_review_date: organizations,
    role_assignments_no_review_date: assignments,
    project_memberships_no_review_date: memberships,
    bootstrap_assignments_no_review_date: bootstrap,
  };
  const bootstrapNote =
    bootstrap === 0
      ? ''
      : ` ${bootstrap} bootstrap-written assignment(s) also have none; they are the declared ` +
        'exception (the local dogfood loader) and do not count against this check.';
  if (assignments + memberships === 0) {
    return {
      id: 'assignment_review_dates',
      status: 'ok',
      detail: `Every live role assignment and project membership has a review date.${bootstrapNote}`,
      measured,
    };
  }
  return {
    id: 'assignment_review_dates',
    status: 'degraded',
    detail:
      `no review date: ${assignments} live role assignment(s) and ${memberships} project ` +
      `membership(s) in ${organizations} organization(s) were made before ADR 0036 and never ` +
      'end. They still grant; nobody has recorded that they still should. Renew each with ' +
      `kf:grant-authority --renew, or end it.${bootstrapNote}`,
    measured,
  };
};
