import { PrincipalRefused, setResolvedAccessContext, type Tx } from '@kf/database';
import { asActionRefusal } from './refusals.js';
import {
  ActionRejected,
  MINIMUM_REASON_LENGTH,
  resolveDispatcherOptions,
  type ActionDefinition,
  type ActionRequest,
  type DispatcherOptions,
  type ObjectRow,
  type TransactionalActionPreflight,
} from './contracts.js';

const CANONICAL_EFFECTIVE_AT =
  /^(?!0000-)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;

export function assertActionAvailable(
  actionType: string,
  allowedActions: ReadonlySet<string> | undefined,
): void {
  if (allowedActions !== undefined && !allowedActions.has(actionType)) {
    throw new ActionRejected(
      'unknown_action',
      `action type '${actionType}' is not available through this dispatcher`,
      { actionType, dispatcherAvailable: false },
    );
  }
}

/** Refuse Date values PostgreSQL or canonical RFC 3339 cannot reproduce exactly. */
export function assertCanonicalEffectiveAt(request: ActionRequest): void {
  const effectiveAt = request.effectiveAt;
  if (effectiveAt === undefined) return;
  if (!(effectiveAt instanceof Date) || Number.isNaN(effectiveAt.valueOf())) {
    throw new ActionRejected(
      'precondition_failed',
      'effectiveAt must be a canonical four-digit-year RFC 3339 millisecond instant',
    );
  }
  const timestamp = effectiveAt.toISOString();
  if (!CANONICAL_EFFECTIVE_AT.test(timestamp)) {
    throw new ActionRejected(
      'precondition_failed',
      'effectiveAt must be a canonical four-digit-year RFC 3339 millisecond instant',
    );
  }
}

export async function loadDefinition(tx: Tx, actionType: string): Promise<ActionDefinition> {
  const row = await tx.maybeOne<{
    id: string;
    transactional: boolean;
    requires_capability: 'act' | null;
    requires_qualification?: boolean;
  }>(
    `select id, transactional, requires_capability, requires_qualification
       from registry.action_type where id = $1`,
    [actionType],
  );
  if (row === undefined) {
    throw new ActionRejected('unknown_action', `no such action type '${actionType}'`, {
      actionType,
    });
  }

  const transitions = await tx.query<{ machine: string; from_state: string; to_state: string }>(
    `select object_type as machine, from_state, to_state
       from registry.state_transition where action_id = $1`,
    [actionType],
  );
  return {
    id: row.id,
    transactional: row.transactional,
    requiresCapability: row.requires_capability,
    requiresQualification: row.requires_qualification === true,
    transitions: transitions.map((transition) => ({
      machine: transition.machine,
      from: transition.from_state,
      to: transition.to_state,
    })),
  };
}

export async function assertRoleHeld(tx: Tx, actorId: string, roleId: string): Promise<void> {
  const held = await tx.maybeOne<{ ok: boolean }>('select org.holds_role($1, $2) as ok', [
    actorId,
    roleId,
  ]);
  if (held?.ok !== true) {
    throw new ActionRejected('role_not_held', 'the actor does not hold that role', {
      actorId,
      roleId,
    });
  }
}

/**
 * ADR 0016: an action that declares `requires: act` needs a live act grant reaching every
 * target — directly, or through a role assignment the actor holds — or the organization.
 * Checked AFTER the targets are locked, under the bound access context, through the same view
 * the read side uses, so a refusal here and an explanation elsewhere cannot disagree.
 */
export async function assertActCovered(
  tx: Tx,
  request: ActionRequest,
  definition: ActionDefinition,
  targetIds: readonly string[],
): Promise<void> {
  if (definition.requiresCapability !== 'act') return;
  // ADR 0020: a service actor does routine work under authority somebody granted; it never
  // authorizes, approves, grants, allocates or resolves, whatever grants reach it.
  const kind = await tx.maybeOne<{ person_kind: string }>(
    'select person_kind from org.person where id = $1',
    [request.actorId],
  );
  if (kind?.person_kind === 'service') {
    throw new ActionRejected(
      'act_not_granted',
      `${request.actionType} is an institutional act; a service actor cannot perform one (ADR 0020)`,
      { actionType: request.actionType, actorId: request.actorId },
    );
  }
  const covered = await tx.one<{ ok: boolean }>(
    'select org.act_grant_reaches($1, $2, $3::uuid[]) as ok',
    [request.actorId, request.organizationId, [...targetIds]],
  );
  if (!covered.ok) {
    throw new ActionRejected(
      'act_not_granted',
      `${request.actionType} requires act authority at the target's scope, and no live act ` +
        'grant reaches this actor there',
      { actionType: request.actionType, targetIds: [...targetIds] },
    );
  }
}

/**
 * ADR 0038 decision 8 (KF-SAS-RQ-258): an act that declares `requires_qualification` needs the
 * actor's current credit for every in-force requirement that gates it, organization-wide or scoped
 * to one of its targets. Asked of the same database function the `core.action` trigger asks
 * (`org.qualification_gaps_for_act`), after act-grant coverage, so an absent grant is refused as
 * `act_not_granted` before qualification is considered: qualification never stands in for
 * authority. The refusal names the requirement; the database's own refusal says the same if a
 * caller did not come through here.
 */
export async function assertQualified(
  tx: Tx,
  request: ActionRequest,
  definition: ActionDefinition,
  targetIds: readonly string[],
): Promise<void> {
  if (definition.requiresQualification !== true) return;
  const gaps = await tx.query<{
    requirement_key: string;
    revision: number;
    outcome: string;
    credited_revision: number | null;
  }>(
    `select requirement_key, revision, outcome, credited_revision
       from org.qualification_gaps_for_act($1, $2, $3, $4::uuid[])
      order by requirement_key`,
    [request.actorId, request.organizationId, request.actionType, [...targetIds]],
  );
  const gap = gaps[0];
  if (gap === undefined) return;
  throw new ActionRejected(
    'precondition_failed',
    `KF-QUAL-001: ${request.actionType} requires qualification "${gap.requirement_key}" ` +
      `(revision ${String(gap.revision)}): ${gap.outcome}. ` +
      (gap.credited_revision === null
        ? 'No evidence for it has been credited to this person'
        : `The credit at revision ${String(gap.credited_revision)} predates a revision that ` +
          'changed required behaviour'),
    {
      rule: 'KF-QUAL-001',
      actionType: request.actionType,
      requirement: gap.requirement_key,
      revision: gap.revision,
      missing: gaps.map((g) => g.requirement_key),
    },
  );
}

export function assertReasonPresent(request: ActionRequest, reasonRequired: ReadonlySet<string>) {
  if (reasonRequired.has(request.actionType)) assertMeaningfulReason(request);
}

/**
 * A required reason must say something: at least MINIMUM_REASON_LENGTH characters once trimmed,
 * and not one character repeated. Filler passes a presence check and defeats its purpose.
 */
export function assertMeaningfulReason(request: ActionRequest): void {
  const reason = request.reason?.trim() ?? '';
  const distinct = new Set(reason.replace(/\s+/g, '').toLowerCase()).size;
  if (reason.length < MINIMUM_REASON_LENGTH || distinct < 3) {
    throw new ActionRejected(
      'reason_required',
      `${request.actionType} requires a reason of at least ${MINIMUM_REASON_LENGTH} characters that says why`,
      { actionType: request.actionType },
    );
  }
}

export async function bindResolvedAccessContext(tx: Tx, request: ActionRequest): Promise<void> {
  try {
    await setResolvedAccessContext(tx, {
      subjectId: request.actorId,
      assignmentId: request.actingRoleId,
      organizationId: request.organizationId,
      requestedClassification: request.maxClassification,
      attestation: request.attestation,
    });
  } catch (error: unknown) {
    if (error instanceof PrincipalRefused && error.reason === 'not_attested') {
      throw new ActionRejected(
        'not_attested',
        'nobody attested that the actor is present; identify again',
      );
    }
    if (error instanceof PrincipalRefused && error.reason === 'role_not_held') {
      throw new ActionRejected(
        'role_not_held',
        'the acting role is not held live in this organization',
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
    if (code === '42501' || code === 'P0001' || /classification|clearance/i.test(message)) {
      throw new ActionRejected('classification_not_granted', 'classification ceiling refused');
    }
    throw error;
  }
}

/**
 * Build read-only, non-authoritative action preflight.
 *
 * Passing never authorizes action: caller must run transactional dispatcher, which repeats
 * every check. Prospective objects are accepted only for registered creation materializers.
 */
export function createTransactionalPreflight(
  options: DispatcherOptions = {},
): TransactionalActionPreflight {
  const resolved = resolveDispatcherOptions(options);

  return async function preflightAction(
    tx: Tx,
    request: ActionRequest,
    prospectiveObjects: readonly ObjectRow[] = [],
  ): Promise<void> {
    try {
      await preflight(tx, request, prospectiveObjects);
    } catch (error: unknown) {
      throw asActionRefusal(error);
    }
  };

  async function preflight(
    tx: Tx,
    request: ActionRequest,
    prospectiveObjects: readonly ObjectRow[],
  ): Promise<void> {
    assertActionAvailable(request.actionType, resolved.allowedActions);
    assertCanonicalEffectiveAt(request);
    const definition = await loadDefinition(tx, request.actionType);
    // Role ownership is an authority fact, not a classified record. The database helper is
    // SECURITY DEFINER so this check remains independent of the later reader ceiling.
    await assertRoleHeld(tx, request.actorId, request.actingRoleId);
    await bindResolvedAccessContext(tx, request);
    assertReasonPresent(request, resolved.reasonRequired);
    await assertActCovered(tx, request, definition, [
      ...request.targetIds,
      ...prospectiveObjects.map((object) => object.id),
    ]);
    await assertQualified(tx, request, definition, [
      ...request.targetIds,
      ...prospectiveObjects.map((object) => object.id),
    ]);

    if (prospectiveObjects.length > 0) {
      if (
        request.targetIds.length > 0 ||
        resolved.materializers[request.actionType] === undefined
      ) {
        throw new ActionRejected(
          'precondition_failed',
          'prospective objects are allowed only for a creation action preflight',
          { actionType: request.actionType },
        );
      }
      if (
        new Set(prospectiveObjects.map((object) => object.id)).size !== prospectiveObjects.length ||
        prospectiveObjects.some((object) => object.organization_id !== request.organizationId)
      ) {
        throw new ActionRejected(
          'precondition_failed',
          'prospective objects must be unique and belong to the action organization',
          { actionType: request.actionType },
        );
      }
    }

    const objects =
      request.targetIds.length === 0
        ? [...prospectiveObjects]
        : await tx.query<ObjectRow>(
            `select id, object_type, lifecycle_state, row_version, organization_id, created_by
               from core.object where id = any($1::uuid[])`,
            [request.targetIds],
          );
    if (request.targetIds.length > 0 && objects.length !== request.targetIds.length) {
      throw new ActionRejected(
        'object_not_visible',
        'one or more targets do not exist or are not visible to this actor',
        { requested: request.targetIds.length, found: objects.length },
      );
    }

    const check = resolved.preconditions[request.actionType];
    if (check !== undefined) await check(tx, request, objects);
  }
}
