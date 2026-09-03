/**
 * Declare a service actor: a person of kind `service` with an organization-scoped role and a
 * clearance, so a timer can dispatch typed actions under a named principal (ADR 0020).
 *
 * WHY THIS IS AN OPERATOR COMMAND
 *
 * It creates a principal that will act without a human present. Nothing about that is
 * self-service: the operator names the organization, the role, the classification ceiling
 * and the person who is deciding, and the run is refused if any is missing. It runs on the
 * OWNER connection, outside the dispatcher, and records a real `grant_person_clearance`
 * action and audit event through the same code the dispatched path uses — the shape
 * `apps/api/src/admin/grant-authority.ts` set.
 *
 * A service actor can never be linked to a login (the database refuses it) and can never
 * perform a `requires: act` action (the dispatcher refuses it): it does routine work under
 * authority somebody else granted, and nothing institutional.
 */

import { createHash, randomUUID } from 'node:crypto';
import { appendAuditEvent } from '@kf/actions';
import { insertPersonClearance } from '@kf/authorization';
import {
  setAccessContext,
  setTransactionContext,
  withTransaction,
  type Pool,
  type Tx,
} from '@kf/database';
import { createControlledObject } from '@kf/record-atoms';

export interface DeclareServiceActorRequest {
  readonly organizationId?: string;
  readonly name?: string;
  readonly roleId?: string;
  readonly classification?: string;
  readonly declaredBy?: string;
  readonly reason?: string;
}

export interface DeclareServiceActorPlan {
  readonly ok: boolean;
  readonly refusals: readonly string[];
  readonly declaration?: Required<DeclareServiceActorRequest>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME = /^[a-z][a-z0-9-]{2,63}$/;

export function planDeclareServiceActor(
  request: DeclareServiceActorRequest,
): DeclareServiceActorPlan {
  const refusals: string[] = [];
  if (request.organizationId === undefined || !UUID.test(request.organizationId)) {
    refusals.push('--organization must be the organization uuid');
  }
  if (request.name === undefined || !NAME.test(request.name)) {
    refusals.push('--name must be a lowercase, dashed service name (e.g. storage-steward)');
  }
  if (request.roleId === undefined || request.roleId.trim() === '') {
    refusals.push('--role is required: the organization-scoped role the actor exercises');
  }
  if (request.classification === undefined || request.classification.trim() === '') {
    refusals.push('--classification is required: the ceiling on what the actor may see');
  }
  if (request.declaredBy === undefined || !UUID.test(request.declaredBy)) {
    refusals.push('--declared-by must be the uuid of the person deciding');
  }
  if (request.reason === undefined || request.reason.trim() === '') {
    refusals.push('--reason is required: a principal that acts unattended needs a stated why');
  }
  if (refusals.length > 0) return { ok: false, refusals };
  return {
    ok: true,
    refusals: [],
    declaration: {
      organizationId: request.organizationId!,
      name: request.name!,
      roleId: request.roleId!.trim(),
      classification: request.classification!.trim(),
      declaredBy: request.declaredBy!,
      reason: request.reason!.trim(),
    },
  };
}

export function parseDeclareServiceActorArgs(argv: readonly string[]): DeclareServiceActorRequest {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
    out[arg.slice(2)] = value;
    i += 1;
  }
  return {
    ...(out['organization'] === undefined ? {} : { organizationId: out['organization'] }),
    ...(out['name'] === undefined ? {} : { name: out['name'] }),
    ...(out['role'] === undefined ? {} : { roleId: out['role'] }),
    ...(out['classification'] === undefined ? {} : { classification: out['classification'] }),
    ...(out['declared-by'] === undefined ? {} : { declaredBy: out['declared-by'] }),
    ...(out['reason'] === undefined ? {} : { reason: out['reason'] }),
  };
}

export interface DeclareServiceActorResult {
  readonly personId: string;
  readonly roleAssignmentId: string;
  readonly clearanceId: string;
  readonly actionId: string;
  readonly reused: boolean;
}

/** Declare (or find already declared) the service actor; idempotent on (organization, name). */
export async function runDeclareServiceActor(
  owner: Pool,
  declaration: Required<DeclareServiceActorRequest>,
): Promise<DeclareServiceActorResult> {
  return withTransaction(owner, async (tx: Tx) => {
    await setAccessContext(tx, {
      organizationId: declaration.organizationId,
      maxClassification: declaration.classification,
    });
    const decider = await tx.maybeOne<{ id: string; person_kind: string }>(
      `select p.id, p.person_kind from org.person p where p.id = $1 and p.organization = $2`,
      [declaration.declaredBy, declaration.organizationId],
    );
    if (decider === undefined)
      throw new Error('--declared-by is not a person of this organization');
    if (decider.person_kind !== 'human') throw new Error('a service actor cannot declare another');
    const deciderRole = await tx.maybeOne<{ id: string }>(
      `select id from org.role_assignment
        where subject_id = $1 and scope_id = $2
          and valid_from <= now() and (valid_to is null or valid_to > now())
        order by valid_from limit 1`,
      [declaration.declaredBy, declaration.organizationId],
    );
    if (deciderRole === undefined) {
      throw new Error(
        '--declared-by holds no active organization-scoped role; nobody exercised authority',
      );
    }
    const role = await tx.maybeOne<{ id: string }>('select id from org.role where id = $1', [
      declaration.roleId,
    ]);
    if (role === undefined) throw new Error(`--role ${declaration.roleId} is not a declared role`);

    const existing = await tx.maybeOne<{ id: string }>(
      `select p.id from org.person p join core.object o on o.id = p.id
        where p.organization = $1 and p.person_kind = 'service' and o.title = $2`,
      [declaration.organizationId, declaration.name],
    );
    if (existing !== undefined) {
      // Reuse means "the same declaration": a LIVE role assignment for the requested role and
      // a live clearance at the requested ceiling. A different role or ceiling under the same
      // name is a different declaration, refused rather than silently answered with the old one.
      const assignment = await tx.maybeOne<{ id: string; role_id: string }>(
        `select id, role_id from org.role_assignment
          where subject_id = $1 and scope_id = $2
            and valid_from <= now() and (valid_to is null or valid_to > now())
          order by valid_from desc limit 1`,
        [existing.id, declaration.organizationId],
      );
      const clearance = await tx.maybeOne<{
        id: string;
        granted_by_action: string;
        max_classification: string;
      }>(
        `select id, granted_by_action, max_classification from org.person_clearance
          where subject_id = $1 and organization_id = $2
            and valid_from <= now() and (valid_to is null or valid_to > now())
          order by valid_from desc limit 1`,
        [existing.id, declaration.organizationId],
      );
      if (assignment === undefined || clearance === undefined) {
        throw new Error(
          `service actor '${declaration.name}' exists but holds no live role or clearance; ` +
            'retire it and declare a new name rather than reviving it under this one',
        );
      }
      if (
        assignment.role_id !== declaration.roleId ||
        clearance.max_classification !== declaration.classification
      ) {
        throw new Error(
          `service actor '${declaration.name}' already holds ${assignment.role_id} at ` +
            `${clearance.max_classification}; a different role or ceiling is a different declaration`,
        );
      }
      return {
        personId: existing.id,
        roleAssignmentId: assignment.id,
        clearanceId: clearance.id,
        actionId: clearance.granted_by_action,
        reused: true,
      };
    }

    const actionId = randomUUID();
    const effectiveAt = new Date();
    await setTransactionContext(tx, {
      actorId: declaration.declaredBy,
      actingRoleId: deciderRole.id,
      actionId,
      requestId: 'kf-declare-service-actor',
    });
    const personId = await createControlledObject(tx, {
      objectType: 'person',
      authorityDomain: 'organization',
      lifecycleState: 'active',
      title: declaration.name,
      organizationId: declaration.organizationId,
      createdBy: declaration.declaredBy,
    });
    await tx.query(
      `insert into org.person (id, display_name, organization, person_kind)
       values ($1, $2, $3, 'service')`,
      [personId, declaration.name, declaration.organizationId],
    );
    const roleAssignmentId = await createControlledObject(tx, {
      objectType: 'role_assignment',
      authorityDomain: 'organization',
      lifecycleState: 'active',
      title: `${declaration.roleId} assignment (service: ${declaration.name})`,
      organizationId: declaration.organizationId,
      createdBy: declaration.declaredBy,
    });
    await tx.query(
      `insert into org.role_assignment (id, subject_id, role_id, scope_id, delegated_by)
       values ($1, $2, $3, $4, $5)`,
      [
        roleAssignmentId,
        personId,
        declaration.roleId,
        declaration.organizationId,
        declaration.declaredBy,
      ],
    );
    const requestDigest = createHash('sha256')
      .update(
        JSON.stringify([
          'declare_service_actor',
          declaration.organizationId,
          declaration.name,
          declaration.roleId,
          declaration.classification,
          declaration.declaredBy,
        ]),
      )
      .digest('hex');
    await tx.query(
      `insert into core.action
         (id, organization_id, request_digest, action_type, actor_id, acting_role_id,
          target_ids, parameters, preconditions, idempotency_key, effective_at,
          reason, result_status, result)
       values ($1,$2,$3,'grant_person_clearance',$4,$5,array[$6]::uuid[],$7::jsonb,'{}'::jsonb,
               $8,$9,$10,'applied','{}'::jsonb)`,
      [
        actionId,
        declaration.organizationId,
        requestDigest,
        declaration.declaredBy,
        deciderRole.id,
        personId,
        JSON.stringify({
          service_actor: declaration.name,
          role_id: declaration.roleId,
          max_classification: declaration.classification,
        }),
        // Organization + name + WHAT was declared: a retired name re-declared with another role
        // or ceiling is a different act, not a replay of the old one.
        `declare-service-actor-${declaration.organizationId}-${declaration.name}-${requestDigest.slice(0, 16)}`,
        effectiveAt.toISOString(),
        declaration.reason,
      ],
    );
    await appendAuditEvent(tx, {
      actionId,
      actionType: 'grant_person_clearance',
      actorId: declaration.declaredBy,
      actingRoleId: deciderRole.id,
      objectIds: [personId],
      effectiveAt,
      requestId: 'kf-declare-service-actor',
      reason: declaration.reason,
      beforeDigest: null,
      afterDigest: null,
    });
    const clearanceId = await insertPersonClearance(tx, {
      personId,
      organizationId: declaration.organizationId,
      classification: declaration.classification,
      grantedBy: declaration.declaredBy,
      grantedByAction: actionId,
      reason: declaration.reason,
    });
    return { personId, roleAssignmentId, clearanceId, actionId, reused: false };
  });
}
