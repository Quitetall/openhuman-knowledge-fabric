/**
 * What the header calls the signed-in person, their role and their organization: names, never ids.
 *
 * Display only. It is a snapshot of the API's menu (`GET /session/contexts`) and the identity
 * provider's `name` claim, sealed in a cookie of its own so a page renders it without asking the
 * API on every request. It authorizes nothing: the session's context is still the API-validated
 * one, and the label is shown only for the context in use — an assignment or organization it does
 * not name is shown by a generic word, never by another context's name.
 */

import type { SessionContexts } from '../api/session-contexts';
import type { AuthorityContext } from './types';

export interface IdentityLabel {
  readonly subject: string;
  readonly personName: string | null;
  readonly organizations: readonly { readonly id: string; readonly name: string }[];
  readonly assignments: readonly { readonly id: string; readonly roleId: string }[];
}

/** Enough for anyone; a longer menu is labelled generically rather than overflowing a cookie. */
const MAX_LABELLED_ORGANIZATIONS = 16;
const MAX_LABELLED_ASSIGNMENTS = 32;
const MAX_NAME = 120;

function cleanName(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').trim();
  return name === '' ? null : name.slice(0, MAX_NAME);
}

export function identityLabel(
  subject: string,
  personName: string | null | undefined,
  contexts: SessionContexts,
): IdentityLabel {
  return {
    subject,
    personName: cleanName(personName),
    organizations: contexts.organizations.slice(0, MAX_LABELLED_ORGANIZATIONS).map((held) => ({
      id: held.organizationId,
      name: cleanName(held.legalName) ?? 'Your organization',
    })),
    assignments: contexts.organizations
      .flatMap((held) => held.assignments)
      .slice(0, MAX_LABELLED_ASSIGNMENTS)
      .map((assignment) => ({ id: assignment.assignmentId, roleId: assignment.roleId })),
  };
}

/** A role id from the ontology's closed vocabulary, as words: `quality_engineer` → "Quality engineer". */
export function roleWords(roleId: string): string {
  const words = roleId.replaceAll('_', ' ').trim();
  return words === '' ? roleId : `${words[0]!.toUpperCase()}${words.slice(1)}`;
}

/**
 * Who can see what, in words a person recognises. The value sent to the API is still the
 * classification's id; only what is shown changes.
 */
export const CLASSIFICATION_WORDS: Readonly<Record<string, string>> = {
  public: 'Anyone, including outside the company',
  internal: 'Everyone in the company',
  confidential: 'Confidential: a smaller group',
  restricted: 'Restricted: the fewest people',
};

/** The short form, for a header or a badge. */
export const CLASSIFICATION_SHORT: Readonly<Record<string, string>> = {
  public: 'Public',
  internal: 'Company',
  confidential: 'Confidential',
  restricted: 'Restricted',
};

export function classificationWords(classification: string): string {
  return CLASSIFICATION_WORDS[classification] ?? classification;
}

export interface IdentityLine {
  readonly person: string;
  readonly role: string;
  readonly organization: string;
  /** What the person can see at most, in words. */
  readonly ceiling: string;
}

/**
 * The header's line for `context`, from the label when it names that context. Every part has a
 * word to fall back on, so no id is ever shown in its place.
 */
export function identityLine(
  label: IdentityLabel | undefined,
  context: AuthorityContext,
): IdentityLine {
  const organization = label?.organizations.find(
    (held) => held.id.toLowerCase() === context.organizationId.toLowerCase(),
  );
  const assignment = label?.assignments.find(
    (held) => held.id.toLowerCase() === context.actingRoleId.toLowerCase(),
  );
  return {
    person: label?.personName ?? 'Signed in',
    role: assignment === undefined ? 'Your role' : roleWords(assignment.roleId),
    organization: organization?.name ?? 'Your organization',
    ceiling: CLASSIFICATION_SHORT[context.maxClassification] ?? context.maxClassification,
  };
}
