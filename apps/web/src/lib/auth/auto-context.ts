/**
 * Whether a person who has just signed in needs to be asked which context to act in.
 *
 * The API lists what the person holds (`GET /session/contexts`); this decides only whether there
 * is anything to choose. A person who holds exactly one live assignment, in exactly one
 * organization the API could describe, has nothing to choose: the web proposes that assignment at
 * their full clearance and asks the API, exactly as the picker's button does, before keeping it.
 * Everyone else — nothing held, two or more assignments, or any organization the API could not
 * describe — sees the picker, so nothing they hold is chosen for them.
 *
 * A decision here grants nothing. The proposed context still goes through `confirmContextWithApi`,
 * and a refusal there sends the person to the picker as before.
 */

import type { SessionContexts } from '../api/session-contexts';
import type { AuthorityContext } from './types';

export type ContextDecision =
  { readonly kind: 'auto'; readonly context: AuthorityContext } | { readonly kind: 'choose' };

export function decideContext(contexts: SessionContexts): ContextDecision {
  const organizations = contexts.organizations;
  if (organizations.length !== 1) return { kind: 'choose' };
  const only = organizations[0]!;
  if (only.refused !== null || only.clearance === null || only.assignments.length !== 1) {
    return { kind: 'choose' };
  }
  return {
    kind: 'auto',
    context: {
      actingRoleId: only.assignments[0]!.assignmentId,
      organizationId: only.organizationId,
      maxClassification: only.clearance,
    },
  };
}
