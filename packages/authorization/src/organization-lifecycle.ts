/**
 * The organization and person lifecycles: deactivate, reactivate, retire.
 *
 * R01 approved `organization` with states `active, inactive, retired` and `person` with
 * `active, inactive`, both with `state_machine: null`. So an organization could be created and
 * never retired, a person could be created and never leave, and — because nothing constrained
 * `legal_name` — the same company could be created without limit and every duplicate stayed
 * forever. A bootstrap defect produced nine in one session by accident. Done deliberately it
 * degrades the record for good.
 *
 * The transitions themselves are declared in `ontology/state-machines.yaml` and applied by the
 * dispatcher. What lives here is what the registry cannot express:
 *
 *   - retiring an organization must say WHY, and names its successor on the act rather than
 *     leaving it to be inferred;
 *   - an organization is retired WITH its people. A person's object is bound to its organization
 *     by row-level security and cannot move, so "move them to the successor" is not a thing the
 *     database can do. What it can do is make them `inactive` under the same act, and refuse to
 *     do that silently: the caller states `with_people: true` or deactivates them first.
 *     The first retirement was done outside the act and left nine active people attributed to
 *     organizations that no longer existed; this is what makes that unrepeatable;
 *   - a person who becomes inactive stops being able to act NOW, not when someone remembers.
 *     Their live role assignments and clearances are end-dated by the same act, and the
 *     clearance retirement is recorded where `explainAccess` looks for it.
 */

import type { ActionEffect, EffectContext, PreconditionCheck } from '@kf/actions';
import { ActionRejected } from '@kf/actions';
import type { Tx } from '@kf/database';

export const ORGANIZATION_LIFECYCLE_ACTION_IDS = [
  'deactivate_organization',
  'reactivate_organization',
  'retire_organization',
  'deactivate_person',
  'reactivate_person',
] as const;

export interface OrganizationLifecycleAtoms {
  readonly name: string;
  readonly ownedActions: readonly string[];
  readonly preconditions: Readonly<Record<string, PreconditionCheck>>;
  readonly effects: Readonly<Record<string, ActionEffect>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function optionalString(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = payload?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Every one of these acts targets exactly one object.
 *
 * Retiring several at once reads as tidying, and tidying is how a record loses things nobody
 * decided to lose. One target, one judgement, one act.
 */
function singleTarget(targetIds: readonly string[], what: string): string {
  if (targetIds.length !== 1) {
    throw new ActionRejected(
      'precondition_failed',
      `a ${what} lifecycle act targets exactly one ${what}; several at once reads as tidying ` +
        'rather than as a decision about each',
      { targets: targetIds.length },
    );
  }
  return targetIds[0]!;
}

function requireReason(reason: string | undefined, minimum: number, why: string): string {
  const trimmed = reason?.trim() ?? '';
  if (trimmed.length < minimum) {
    throw new ActionRejected('reason_required', why, { minimumLength: minimum });
  }
  return trimmed;
}

/**
 * Active people of an organization, as the act sees them: under the caller's row-level scope,
 * which for a lifecycle act on the organization IS that organization.
 */
export async function activePeopleOf(
  tx: Tx,
  organizationId: string,
): Promise<readonly { readonly id: string; readonly display_name: string }[]> {
  return tx.query<{ id: string; display_name: string }>(
    `select p.id, p.display_name from org.person p
       join core.object o on o.id = p.id
      where p.organization = $1 and o.lifecycle_state = 'active'
      order by p.id`,
    [organizationId],
  );
}

/**
 * End everything that lets this person act, as of this act.
 *
 * Nothing is deleted. A role assignment is effective-dated and its `valid_to` closes at the
 * act's instant. A clearance is retired by a row in `org.person_clearance_retirement` naming
 * who retired it, why, and under which act — the row the classification resolver and
 * `explainAccess` already check — and its interval closes at the same instant, so the
 * no-overlap constraint does not keep refusing the person a later grant.
 */
export async function endPersonAuthority(
  tx: Tx,
  input: {
    readonly personId: string;
    readonly organizationId: string;
    readonly actorId: string;
    readonly reason: string;
    readonly ctx: EffectContext;
  },
): Promise<{ readonly roleAssignmentsEnded: number; readonly clearancesRetired: number }> {
  const at = input.ctx.effectiveAt.toISOString();
  const roles = await tx.query<{ id: string }>(
    `update org.role_assignment
        set valid_to = $3
      where subject_id = $1 and scope_id = $2
        and valid_from <= $3 and (valid_to is null or valid_to > $3)
      returning id`,
    [input.personId, input.organizationId, at],
  );
  // Both: the retirement row is the record, and closing the interval keeps
  // `person_clearance_no_overlap` from refusing every later grant to this person.
  const clearances = await tx.query<{ id: string }>(
    `update org.person_clearance c
        set valid_to = $3
      where c.subject_id = $1 and c.organization_id = $2
        and c.valid_from <= $3 and (c.valid_to is null or c.valid_to > $3)
        and not exists (
          select 1 from org.person_clearance_retirement r where r.clearance_id = c.id)
      returning c.id`,
    [input.personId, input.organizationId, at],
  );
  for (const clearance of clearances) {
    await tx.query(
      `insert into org.person_clearance_retirement
         (clearance_id, retired_at, retired_by, retirement_reason, retired_by_action)
       values ($1, $2, $3, $4, $5)`,
      [clearance.id, at, input.actorId, input.reason, input.ctx.actionId],
    );
  }
  return { roleAssignmentsEnded: roles.length, clearancesRetired: clearances.length };
}

/**
 * Move a person to `inactive` under the CURRENT act. The transition guard on `core.object`
 * checks that the action in context is one the ontology lets drive `person` from `active` to
 * `inactive`; `retire_organization` is declared to, so this is not a bypass of the machine — it
 * is the machine, applied to an object the act did not name as a target.
 */
async function deactivatePersonUnderCurrentAct(tx: Tx, personId: string): Promise<void> {
  await tx.query(
    `update core.object
        set lifecycle_state = 'inactive', row_version = row_version + 1
      where id = $1 and object_type = 'person' and lifecycle_state = 'active'`,
    [personId],
  );
}

export function createOrganizationLifecycleAtoms(): OrganizationLifecycleAtoms {
  /**
   * Retiring is terminal and it is the one act here that cannot be undone by another act in this
   * group: there is no transition out of `retired`. So it carries the heaviest precondition.
   */
  const retirePrecondition: PreconditionCheck = async (tx, request) => {
    const organizationId = singleTarget(request.targetIds, 'organization');

    requireReason(
      request.reason,
      12,
      'retiring an organization is terminal — there is no transition out of `retired` — so ' +
        'it states why in at least a sentence. "cleanup" is not a reason a later reader can ' +
        'evaluate',
    );

    const successorId = optionalString(request.payload, 'successor_organization_id');
    if (successorId !== undefined) {
      if (!UUID.test(successorId)) {
        throw new ActionRejected(
          'precondition_failed',
          'successor_organization_id must be a uuid',
          { successorId },
        );
      }
      if (successorId === organizationId) {
        throw new ActionRejected('precondition_failed', 'an organization cannot succeed itself', {
          organizationId,
        });
      }
      // The successor's rows belong to ITSELF and are invisible from this organization's
      // row-level scope — `core.object` and `org.organization` both. The definer function
      // answers existence and retirement and nothing else, which is all this check needs.
      const status = await tx.one<{ present: boolean; retired_at: string | null }>(
        `select present, retired_at from org.organization_retirement($1)`,
        [successorId],
      );
      const successor = status.present ? status : undefined;
      if (successor === undefined) {
        throw new ActionRejected(
          'object_not_visible',
          'the named successor organization does not exist, so the record would point at nothing',
          { successorId },
        );
      }
      if (successor.retired_at !== null) {
        throw new ActionRejected(
          'precondition_failed',
          'the named successor is itself retired, which would leave every record scoped to ' +
            'this organization pointing at another dead end',
          { successorId },
        );
      }
    }

    // People cannot outlive the organization row as active people, and they cannot move. The
    // act either takes them with it — stated, not assumed — or it is refused.
    const people = await activePeopleOf(tx, organizationId);
    const withPeople = request.payload?.['with_people'] === true;
    if (people.length > 0 && !withPeople) {
      throw new ActionRejected(
        'precondition_failed',
        `this organization still has ${people.length} active person(s). A person's record is ` +
          'bound to this organization and cannot move; retiring it makes them inactive and ends ' +
          'their authority under this act. Say so with payload.with_people = true, or ' +
          'deactivate each of them first — otherwise the retirement is refused, because leaving ' +
          'live people attributed to a company that no longer exists is how the record lied ' +
          'the first time',
        {
          organizationId,
          activePeople: people.map((person) => ({ id: person.id, name: person.display_name })),
        },
      );
    }
  };

  const retireEffect: ActionEffect = async (tx, request, _objects, ctx) => {
    const organizationId = singleTarget(request.targetIds, 'organization');
    const successorId = optionalString(request.payload, 'successor_organization_id');
    const reason = request.reason?.trim() ?? '';

    // The denormalised columns the legal-name uniqueness index and later readers use. The
    // dispatcher moves `core.object` to `retired`; `retired_at` is what lets a successor carry
    // the same name, and `succeeded_by` is where this organization's records went.
    //
    // Not a `core.relation`: a relation needs both ends visible under the caller's scope, and
    // the successor is another organization — another scope. The first version of this effect
    // tried to write one and was refused by the policy the first time it was actually run.
    await tx.query(
      `update org.organization
          set retired_at = $2, succeeded_by = $3
        where id = $1 and retired_at is null`,
      [organizationId, ctx.effectiveAt.toISOString(), successorId ?? null],
    );

    for (const person of await activePeopleOf(tx, organizationId)) {
      await endPersonAuthority(tx, {
        personId: person.id,
        organizationId,
        actorId: request.actorId,
        reason: `organization retired: ${reason}`,
        ctx,
      });
      await deactivatePersonUnderCurrentAct(tx, person.id);
    }
  };

  const deactivateOrganizationPrecondition: PreconditionCheck = async (_tx, request) => {
    singleTarget(request.targetIds, 'organization');
    requireReason(
      request.reason,
      8,
      'deactivating an organization changes what the institution says it is; say why',
    );
  };

  const reactivateOrganizationPrecondition: PreconditionCheck = async (_tx, request) => {
    singleTarget(request.targetIds, 'organization');
  };

  const deactivatePersonPrecondition: PreconditionCheck = async (_tx, request) => {
    singleTarget(request.targetIds, 'person');
    requireReason(
      request.reason,
      8,
      'deactivating a person ends their authority to act; the record says why',
    );
    if (request.targetIds[0] === request.actorId) {
      throw new ActionRejected(
        'precondition_failed',
        'a person does not deactivate themself: the act that ends an authority is made by ' +
          'someone who keeps theirs, so there is somebody left who can answer for it',
        { personId: request.actorId },
      );
    }
  };

  /**
   * Ends authority as a consequence of the state change, not as a separate act somebody has to
   * remember. Reactivation deliberately restores NOTHING: authority is re-granted on purpose,
   * through `grant_person_clearance`, with a fresh reason.
   */
  const deactivatePersonEffect: ActionEffect = async (tx, request, objects, ctx) => {
    const personId = singleTarget(request.targetIds, 'person');
    const person = objects.find((object) => object.id === personId);
    if (person === undefined) {
      throw new ActionRejected('object_not_visible', 'the person to deactivate is not visible', {
        personId,
      });
    }
    await endPersonAuthority(tx, {
      personId,
      organizationId: person.organization_id,
      actorId: request.actorId,
      reason: request.reason?.trim() ?? '',
      ctx,
    });
  };

  const reactivatePersonPrecondition: PreconditionCheck = async (_tx, request) => {
    singleTarget(request.targetIds, 'person');
    requireReason(request.reason, 8, 'reactivating a person is a decision; say why');
  };

  return {
    name: 'organization-lifecycle',
    ownedActions: ORGANIZATION_LIFECYCLE_ACTION_IDS,
    preconditions: {
      deactivate_organization: deactivateOrganizationPrecondition,
      reactivate_organization: reactivateOrganizationPrecondition,
      retire_organization: retirePrecondition,
      deactivate_person: deactivatePersonPrecondition,
      reactivate_person: reactivatePersonPrecondition,
    },
    effects: { retire_organization: retireEffect, deactivate_person: deactivatePersonEffect },
  };
}
