/**
 * What the context picker offers, decided without a server so it can be checked on its own.
 *
 * Everything here narrows a menu the API already returned; none of it grants anything. The
 * choice the person submits still goes to `/auth/context`, which asks the API before keeping it.
 */

import {
  ApiError,
  type SessionAssignment,
  type SessionContextOrganization,
} from '../../../lib/api';
import { CLASSIFICATIONS, type AuthorityContext, type Classification } from '../../../lib/auth';

/** A role id from the ontology's closed vocabulary, as words: `work_order_manager` → "Work order manager". */
export function roleName(roleId: string): string {
  const words = roleId.replaceAll('_', ' ').trim();
  return words === '' ? roleId : `${words[0]!.toUpperCase()}${words.slice(1)}`;
}

/** The end of an assignment as a UTC date, or that it has none. Never a guessed local date. */
export function validUntil(validTo: string | null): string {
  if (validTo === null) return 'no end date';
  const date = new Date(validTo);
  if (Number.isNaN(date.getTime())) return `valid until ${validTo}`;
  return `valid until ${date.toISOString().slice(0, 10)} (UTC)`;
}

/**
 * Ceilings the person can ask for: their clearance and every level below it. A higher one would
 * only be refused by the API, so it is not offered.
 */
export function ceilingOptions(clearance: Classification): readonly Classification[] {
  return CLASSIFICATIONS.slice(0, CLASSIFICATIONS.indexOf(clearance) + 1);
}

/**
 * The ceiling preselected: the one already in use when this is a change of context within the
 * same organization and it is still allowed, otherwise the person's clearance.
 */
export function defaultCeiling(
  clearance: Classification,
  current: AuthorityContext | undefined,
  organizationId: string,
): Classification {
  if (
    current !== undefined &&
    current.organizationId === organizationId &&
    ceilingOptions(clearance).includes(current.maxClassification)
  ) {
    return current.maxClassification;
  }
  return clearance;
}

/** The assignment preselected: the only one, else the one in use now, else none. */
export function preselectedAssignment(
  assignments: readonly SessionAssignment[],
  current: AuthorityContext | undefined,
): string | undefined {
  if (assignments.length === 1) return assignments[0]!.assignmentId;
  return assignments.find((assignment) => assignment.assignmentId === current?.actingRoleId)
    ?.assignmentId;
}

/** Why the assignments could not be listed, in the person's terms. */
export function assignmentsFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'no_live_assignment') {
      return 'You hold no live role assignment in this organization, so there is nothing to choose.';
    }
    if (error.code === 'no_clearance') {
      return 'No clearance is recorded for you in this organization, so no visibility ceiling can be offered.';
    }
    if (error.status === 401) {
      return 'The API did not accept your sign-in. It may have just expired: sign out and sign in again.';
    }
    if (error.isRefusal) return `The API refused to list your assignments: ${error.message}`;
  }
  return 'The API could not list your assignments just now.';
}

/**
 * The organizations in the order offered: the one whose context is in use, then the deployment's
 * preferred one (KF_WEB_ORGANIZATION), then the rest as the API listed them. Only reorders: an
 * organization is offered because the API listed it, never because it is preferred.
 */
export function orderOrganizations(
  organizations: readonly SessionContextOrganization[],
  current: AuthorityContext | undefined,
  preferred: string | undefined,
): readonly SessionContextOrganization[] {
  const rank = (organizationId: string): number => {
    const id = organizationId.toLowerCase();
    if (current !== undefined && id === current.organizationId.toLowerCase()) return 0;
    if (preferred !== undefined && id === preferred.toLowerCase()) return 1;
    return 2;
  };
  return organizations
    .map((organization, index) => ({ organization, index }))
    .sort(
      (a, b) =>
        rank(a.organization.organizationId) - rank(b.organization.organizationId) ||
        a.index - b.index,
    )
    .map(({ organization }) => organization);
}

/** What to call an organization: its legal name, or its id when the API gave no name. */
export function organizationName(organization: SessionContextOrganization): string {
  const name = organization.legalName.trim();
  return name === '' ? organization.organizationId : name;
}

/** Why one listed organization offers nothing to choose, in the person's terms. */
export function organizationRefusal(code: string): string {
  if (code === 'classification_not_granted') {
    return 'You hold an assignment here, but no clearance is recorded for you, so no visibility ceiling can be offered.';
  }
  if (code === 'role_not_held') {
    return 'Your assignment here could not be confirmed just now; it may have just ended.';
  }
  return `The API could not describe this organization for you (${code}).`;
}

/** Why the organizations could not be listed at all, in the person's terms. */
export function contextsFailure(error: unknown): string {
  if (error instanceof ApiError && error.code === 'no_live_assignment') {
    return 'You hold no live role assignment in any organization, so there is nothing to choose.';
  }
  return assignmentsFailure(error);
}
