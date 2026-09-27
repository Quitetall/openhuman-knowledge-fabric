import { apiBaseUrl, decodeSuccessfulResponse, parseResponse } from './client';
import { CLASSIFICATIONS, type Classification } from '../auth/types';
import type { SessionAssignment } from './session-assignments';
import { record } from './validation';

/**
 * One organization the signed-in person holds a live assignment in: its legal name, their
 * clearance there and the assignments, or why the API could not describe it (`refused`, with no
 * assignments and no clearance).
 */
export interface SessionContextOrganization {
  readonly organizationId: string;
  readonly legalName: string;
  readonly clearance: Classification | null;
  readonly assignments: readonly SessionAssignment[];
  readonly refused: string | null;
}

/**
 * What the API says the bearer may choose from, in every organization they hold a live assignment
 * in. A menu, not a grant: the choice is still validated by the API before the session keeps it.
 */
export interface SessionContexts {
  readonly personId: string;
  readonly organizations: readonly SessionContextOrganization[];
}

/** More than anyone holds; a longer list is a contract break, not a longer menu. */
const MAX_ORGANIZATIONS = 64;
const MAX_ASSIGNMENTS = 200;
const MAX_LEGAL_NAME = 512;

function parseAssignment(entry: unknown): SessionAssignment {
  const assignment = record(entry);
  if (
    assignment === undefined ||
    typeof assignment['assignmentId'] !== 'string' ||
    typeof assignment['roleId'] !== 'string' ||
    !(assignment['validTo'] === null || typeof assignment['validTo'] === 'string')
  ) {
    throw new Error('session context assignment did not match contract');
  }
  return {
    assignmentId: assignment['assignmentId'],
    roleId: assignment['roleId'],
    validTo: assignment['validTo'],
  };
}

function parseOrganization(entry: unknown): SessionContextOrganization {
  const held = record(entry);
  const clearance = held?.['clearance'];
  const refused = held?.['refused'];
  const assignments = held?.['assignments'];
  if (
    held === undefined ||
    typeof held['organizationId'] !== 'string' ||
    typeof held['legalName'] !== 'string' ||
    held['legalName'].length > MAX_LEGAL_NAME ||
    !Array.isArray(assignments) ||
    assignments.length > MAX_ASSIGNMENTS
  ) {
    throw new Error('session context organization did not match contract');
  }
  // Exactly one of: described (a clearance, at least one assignment) or refused (a code, none).
  const described =
    refused === null &&
    typeof clearance === 'string' &&
    CLASSIFICATIONS.some((level) => level === clearance) &&
    assignments.length > 0;
  const refusal =
    typeof refused === 'string' && refused !== '' && clearance === null && assignments.length === 0;
  if (!described && !refusal) {
    throw new Error('session context organization did not match contract');
  }
  return {
    organizationId: held['organizationId'],
    legalName: held['legalName'],
    clearance: described ? (clearance as Classification) : null,
    assignments: assignments.map(parseAssignment),
    refused: refusal ? (refused as string) : null,
  };
}

export function parseSessionContexts(value: unknown): SessionContexts {
  const body = record(value);
  const organizations = body?.['organizations'];
  if (
    body === undefined ||
    typeof body['personId'] !== 'string' ||
    !Array.isArray(organizations) ||
    organizations.length > MAX_ORGANIZATIONS
  ) {
    throw new Error('session contexts response did not match contract');
  }
  const parsed = organizations.map(parseOrganization);
  if (new Set(parsed.map((held) => held.organizationId)).size !== parsed.length) {
    throw new Error('session contexts response did not match contract');
  }
  return { personId: body['personId'], organizations: parsed };
}

/**
 * Ask which assignments the bearer holds, in every organization. Sends only the bearer token:
 * whose holdings these are is the token's to say, and no organization is named.
 */
export async function getSessionContexts(bearerToken: string): Promise<SessionContexts> {
  const response = await fetch(`${apiBaseUrl()}/session/contexts`, {
    headers: { authorization: `Bearer ${bearerToken}` },
    cache: 'no-store',
  });
  return decodeSuccessfulResponse(await parseResponse(response), parseSessionContexts);
}
