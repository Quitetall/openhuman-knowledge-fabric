/**
 * The organization lifecycle: deactivate, reactivate, retire.
 *
 * R01 approved this type with states `active, inactive, retired` and `state_machine: null`, so
 * an organization could be created and never retired. Combined with nothing constraining
 * `legal_name`, that made unlimited permanent duplicates reachable by a caller who broke no
 * rule: create the same company repeatedly, and because `core.object` is append-only, every
 * duplicate stays forever. A bootstrap defect produced eight in one session by accident. Done
 * deliberately it degrades the record for good.
 *
 * The transitions themselves are declared in `ontology/state-machines.yaml` and applied by the
 * dispatcher. What lives here is what the registry cannot express: that retiring an organization
 * must say WHY, and that the successor, when there is one, is named on the act rather than left
 * to be inferred.
 */

import type { ActionEffect, PreconditionCheck } from '@kf/actions';
import { ActionRejected } from '@kf/actions';

export const ORGANIZATION_LIFECYCLE_ACTION_IDS = [
  'deactivate_organization',
  'reactivate_organization',
  'retire_organization',
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
 * Every one of these acts targets exactly one organization.
 *
 * Retiring several at once reads as tidying, and tidying is how a record loses things nobody
 * decided to lose. One target, one judgement, one act.
 */
function singleOrganization(targetIds: readonly string[]): string {
  if (targetIds.length !== 1) {
    throw new ActionRejected(
      'precondition_failed',
      'an organization lifecycle act targets exactly one organization; retiring several at ' +
        'once reads as tidying rather than as a decision about each',
      { targets: targetIds.length },
    );
  }
  return targetIds[0]!;
}

export function createOrganizationLifecycleAtoms(): OrganizationLifecycleAtoms {
  /**
   * Retiring is terminal and it is the one act here that cannot be undone by another act in this
   * group: there is no transition out of `retired`. So it carries the heaviest precondition.
   */
  const retirePrecondition: PreconditionCheck = async (tx, request) => {
    const organizationId = singleOrganization(request.targetIds);

    const reason = request.reason?.trim() ?? '';
    if (reason.length < 12) {
      throw new ActionRejected(
        'reason_required',
        'retiring an organization is terminal — there is no transition out of `retired` — so ' +
          'it states why in at least a sentence. "cleanup" is not a reason a later reader can ' +
          'evaluate',
        { organizationId },
      );
    }

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
      const successor = await tx.maybeOne<{ lifecycle_state: string }>(
        `select lifecycle_state from core.object
          where id = $1 and object_type = 'organization'`,
        [successorId],
      );
      if (successor === undefined) {
        throw new ActionRejected(
          'object_not_visible',
          'the named successor organization is not visible from here, so the record would ' +
            'point at nothing',
          { successorId },
        );
      }
      if (successor.lifecycle_state === 'retired') {
        throw new ActionRejected(
          'precondition_failed',
          'the named successor is itself retired, which would leave every record scoped to ' +
            'this organization pointing at another dead end',
          { successorId },
        );
      }
    }

    // People outlive the organization row, and an organization with live people is almost
    // always a mistaken retirement rather than a real one.
    const people = await tx.one<{ count: string }>(
      `select count(*)::text as count from org.person p
         join core.object o on o.id = p.id
        where p.organization = $1 and o.lifecycle_state = 'active'`,
      [organizationId],
    );
    if (Number(people.count) > 0 && successorId === undefined) {
      throw new ActionRejected(
        'precondition_failed',
        `this organization still has ${people.count} active person(s), and no successor was ` +
          'named. Name the organization they move to, or retire them first — otherwise their ' +
          'records belong to a company that no longer exists',
        { organizationId, activePeople: people.count },
      );
    }
  };

  const retireEffect: ActionEffect = async (tx, request, _objects, ctx) => {
    const organizationId = singleOrganization(request.targetIds);
    const successorId = optionalString(request.payload, 'successor_organization_id');
    await tx.query(
      `insert into core.relation (relation_type, source_id, target_id, recorded_by_action)
       select 'supersedes', $1, $2, $3
        where $2::uuid is not null`,
      [successorId ?? null, organizationId, ctx.actionId],
    );
  };

  const deactivatePrecondition: PreconditionCheck = async (_tx, request) => {
    singleOrganization(request.targetIds);
    if ((request.reason?.trim() ?? '').length < 8) {
      throw new ActionRejected(
        'reason_required',
        'deactivating an organization changes what the institution says it is; say why',
        {},
      );
    }
  };

  const reactivatePrecondition: PreconditionCheck = async (_tx, request) => {
    singleOrganization(request.targetIds);
  };

  return {
    name: 'organization-lifecycle',
    ownedActions: ORGANIZATION_LIFECYCLE_ACTION_IDS,
    preconditions: {
      deactivate_organization: deactivatePrecondition,
      reactivate_organization: reactivatePrecondition,
      retire_organization: retirePrecondition,
    },
    effects: { retire_organization: retireEffect },
  };
}
