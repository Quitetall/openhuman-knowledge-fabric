import { apiBaseUrl, decodeSuccessfulResponse, parseResponse } from './client';
import { CLASSIFICATIONS, type Classification } from '../auth/types';
import { record } from './validation';

/** One live role assignment the signed-in person holds in the organization asked about. */
export interface SessionAssignment {
  readonly assignmentId: string;
  readonly roleId: string;
  readonly validTo: string | null;
}

/**
 * What the API says the bearer may choose from in one organization: the live assignments and the
 * person's clearance. It is a menu, not a grant — the choice is still validated by the API before
 * the session keeps it, and every later read is authorized again.
 */
export interface SessionAssignments {
  readonly organizationId: string;
  readonly personId: string;
  readonly clearance: Classification;
  readonly assignments: readonly SessionAssignment[];
}

/** More than anyone holds; a longer list is a contract break, not a longer menu. */
const MAX_ASSIGNMENTS = 200;

export function parseSessionAssignments(value: unknown): SessionAssignments {
  const body = record(value);
  const assignments = body?.['assignments'];
  const clearance = body?.['clearance'];
  if (
    body === undefined ||
    typeof body['organizationId'] !== 'string' ||
    typeof body['personId'] !== 'string' ||
    typeof clearance !== 'string' ||
    !CLASSIFICATIONS.some((level) => level === clearance) ||
    !Array.isArray(assignments) ||
    assignments.length > MAX_ASSIGNMENTS
  ) {
    throw new Error('session assignments response did not match contract');
  }
  const parsed = assignments.map((entry) => {
    const assignment = record(entry);
    if (
      assignment === undefined ||
      typeof assignment['assignmentId'] !== 'string' ||
      typeof assignment['roleId'] !== 'string' ||
      !(assignment['validTo'] === null || typeof assignment['validTo'] === 'string')
    ) {
      throw new Error('session assignment did not match contract');
    }
    return {
      assignmentId: assignment['assignmentId'],
      roleId: assignment['roleId'],
      validTo: assignment['validTo'],
    };
  });
  return {
    organizationId: body['organizationId'],
    personId: body['personId'],
    clearance: clearance as Classification,
    assignments: parsed,
  };
}

/**
 * Ask which assignments the bearer holds in `organizationId`. Sends only the bearer token and the
 * organization: there is no acting role yet, which is the point of asking.
 */
export async function getSessionAssignments(
  bearerToken: string,
  organizationId: string,
): Promise<SessionAssignments> {
  const response = await fetch(`${apiBaseUrl()}/session/assignments`, {
    headers: {
      authorization: `Bearer ${bearerToken}`,
      'x-kf-organization': organizationId,
    },
    cache: 'no-store',
  });
  return decodeSuccessfulResponse(await parseResponse(response), parseSessionAssignments);
}
