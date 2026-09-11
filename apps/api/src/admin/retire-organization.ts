/**
 * Retire an organization nobody can act in.
 *
 * `retire_organization` is an ordinary dispatched act: a person with `act` authority in the
 * organization performs it through the API, and this command is not for them. It exists for the
 * organization in which NOBODY holds a role — which is exactly the shape of a duplicate created
 * by a bootstrap defect, an organization created in error, or one whose last person has left.
 * Dispatch binds authoritative clearance before it applies anything, and such an organization
 * has no clearance to bind.
 *
 * It is not a second implementation of the rule. The precondition and the effect are the SAME
 * functions the dispatcher runs — `createOrganizationLifecycleAtoms()` — invoked here around
 * the two things the dispatcher would otherwise do itself: record the act, and move the
 * object. So what this command refuses, the act refuses; what it does to the people of the
 * organization, the act does; and the audit chain is extended by the same arithmetic.
 *
 * The one thing it will not do is stand in for the API. An organization with a live role
 * assignment is refused here with the instruction to dispatch the act as that person, because
 * a bootstrap path that also works when the ordinary path works is a bypass.
 */

import { createHash, randomUUID } from 'node:crypto';

import { appendAuditEvent, type ActionRequest, type ObjectRow } from '@kf/actions';
import { createOrganizationLifecycleAtoms } from '@kf/authorization';
import {
  setAccessContext,
  setTransactionContext,
  withTransaction,
  type Pool,
  type Tx,
} from '@kf/database';

import { BOOTSTRAP_IDENTITY } from './bootstrap-organization.js';

export interface RetireOrganizationRequest {
  readonly organizationId?: string;
  readonly reason?: string;
  readonly decidedBy?: string;
  readonly successorId?: string;
  readonly withPeople?: boolean;
}

export interface RetireOrganizationDecision {
  readonly organizationId: string;
  readonly reason: string;
  readonly decidedBy: string;
  readonly withPeople: boolean;
  readonly successorId?: string;
}

export type RetireOrganizationPlan =
  | { readonly ok: true; readonly decision: RetireOrganizationDecision }
  | { readonly ok: false; readonly refusals: readonly string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function planRetireOrganization(request: RetireOrganizationRequest): RetireOrganizationPlan {
  const refusals: string[] = [];
  const organizationId = request.organizationId?.trim() ?? '';
  const reason = request.reason?.trim() ?? '';
  const decidedBy = request.decidedBy?.trim() ?? '';
  const successorId = request.successorId?.trim();

  if (!UUID.test(organizationId)) {
    refusals.push('--organization must be the uuid of the organization to retire');
  }
  if (reason.length < 12) {
    refusals.push(
      '--reason must say why in at least a sentence: retiring is terminal and "cleanup" is not ' +
        'a reason a later reader can evaluate',
    );
  }
  if (!UUID.test(decidedBy)) {
    refusals.push(
      '--decided-by must be the uuid of the PERSON who made this decision. A retirement ' +
        'attributed to nobody is a retirement nobody can be asked about',
    );
  }
  if (successorId !== undefined && !UUID.test(successorId)) {
    refusals.push('--successor, when given, must be the uuid of the organization that succeeds it');
  }
  if (refusals.length > 0) return { ok: false, refusals };
  return {
    ok: true,
    decision: {
      organizationId,
      reason,
      decidedBy,
      withPeople: request.withPeople === true,
      ...(successorId === undefined ? {} : { successorId }),
    },
  };
}

export function parseRetireOrganizationArgs(argv: readonly string[]): RetireOrganizationRequest {
  const values: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === '--with-people') {
      values['with-people'] = true;
      continue;
    }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(token);
    if (match === null) throw new Error(`unexpected argument ${token}`);
    const name = match[1]!;
    const value = match[2] ?? argv[++i];
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new Error(`--${name} needs a value`);
    }
    values[name] = value;
  }
  const known = new Set(['organization', 'reason', 'decided-by', 'successor', 'with-people']);
  for (const key of Object.keys(values)) {
    if (!known.has(key)) throw new Error(`unknown option --${key}`);
  }
  const str = (key: string): string | undefined =>
    typeof values[key] === 'string' ? (values[key] as string) : undefined;
  const organizationId = str('organization');
  const reason = str('reason');
  const decidedBy = str('decided-by');
  const successorId = str('successor');
  return {
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(reason === undefined ? {} : { reason }),
    ...(decidedBy === undefined ? {} : { decidedBy }),
    ...(successorId === undefined ? {} : { successorId }),
    ...(values['with-people'] === true ? { withPeople: true } : {}),
  };
}

export interface RetireOrganizationResult {
  readonly actionId: string;
  readonly auditDigest: string;
  readonly organizationId: string;
  readonly peopleDeactivated: readonly { readonly id: string; readonly name: string }[];
}

export async function runRetireOrganization(
  owner: Pool,
  decision: RetireOrganizationDecision,
): Promise<RetireOrganizationResult> {
  const atoms = createOrganizationLifecycleAtoms();
  const precondition = atoms.preconditions['retire_organization'];
  const effect = atoms.effects['retire_organization'];
  if (precondition === undefined || effect === undefined) {
    throw new Error('the organization lifecycle atoms do not own retire_organization');
  }

  return withTransaction(owner, async (tx: Tx) => {
    await setAccessContext(tx, {
      organizationId: decision.organizationId,
      maxClassification: 'restricted',
    });

    const organization = await tx.maybeOne<ObjectRow>(
      `select id, object_type, lifecycle_state, row_version::text, organization_id, created_by
         from core.object
        where id = $1 and object_type = 'organization'`,
      [decision.organizationId],
    );
    if (organization === undefined) {
      throw new Error(`no organization ${decision.organizationId} exists; check the id`);
    }
    if (organization.lifecycle_state === 'retired') {
      throw new Error(`organization ${decision.organizationId} is already retired`);
    }

    // The boundary of this command: if anybody can act here, the act is theirs to dispatch.
    const anyone = await tx.maybeOne<{ subject_id: string; role_id: string }>(
      `select subject_id, role_id from org.role_assignment
        where scope_id = $1 and valid_from <= now() and (valid_to is null or valid_to > now())
        limit 1`,
      [decision.organizationId],
    );
    if (anyone !== undefined) {
      throw new Error(
        `organization ${decision.organizationId} has a live role assignment (person ` +
          `${anyone.subject_id} as ${anyone.role_id}). Somebody can act in it, so this is not a ` +
          'bootstrap case: dispatch retire_organization through the API as that person. This ' +
          'command is only for an organization in which nobody holds authority.',
      );
    }

    // The decider is a person somewhere in the record. They need not be a member of THIS
    // organization — nobody with authority is, or the command would not apply. `org.person`
    // enables row-level security without forcing it, so the owner connection sees the row.
    const decider = await tx.maybeOne<{ id: string; display_name: string }>(
      'select id, display_name from org.person where id = $1',
      [decision.decidedBy],
    );
    if (decider === undefined) {
      throw new Error(`--decided-by ${decision.decidedBy} is not a person in this system`);
    }

    const actionId = randomUUID();
    // Whole milliseconds: the canonical wire instant the action table's constraint requires.
    const effectiveAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    await setTransactionContext(tx, {
      actorId: decision.decidedBy,
      actingRoleId: BOOTSTRAP_IDENTITY,
      actionId,
      requestId: 'kf-retire-organization',
    });

    const payload = {
      with_people: decision.withPeople,
      ...(decision.successorId === undefined
        ? {}
        : { successor_organization_id: decision.successorId }),
    };
    const request: ActionRequest = {
      actionType: 'retire_organization',
      actorId: decision.decidedBy,
      actingRoleId: BOOTSTRAP_IDENTITY,
      targetIds: [decision.organizationId],
      payload,
      reason: decision.reason,
      idempotencyKey: `retire-organization:${decision.organizationId}`,
      requestId: 'kf-retire-organization',
      organizationId: decision.organizationId,
      maxClassification: 'restricted',
      effectiveAt,
    };

    // The same refusals the dispatcher would issue, thrown as the same ActionRejected.
    await precondition(tx, request, [organization]);

    const peopleBefore = await tx.query<{ id: string; display_name: string }>(
      `select p.id, p.display_name from org.person p
         join core.object o on o.id = p.id
        where p.organization = $1 and o.lifecycle_state = 'active'
        order by p.id`,
      [decision.organizationId],
    );

    // Recorded BEFORE the object moves: the transition guard reads the action row to learn
    // which transition it is being asked to allow.
    await tx.query(
      `insert into core.action
         (id, organization_id, request_digest, action_type, actor_id, acting_role_id,
          target_ids, parameters, preconditions, idempotency_key, effective_at, request_id,
          reason, result_status, result)
       values ($1, $2, $3, 'retire_organization', $4, $5, $6, $7::jsonb, '{}'::jsonb,
               $8, $9, 'kf-retire-organization', $10, 'applied', '{}'::jsonb)`,
      [
        actionId,
        decision.organizationId,
        createHash('sha256')
          .update(`retire-organization ${decision.organizationId} ${decision.reason}`)
          .digest('hex'),
        decision.decidedBy,
        BOOTSTRAP_IDENTITY,
        [decision.organizationId],
        JSON.stringify(payload),
        request.idempotencyKey,
        effectiveAt.toISOString(),
        decision.reason,
      ],
    );

    // What the dispatcher does for a `drives` target: the declared transition, guarded by the
    // trigger that checks the ontology permits it under this action.
    await tx.query(
      `update core.object
          set lifecycle_state = 'retired', row_version = row_version + 1
        where id = $1 and object_type = 'organization'`,
      [decision.organizationId],
    );

    await effect(tx, request, [organization], { actionId, effectiveAt });

    const auditDigest = await appendAuditEvent(tx, {
      actionId,
      actionType: 'retire_organization',
      actorId: decision.decidedBy,
      actingRoleId: BOOTSTRAP_IDENTITY,
      objectIds: [decision.organizationId, ...peopleBefore.map((person) => person.id)],
      effectiveAt,
      requestId: 'kf-retire-organization',
      reason: decision.reason,
      beforeDigest: null,
      afterDigest: null,
    });

    return {
      actionId,
      auditDigest,
      organizationId: decision.organizationId,
      peopleDeactivated: peopleBefore.map((person) => ({
        id: person.id,
        name: person.display_name,
      })),
    };
  });
}

export function retireOrganizationUsage(): string {
  return [
    'kf retire-organization — retire an organization in which nobody holds authority',
    '',
    '  kf retire-organization --organization <uuid> --decided-by <person uuid> \\',
    '      --reason "<why, in a sentence>" [--successor <uuid>] [--with-people]',
    '',
    'Needs DATABASE_OWNER_URL. An organization with a live role assignment is refused here:',
    'dispatch retire_organization through the API as that person instead. With active people,',
    '--with-people states that they become inactive under this act (they cannot move).',
  ].join('\n');
}
