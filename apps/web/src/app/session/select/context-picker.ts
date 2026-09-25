/**
 * What the context picker offers, decided without a server so it can be checked on its own.
 *
 * Everything here narrows a menu the API already returned; none of it grants anything. The
 * choice the person submits still goes to `/auth/context`, which asks the API before keeping it.
 */

import { ApiError, type SessionAssignment } from '../../../lib/api';
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
