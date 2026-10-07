/**
 * Access grants — the positive side of need-to-know (ADR 0016).
 *
 * Three things live here and nowhere else: the single write of a grant, the resolver that
 * turns a person's live grants into "which objects are covered", and the explanation that
 * walks the same facts in order and names the step that decided. The permitted set
 * (`@kf/documents`) and the explanation read ONE view, `org.effective_access_grant`, so an
 * explanation can never disagree with what the corpus contains.
 */

import { ActionRejected, DEFAULT_SEPARATION_OF_DUTY, type ActionEffect } from '@kf/actions';
import { digest } from '@kf/canonicalization';
import type { Tx } from '@kf/database';

export type AccessCapability = 'read' | 'act';
export type AccessPrincipalKind = 'person' | 'role_assignment';

export interface AccessGrantWrite {
  readonly organizationId: string;
  readonly principalKind: AccessPrincipalKind;
  readonly principalId: string;
  readonly capability: AccessCapability;
  readonly scopeObjectId: string;
  readonly classificationCeiling?: string;
  readonly validFrom?: Date;
  readonly validTo?: Date;
  readonly grantedBy: string;
  readonly grantedByAction: string;
  readonly delegatedFrom?: string;
  readonly reason: string;
}

/** The single write. A dispatched effect and any future bootstrap path both come through here. */
export async function insertAccessGrant(tx: Tx, grant: AccessGrantWrite): Promise<string> {
  if (grant.reason.trim() === '') {
    throw new Error('an access grant needs a reason: the record has to say why it was made');
  }
  const row = await tx.one<{ id: string }>(
    `insert into org.access_grant
       (organization_id, principal_kind, principal_id, capability, scope_object_id,
        classification_ceiling, valid_from, valid_to, granted_by, granted_by_action,
        delegated_from, reason)
     values ($1,$2,$3,$4,$5,$6,coalesce($7::timestamptz, now()),$8,$9,$10,$11,$12)
     returning id`,
    [
      grant.organizationId,
      grant.principalKind,
      grant.principalId,
      grant.capability,
      grant.scopeObjectId,
      grant.classificationCeiling ?? null,
      grant.validFrom ?? null,
      grant.validTo ?? null,
      grant.grantedBy,
      grant.grantedByAction,
      grant.delegatedFrom ?? null,
      grant.reason.trim(),
    ],
  );
  return row.id;
}

function payloadString(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = payload?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * `grant_access` targets the scope object and names the principal and capability in its
 * payload. No materializer: it creates no object, it changes what an existing one may be
 * reached by. The exclusion constraint refuses an overlapping live grant; that surfaces as a
 * precondition failure, not a 500, because "already granted" is a fact about the record.
 */
export const grantAccessEffect: ActionEffect = async (tx, request, objects, ctx) => {
  const scope = objects.find((object) => request.targetIds.includes(object.id));
  if (scope === undefined) {
    throw new Error('grant_access must target the object being made reachable');
  }
  const principalKind = payloadString(request.payload, 'principal_kind');
  const principalId = payloadString(request.payload, 'principal_id');
  const capability = payloadString(request.payload, 'capability');
  const ceiling = payloadString(request.payload, 'classification_ceiling');
  const validTo = payloadString(request.payload, 'valid_to');
  if (principalKind !== 'person' && principalKind !== 'role_assignment') {
    throw new ActionRejected(
      'precondition_failed',
      'grant_access needs principal_kind of person or role_assignment in its payload',
    );
  }
  if (principalId === undefined || !UUID.test(principalId)) {
    throw new ActionRejected(
      'precondition_failed',
      'grant_access needs principal_id (a uuid) in its payload: authority is granted to somebody',
    );
  }
  if (capability !== 'read' && capability !== 'act') {
    throw new ActionRejected(
      'precondition_failed',
      'grant_access needs capability of read or act in its payload',
    );
  }
  const reason = request.reason;
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new ActionRejected('precondition_failed', 'grant_access needs a reason');
  }
  let validToDate: Date | undefined;
  if (validTo !== undefined) {
    validToDate = new Date(validTo);
    if (Number.isNaN(validToDate.getTime())) {
      throw new ActionRejected('precondition_failed', 'grant_access valid_to is not a timestamp');
    }
  }
  try {
    await insertAccessGrant(tx, {
      organizationId: scope.organization_id,
      principalKind,
      principalId,
      capability,
      scopeObjectId: scope.id,
      ...(ceiling === undefined ? {} : { classificationCeiling: ceiling }),
      ...(validToDate === undefined ? {} : { validTo: validToDate }),
      grantedBy: request.actorId,
      grantedByAction: ctx.actionId,
      reason: reason.trim(),
    });
  } catch (error: unknown) {
    const code = (error as { code?: string }).code;
    if (code === '23P01') {
      throw new ActionRejected(
        'precondition_failed',
        'a live grant of this capability to this principal at this scope already overlaps the ' +
          'requested window; revoke it first, or grant a different window',
        { principalId, capability, scopeObjectId: scope.id },
      );
    }
    if (code === '23514' || code === '23503') {
      throw new ActionRejected('precondition_failed', (error as Error).message, {
        principalId,
        scopeObjectId: scope.id,
      });
    }
    throw error;
  }
};

/**
 * `revoke_access` targets the grant's scope object and names the grant in its payload. The
 * row is updated, never deleted: what was permitted, and until when, remains evidence.
 */
export const revokeAccessEffect: ActionEffect = async (tx, request, objects, ctx) => {
  const scope = objects.find((object) => request.targetIds.includes(object.id));
  if (scope === undefined) {
    throw new Error('revoke_access must target the scope object of the grant being revoked');
  }
  const grantId = payloadString(request.payload, 'grant_id');
  if (grantId === undefined || !UUID.test(grantId)) {
    throw new ActionRejected('precondition_failed', 'revoke_access needs grant_id in its payload');
  }
  const reason = request.reason;
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new ActionRejected('precondition_failed', 'revoke_access needs a reason');
  }
  const revoked = await tx.query<{ id: string }>(
    `update org.access_grant
        set revoked_at = now(), revoked_by = $3, revoked_by_action = $4, revocation_reason = $5
      where id = $1 and scope_object_id = $2 and revoked_at is null
      returning id`,
    [grantId, scope.id, request.actorId, ctx.actionId, reason.trim()],
  );
  if (revoked.length === 0) {
    throw new ActionRejected(
      'precondition_failed',
      'no live access grant with that id exists at this scope; it may already be revoked',
      { grantId, scopeObjectId: scope.id },
    );
  }
};

export const ACCESS_ACTION_IDS = ['grant_access', 'revoke_access'] as const;

export const ACCESS_EFFECTS: Readonly<Record<string, ActionEffect>> = {
  grant_access: grantAccessEffect,
  revoke_access: revokeAccessEffect,
};

// ── Coverage: which objects a person's live grants reach ─────────────────────────────────

export interface AccessGrantRef {
  readonly source: string;
  readonly sourceId: string;
  readonly scopeObjectId: string;
  readonly classificationCeiling: string | null;
  readonly reason: string;
  /**
   * For a grant that arrived through a role (KF-SAS-RQ-270): every role from the one the person
   * holds to the one whose preset carries it — `[engineer]` for the engineer role's own template,
   * `[ceo, executive, staff]` for one ceo receives through two inclusions. Absent otherwise.
   */
  readonly rolePath?: readonly string[];
}

export interface AccessCoverage {
  /** Grants whose scope is the organization itself: every object in it is covered. */
  readonly organizationWide: readonly AccessGrantRef[];
  /** Grants on a single object, keyed by that object. */
  readonly byObject: ReadonlyMap<string, readonly AccessGrantRef[]>;
}

interface CoverageRow extends Record<string, unknown> {
  readonly source: string;
  readonly source_id: string;
  readonly scope_object_id: string;
  readonly classification_ceiling: string | null;
  readonly reason: string;
  readonly role_path: readonly string[] | null;
}

const CLASSIFICATION_RANK: Readonly<Record<string, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

/**
 * Every live `read` grant that reaches `personId` right now — directly, or through a role
 * assignment the person currently holds. Read under the caller's RLS context: a grant on an
 * object the caller cannot see is not returned, which is the right answer for a resolver
 * that only narrows.
 */
export async function enumerateAccessCoverage(
  tx: Tx,
  personId: string,
  organizationId: string,
  capability: AccessCapability = 'read',
): Promise<AccessCoverage> {
  const rows = await tx.query<CoverageRow>(
    `select /* access-grants.coverage */
            g.source, g.source_id, g.scope_object_id, g.classification_ceiling, g.reason,
            g.role_path
       from org.effective_access_grant g
      where g.organization_id = $2
        and g.capability = $3
        -- Secure-object capabilities are read grants on EXTERNAL references (scope_object_id
        -- is null, scope_external_ref is set). They never cover a core.object, so they are
        -- deliberately outside this coverage; they are still listed by the view.
        and g.scope_object_id is not null
        and g.valid_from <= now()
        and (g.valid_to is null or g.valid_to > now())
        and (
          (g.principal_kind = 'person' and g.principal_id = $1)
          or (g.principal_kind = 'role_assignment' and exists (
                select 1 from org.role_assignment ra
                 where ra.id = g.principal_id and ra.subject_id = $1
                   and ra.valid_from <= now()
                   and (ra.valid_to is null or ra.valid_to > now())))
        )
      order by g.source, g.source_id`,
    [personId, organizationId, capability],
  );
  const organizationWide: AccessGrantRef[] = [];
  const byObject = new Map<string, AccessGrantRef[]>();
  for (const row of rows) {
    const ref: AccessGrantRef = {
      source: row.source,
      sourceId: row.source_id,
      scopeObjectId: row.scope_object_id,
      classificationCeiling: row.classification_ceiling,
      reason: row.reason,
      ...(row.role_path === null ? {} : { rolePath: [...row.role_path] }),
    };
    if (row.scope_object_id === organizationId) {
      organizationWide.push(ref);
    } else {
      byObject.set(row.scope_object_id, [...(byObject.get(row.scope_object_id) ?? []), ref]);
    }
  }
  return { organizationWide, byObject };
}

/** The grants under which `objectId` at `classification` is reachable — empty means it is not. */
export function coveringGrants(
  coverage: AccessCoverage,
  objectId: string,
  classification: string,
): readonly AccessGrantRef[] {
  const rank = CLASSIFICATION_RANK[classification] ?? Number.POSITIVE_INFINITY;
  const admits = (grant: AccessGrantRef): boolean =>
    grant.classificationCeiling === null ||
    rank <= (CLASSIFICATION_RANK[grant.classificationCeiling] ?? Number.NEGATIVE_INFINITY);
  return [...coverage.organizationWide, ...(coverage.byObject.get(objectId) ?? [])].filter(admits);
}

// ── Explanation: the policy path, in the order it is evaluated ────────────────────────────

export type AccessStepOutcome = 'pass' | 'fail' | 'skipped';

export interface AccessStep {
  readonly step:
    | 'organization_membership'
    | 'principal_kind'
    | 'object_in_organization'
    | 'clearance'
    | 'classification_within_clearance'
    | 'grant_coverage'
    | 'separation_of_duty'
    | 'entitlement_exclusion'
    | 'retention_hold';
  readonly outcome: AccessStepOutcome;
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * The fact that decided a denial. A step names the question; this names the answer, and they
 * differ in one place: a failed `principal_kind` step decided because the person is a service
 * actor (ADR 0020), so the explanation says `service_actor`.
 */
export type AccessDenial = Exclude<AccessStep['step'], 'principal_kind'> | 'service_actor';

function denialOf(step: AccessStep['step']): AccessDenial {
  return step === 'principal_kind' ? 'service_actor' : step;
}

export interface AccessExplanation {
  readonly format: typeof ACCESS_EXPLANATION_FORMAT;
  readonly capability: AccessCapability;
  readonly personId: string;
  readonly organizationId: string;
  readonly objectId: string;
  /** The action the explanation was asked about, when one was; it decides separation of duty. */
  readonly actionType?: string;
  readonly decision: 'visible' | 'denied';
  /** The first failing step, as the fact that decided (`AccessDenial`). Absent when visible. */
  readonly deniedBy?: AccessDenial;
  readonly steps: readonly AccessStep[];
  readonly explainedAt: string;
  readonly explanationDigest: string;
}

/**
 * The explanation's format tag, inside its digest preimage (KF-SAS-RQ-016).
 *
 * v2 is `digest()` — RFC 8785 canonical form — of the explanation without `explainedAt` and the
 * digest itself. v1 hashed `JSON.stringify` of the same body, whose bytes depend on property
 * insertion order and so on how the object happened to be built: two equal explanations could
 * hash differently, and no other implementation could reproduce the digest from the JSON it was
 * served. v1 was computed on request and returned, never stored or verified by anything here,
 * so it is replaced rather than kept verifiable.
 */
export const ACCESS_EXPLANATION_FORMAT = 'kf-access-explanation-v2' as const;

/** The digest an explanation carries: canonical, over everything but `explainedAt`. */
export function accessExplanationDigest(
  explanation: Omit<AccessExplanation, 'explainedAt' | 'explanationDigest'>,
): string {
  return digest(explanation);
}

/**
 * Why can (or can't) this person see this object? Every step is a fact already in the
 * database, evaluated in the order the permitted set applies them, so the answer is the
 * reason and not a paraphrase of it. Steps after the deciding failure are still evaluated —
 * an auditor wants to know that a person was BOTH excluded and ungranted — except where a
 * missing prerequisite makes the question meaningless (no clearance ⇒ no ceiling to compare).
 */
export async function explainAccess(
  tx: Tx,
  input: {
    readonly personId: string;
    readonly organizationId: string;
    readonly objectId: string;
    /** `read` (the corpus) or `act` (ADR 0016 dispatch authority); default read. */
    readonly capability?: AccessCapability;
    /**
     * The action being asked about. When the dispatcher's separation-of-duty rule covers it and
     * the object's type, the path includes that bar; without one there is no action to judge.
     */
    readonly actionType?: string;
  },
): Promise<AccessExplanation> {
  const capability = input.capability ?? 'read';
  const steps: AccessStep[] = [];
  const person = await tx.maybeOne<
    { organization: string | null; person_kind: string } & Record<string, unknown>
  >(`select p.organization, p.person_kind from org.person p where p.id = $1`, [input.personId]);
  const isMember = person !== undefined && person.organization === input.organizationId;
  steps.push({
    step: 'organization_membership',
    outcome: isMember ? 'pass' : 'fail',
    detail: { personFound: person !== undefined, memberOf: person?.organization ?? null },
  });

  // ADR 0020: a service actor never performs an institutional act, whatever grants reach it —
  // the dispatcher and the database both refuse it by kind before asking about grants. It
  // reads like anyone, so for `read` this step passes.
  const personKind = person?.person_kind ?? null;
  if (person === undefined) {
    steps.push({ step: 'principal_kind', outcome: 'skipped', detail: {} });
  } else {
    const barred = capability === 'act' && personKind === 'service';
    steps.push({
      step: 'principal_kind',
      outcome: barred ? 'fail' : 'pass',
      detail: {
        personKind,
        ...(barred
          ? { rule: 'a service actor cannot perform an institutional act (ADR 0020)' }
          : {}),
      },
    });
  }

  const object = await tx.maybeOne<
    {
      organization_id: string;
      classification: string;
      object_type: string;
      created_by: string;
    } & Record<string, unknown>
  >(
    `select organization_id, classification, object_type, created_by from core.object where id = $1`,
    [input.objectId],
  );
  const inOrganization = object !== undefined && object.organization_id === input.organizationId;
  steps.push({
    step: 'object_in_organization',
    outcome: inOrganization ? 'pass' : 'fail',
    detail: {
      objectFound: object !== undefined,
      objectType: object?.object_type ?? null,
      classification: object?.classification ?? null,
    },
  });

  const clearance = await tx.maybeOne<
    { id: string; max_classification: string; valid_from: Date } & Record<string, unknown>
  >(
    `select pc.id, pc.max_classification, pc.valid_from
       from org.person_clearance pc
      where pc.subject_id = $1 and pc.organization_id = $2
        and pc.valid_from <= now() and (pc.valid_to is null or pc.valid_to > now())
        and not exists (select 1 from org.person_clearance_retirement r where r.clearance_id = pc.id)
      order by pc.valid_from desc limit 1`,
    [input.personId, input.organizationId],
  );
  steps.push({
    step: 'clearance',
    outcome: clearance === undefined ? 'fail' : 'pass',
    detail: {
      clearanceId: clearance?.id ?? null,
      maxClassification: clearance?.max_classification ?? null,
    },
  });

  if (clearance === undefined || object === undefined) {
    steps.push({ step: 'classification_within_clearance', outcome: 'skipped', detail: {} });
  } else {
    const objectRank = CLASSIFICATION_RANK[object.classification] ?? Number.POSITIVE_INFINITY;
    const ceilingRank = CLASSIFICATION_RANK[clearance.max_classification] ?? -1;
    steps.push({
      step: 'classification_within_clearance',
      outcome: objectRank <= ceilingRank ? 'pass' : 'fail',
      detail: {
        objectClassification: object.classification,
        clearance: clearance.max_classification,
      },
    });
  }

  const coverage = await enumerateAccessCoverage(
    tx,
    input.personId,
    input.organizationId,
    capability,
  );
  const covering =
    object === undefined ? [] : coveringGrants(coverage, input.objectId, object.classification);
  steps.push({
    step: 'grant_coverage',
    outcome: covering.length > 0 ? 'pass' : 'fail',
    detail: {
      grants: covering.map((grant) => ({
        source: grant.source,
        sourceId: grant.sourceId,
        scope: grant.scopeObjectId === input.organizationId ? 'organization' : 'object',
        classificationCeiling: grant.classificationCeiling,
        reason: grant.reason,
        // The role path by which a role's grant arrived (KF-SAS-RQ-270): the role held, then
        // every role it includes on the way to the one whose preset carries the grant.
        ...(grant.rolePath === undefined ? {} : { rolePath: grant.rolePath }),
      })),
    },
  });

  // Separation of duty is the dispatcher's rule (`DEFAULT_SEPARATION_OF_DUTY`): for the actions
  // it names, over the object types it names (none named = every type), the person who created
  // the record may not perform it. The step appears only where that rule covers this action and
  // this object, so an explanation never lists a bar that does not apply.
  const sodTypes =
    input.actionType === undefined ? undefined : DEFAULT_SEPARATION_OF_DUTY[input.actionType];
  if (
    sodTypes !== undefined &&
    object !== undefined &&
    (sodTypes.length === 0 || sodTypes.includes(object.object_type))
  ) {
    const createdIt = object.created_by === input.personId;
    steps.push({
      step: 'separation_of_duty',
      outcome: createdIt ? 'fail' : 'pass',
      detail: {
        actionType: input.actionType,
        createdBy: object.created_by,
        rule: `${input.actionType} may not be performed by the actor who created the record`,
      },
    });
  }

  const exclusions = await tx.query<
    { id: string; reason_class: string; reason: string } & Record<string, unknown>
  >(
    `select id, reason_class, reason from content.person_entitlement_exclusion
      where subject_id = $1 and organization_id = $2 and object_id = $3 and released_at is null
      order by created_at, id`,
    [input.personId, input.organizationId, input.objectId],
  );
  steps.push({
    step: 'entitlement_exclusion',
    outcome: exclusions.length === 0 ? 'pass' : 'fail',
    detail: {
      exclusions: exclusions.map((row) => ({
        id: row.id,
        reasonClass: row.reason_class,
        reason: row.reason,
      })),
    },
  });

  const holds = await tx.query<{ id: string; reason: string } & Record<string, unknown>>(
    `select id, reason from core.retention_hold
      where object_id = $1 and released_at is null order by placed_at, id`,
    [input.objectId],
  );
  steps.push({
    step: 'retention_hold',
    outcome: holds.length === 0 ? 'pass' : 'fail',
    detail: { holds: holds.map((row) => ({ id: row.id, reason: row.reason })) },
  });

  const failed = steps.find((step) => step.outcome === 'fail')?.step;
  const deniedBy = failed === undefined ? undefined : denialOf(failed);
  // The digest covers the facts and the decision, not `explainedAt`: the same facts must give
  // the same digest, so a reader can tell "unchanged" from "re-evaluated".
  const explainedAt = new Date().toISOString();
  const body = {
    format: ACCESS_EXPLANATION_FORMAT,
    capability,
    personId: input.personId,
    organizationId: input.organizationId,
    objectId: input.objectId,
    ...(input.actionType === undefined ? {} : { actionType: input.actionType }),
    decision: deniedBy === undefined ? ('visible' as const) : ('denied' as const),
    ...(deniedBy === undefined ? {} : { deniedBy }),
    steps,
  };
  return {
    ...body,
    explainedAt,
    explanationDigest: accessExplanationDigest(body),
  };
}
