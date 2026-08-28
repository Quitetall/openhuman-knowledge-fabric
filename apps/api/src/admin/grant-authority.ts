/**
 * Grant one person the authority to act: link their identity, assign a role, grant a clearance.
 *
 * WHY THIS IS A BOOTSTRAP ACT
 *
 * `grant_person_clearance` IS dispatchable in the ordinary case — an already-cleared person
 * clearing a colleague — and `@kf/authorization` owns that effect. What cannot be dispatched is
 * the FIRST grant in an organization: dispatch binds authoritative clearance before effects run,
 * so there would have to be a clearance already in order to grant one. That is the case this
 * command exists for.
 *
 * It runs on the OWNER connection, outside the dispatcher, and still records a real
 * `grant_person_clearance` action, still extends the audit chain through `appendAuditEvent`, and
 * still writes the clearance row through `insertPersonClearance` — the same three things the
 * dispatched path does, by the same code.
 *
 * It is deliberately not an HTTP route and never will be. `linkIdentity` says it plainly:
 * "somebody decides that this account is that person, and that decision is recorded with who
 * made it." This command is where a human records that decision; it is not a self-service path.
 *
 * Nothing here is defaulted. Every value that widens someone's authority is stated by the
 * operator or the run is refused.
 */

import { createHash, randomUUID } from 'node:crypto';
import { appendAuditEvent } from '@kf/actions';
import { insertPersonClearance, linkIdentity } from '@kf/authorization';
import {
  setAccessContext,
  setTransactionContext,
  withTransaction,
  type Pool,
  type Tx,
} from '@kf/database';
import { createControlledObject } from '@kf/record-atoms';

export interface GrantAuthorityRequest {
  readonly personId?: string;
  readonly organizationId?: string;
  readonly roleId?: string;
  readonly classification?: string;
  readonly grantedBy?: string;
  readonly reason?: string;
  /** Both or neither: an issuer without a subject names no account. */
  readonly issuer?: string;
  readonly subject?: string;
}

export interface GrantAuthorityGrant {
  readonly personId: string;
  readonly organizationId: string;
  readonly roleId: string;
  readonly classification: string;
  readonly grantedBy: string;
  readonly reason: string;
  readonly identity?: { readonly issuer: string; readonly subject: string };
}

export type GrantAuthorityPlan =
  | { readonly ok: true; readonly grant: GrantAuthorityGrant }
  | { readonly ok: false; readonly refusals: readonly string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate an authority grant without touching a database, so every refusal is testable and the
 * operator learns all of their mistakes in one run rather than one per attempt.
 */
export function planGrantAuthority(request: GrantAuthorityRequest): GrantAuthorityPlan {
  const refusals: string[] = [];

  const uuidField = (value: string | undefined, flag: string, what: string): void => {
    if (value === undefined) {
      refusals.push(`no ${flag} given: ${what}`);
      return;
    }
    if (!UUID.test(value)) refusals.push(`${flag} must be a uuid, got ${JSON.stringify(value)}`);
  };

  uuidField(request.personId, '--person', 'which person is being granted authority');
  uuidField(
    request.organizationId,
    '--organization',
    'authority is organization-scoped (ADR 0011)',
  );
  uuidField(
    request.grantedBy,
    '--granted-by',
    'who decided this. An authority grant with no grantor is not auditable',
  );

  if (request.roleId === undefined || request.roleId.trim() === '') {
    refusals.push('no --role given: holding a role is not the same as acting under one');
  }

  if (request.classification === undefined || request.classification.trim() === '') {
    refusals.push(
      'no --clearance given. This is the ceiling on everything the person can ever see, and ' +
        'guessing it either over-discloses or locks them out of their own record.',
    );
  }

  if (request.reason === undefined || request.reason.trim() === '') {
    // org.person_clearance.reason has a non-blank CHECK. Refusing here names the reason instead
    // of surfacing a constraint violation the operator has to decode.
    refusals.push(
      'no --reason given. The record has to say why this authority was granted, and "because ' +
        'someone asked" a year later is not a record.',
    );
  }

  const hasIssuer = request.issuer !== undefined && request.issuer.trim() !== '';
  const hasSubject = request.subject !== undefined && request.subject.trim() !== '';
  if (hasIssuer !== hasSubject) {
    refusals.push(
      '--issuer and --subject must be given together: a subject is unique only within its ' +
        'issuer, so either alone identifies no account.',
    );
  }

  if (refusals.length > 0) return { ok: false, refusals };

  return {
    ok: true,
    grant: {
      personId: request.personId as string,
      organizationId: request.organizationId as string,
      roleId: (request.roleId as string).trim(),
      classification: (request.classification as string).trim(),
      grantedBy: request.grantedBy as string,
      reason: (request.reason as string).trim(),
      ...(hasIssuer
        ? {
            identity: {
              issuer: (request.issuer as string).trim(),
              subject: (request.subject as string).trim(),
            },
          }
        : {}),
    },
  };
}

/** `--flag value` and `--flag=value`, both accepted; unknown flags are refused, not ignored. */
export function parseGrantAuthorityArgs(argv: readonly string[]): GrantAuthorityRequest {
  const known = new Map<string, keyof GrantAuthorityRequest>([
    ['--person', 'personId'],
    ['--organization', 'organizationId'],
    ['--role', 'roleId'],
    ['--clearance', 'classification'],
    ['--granted-by', 'grantedBy'],
    ['--reason', 'reason'],
    ['--issuer', 'issuer'],
    ['--subject', 'subject'],
  ]);
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    const eq = token.indexOf('=');
    const flag = eq === -1 ? token : token.slice(0, eq);
    const key = known.get(flag);
    if (key === undefined)
      throw new Error(`unknown flag ${flag}; expected one of ${[...known.keys()].join(', ')}`);
    if (eq !== -1) {
      out[key] = token.slice(eq + 1);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    out[key] = value;
    index += 1;
  }
  return out as GrantAuthorityRequest;
}

export interface GrantAuthorityResult {
  /** Absent when nothing needed changing: no act happened, so none is recorded. */
  readonly actionId?: string;
  readonly auditDigest?: string;
  readonly clearanceId: string;
  readonly roleAssignmentId: string;
  readonly identityId?: string;
  readonly roleAssignmentReused: boolean;
  readonly clearanceReused: boolean;
  readonly identityReused: boolean;
  readonly changed: boolean;
}

/**
 * Same-day duplicate grants of the SAME clearance collide on the action idempotency index,
 * which is the intended protection against a double-run. A later re-grant is a different day
 * and a different key.
 */
function idempotencyKey(grant: GrantAuthorityGrant, day: string): string {
  return `grant-clearance:${grant.personId}:${grant.organizationId}:${grant.classification}:${day}`;
}

export async function runGrantAuthority(
  owner: Pool,
  grant: GrantAuthorityGrant,
): Promise<GrantAuthorityResult> {
  return withTransaction(owner, async (tx: Tx) => {
    await setAccessContext(tx, {
      organizationId: grant.organizationId,
      maxClassification: grant.classification,
    });

    await assertPersonInOrganization(tx, grant.personId, grant.organizationId, '--person');
    await assertPersonExists(tx, grant.grantedBy, '--granted-by');
    await assertClassificationExists(tx, grant.classification);

    // Decide what is actually missing BEFORE writing anything. Re-running this command after a
    // partial setup is the normal case — the first run of it here found the person already had a
    // clearance and only the identity link was missing — and blindly re-granting would stack a
    // second identical clearance row and record a decision nobody made. If everything asked for
    // already holds, no action is minted and the audit chain does not move: there was no act.
    const existing = await currentAuthority(tx, grant);
    if (!existing.needsChange) {
      return {
        clearanceId: existing.clearanceId as string,
        roleAssignmentId: existing.roleAssignmentId as string,
        roleAssignmentReused: true,
        clearanceReused: true,
        identityReused: existing.identityId !== undefined,
        changed: false,
        ...(existing.identityId === undefined ? {} : { identityId: existing.identityId }),
      };
    }

    // The role the GRANTOR exercises, resolved rather than assumed. `core.action.acting_role_id`
    // is "the role EXERCISED, not every role held" — passing the grantor's person id would put a
    // person where every dispatched action puts a role assignment, and an auditor comparing
    // bootstrap-written and dispatcher-written events would find the column means two things.
    const grantorRole = await tx.maybeOne<{ id: string }>(
      `select id from org.role_assignment
        where subject_id = $1 and scope_id = $2
          and valid_from <= now() and (valid_to is null or valid_to > now())
        order by valid_from limit 1`,
      [grant.grantedBy, grant.organizationId],
    );
    if (grantorRole === undefined) {
      throw new Error(
        `--granted-by ${grant.grantedBy} holds no active role assignment in organization ` +
          `${grant.organizationId}. The record has to say which authority was exercised, and ` +
          'somebody with no role in this organization exercised none.',
      );
    }

    const actionId = randomUUID();
    const effectiveAt = new Date();
    const day = effectiveAt.toISOString().slice(0, 10);

    await setTransactionContext(tx, {
      actorId: grant.grantedBy,
      actingRoleId: grantorRole.id,
      actionId,
      requestId: 'kf-grant-authority',
    });

    const requestDigest = createHash('sha256')
      .update(
        JSON.stringify([
          'grant_person_clearance',
          grant.personId,
          grant.organizationId,
          grant.roleId,
          grant.classification,
          grant.grantedBy,
          grant.identity?.issuer ?? null,
          grant.identity?.subject ?? null,
        ]),
      )
      .digest('hex');

    await tx.query(
      `insert into core.action
         (id, organization_id, request_digest, action_type, actor_id, acting_role_id,
          target_ids, parameters, preconditions, idempotency_key, effective_at,
          reason, result_status, result)
       values ($1,$2,$3,'grant_person_clearance',$4,$4,array[$5]::uuid[],$6::jsonb,'{}'::jsonb,
               $7,$8,$9,'applied','{}'::jsonb)`,
      [
        actionId,
        grant.organizationId,
        requestDigest,
        grant.grantedBy,
        grant.personId,
        JSON.stringify({
          role_id: grant.roleId,
          max_classification: grant.classification,
          ...(grant.identity === undefined ? {} : { issuer: grant.identity.issuer }),
        }),
        idempotencyKey(grant, day),
        effectiveAt.toISOString(),
        grant.reason,
      ],
    );

    const auditDigest = await appendAuditEvent(tx, {
      actionId,
      actionType: 'grant_person_clearance',
      actorId: grant.grantedBy,
      actingRoleId: grantorRole.id,
      objectIds: [grant.personId],
      effectiveAt,
      requestId: 'kf-grant-authority',
      reason: grant.reason,
      // Null on purpose: this path materializes no object state, so there is no before/after to
      // record. The dispatcher computes them from PreparedActionState; claiming a digest here
      // would assert evidence that was never gathered.
      beforeDigest: null,
      afterDigest: null,
    });

    let roleAssignmentId = existing.roleAssignmentId;
    const roleAssignmentReused = roleAssignmentId !== undefined;
    if (roleAssignmentId === undefined) {
      roleAssignmentId = await createControlledObject(tx, {
        objectType: 'role_assignment',
        authorityDomain: 'organization',
        lifecycleState: 'active',
        title: `${grant.roleId} assignment`,
        organizationId: grant.organizationId,
        createdBy: grant.grantedBy,
      });
      await tx.query(
        `insert into org.role_assignment (id, subject_id, role_id, scope_id)
         values ($1,$2,$3,$4)`,
        [roleAssignmentId, grant.personId, grant.roleId, grant.organizationId],
      );
    }

    let clearanceId = existing.clearanceId;
    const clearanceReused = clearanceId !== undefined;
    if (clearanceId === undefined) {
      // The SAME write the dispatched `grant_person_clearance` effect performs. This path exists
      // only because the first grant cannot be dispatched; it must not become a second way of
      // writing the row that decides what someone can see.
      clearanceId = await insertPersonClearance(tx, {
        personId: grant.personId,
        organizationId: grant.organizationId,
        classification: grant.classification,
        grantedBy: grant.grantedBy,
        grantedByAction: actionId,
        reason: grant.reason,
      });
    }

    let identityId = existing.identityId;
    const identityReused = identityId !== undefined;
    if (grant.identity !== undefined && identityId === undefined) {
      identityId = await linkExternalIdentity(tx, grant, grant.identity);
    }

    return {
      actionId,
      auditDigest,
      clearanceId,
      roleAssignmentId,
      roleAssignmentReused,
      clearanceReused,
      identityReused,
      changed: true,
      ...(identityId === undefined ? {} : { identityId }),
    };
  });
}

interface CurrentAuthority {
  readonly clearanceId?: string;
  readonly roleAssignmentId?: string;
  readonly identityId?: string;
  readonly needsChange: boolean;
}

/**
 * What of this grant already holds. An active clearance at a DIFFERENT classification does not
 * count as holding: the model is effective-dated and changing someone's ceiling is a real act
 * that gets its own record.
 */
async function currentAuthority(tx: Tx, grant: GrantAuthorityGrant): Promise<CurrentAuthority> {
  const clearance = await tx.maybeOne<{ id: string }>(
    `select id from org.person_clearance
      where subject_id = $1 and organization_id = $2 and max_classification = $3
        and valid_from <= now() and (valid_to is null or valid_to > now())
      order by valid_from limit 1`,
    [grant.personId, grant.organizationId, grant.classification],
  );
  const role = await tx.maybeOne<{ id: string }>(
    `select id from org.role_assignment
      where subject_id = $1 and role_id = $2 and scope_id = $3
        and valid_from <= now() and (valid_to is null or valid_to > now())
      order by valid_from limit 1`,
    [grant.personId, grant.roleId, grant.organizationId],
  );

  // A clearance at a DIFFERENT classification is not "already held" — but neither can it simply
  // be added. `person_clearance_no_overlap` is a GiST exclusion constraint on
  // (subject_id, organization_id, tstzrange(valid_from, valid_to)), so inserting a second live
  // clearance fails, and it fails as a raw constraint violation an operator has to decode.
  // Changing somebody's ceiling means retiring the old grant deliberately, which is what
  // org.person_clearance_retirement is for.
  if (clearance === undefined) {
    const conflicting = await tx.maybeOne<{ max_classification: string }>(
      `select max_classification from org.person_clearance
        where subject_id = $1 and organization_id = $2
          and valid_from <= now() and (valid_to is null or valid_to > now())
        limit 1`,
      [grant.personId, grant.organizationId],
    );
    if (conflicting !== undefined) {
      throw new Error(
        `person ${grant.personId} already holds an active ${conflicting.max_classification} ` +
          `clearance in organization ${grant.organizationId}. Retire it deliberately before ` +
          `granting ${grant.classification}: two live clearances are refused by ` +
          'person_clearance_no_overlap, and silently replacing one would change what somebody ' +
          'can see without a record of the change.',
      );
    }
  }

  let identity: { id: string; person_id: string } | undefined;
  if (grant.identity !== undefined) {
    identity = await tx.maybeOne<{ id: string; person_id: string }>(
      `select id, person_id from org.external_identity
        where issuer = $1 and subject = $2 and revoked_at is null`,
      [grant.identity.issuer, grant.identity.subject],
    );
    if (identity !== undefined && identity.person_id !== grant.personId) {
      throw new Error(
        `identity ${grant.identity.issuer} / ${grant.identity.subject} is already linked to ` +
          `person ${identity.person_id}. Revoke that link deliberately before pointing it at ` +
          `${grant.personId}; silently repointing it would transfer everything that account reaches.`,
      );
    }
  }

  const identityNeeded = grant.identity !== undefined && identity === undefined;
  return {
    needsChange: clearance === undefined || role === undefined || identityNeeded,
    ...(clearance === undefined ? {} : { clearanceId: clearance.id }),
    ...(role === undefined ? {} : { roleAssignmentId: role.id }),
    ...(identity === undefined ? {} : { identityId: identity.id }),
  };
}

/**
 * Only reached when `currentAuthority` found no live link for this (issuer, subject) — it is
 * what refuses a link already pointing at a different person, so this does not re-check.
 */
async function linkExternalIdentity(
  tx: Tx,
  grant: GrantAuthorityGrant,
  identity: { readonly issuer: string; readonly subject: string },
): Promise<string> {
  return linkIdentity(tx, {
    issuer: identity.issuer,
    subject: identity.subject,
    personId: grant.personId,
    linkedBy: grant.grantedBy,
  });
}

async function assertPersonExists(tx: Tx, personId: string, flag: string): Promise<void> {
  const row = await tx.maybeOne<{ id: string }>('select id from org.person where id = $1', [
    personId,
  ]);
  if (row === undefined) throw new Error(`${flag} ${personId} is not a person in this system`);
}

async function assertPersonInOrganization(
  tx: Tx,
  personId: string,
  organizationId: string,
  flag: string,
): Promise<void> {
  const row = await tx.maybeOne<{ id: string }>(
    'select id from org.person where id = $1 and organization = $2',
    [personId, organizationId],
  );
  if (row === undefined) {
    throw new Error(
      `${flag} ${personId} is not a person in organization ${organizationId}. A clearance is ` +
        'organization-scoped, so granting one across organizations is meaningless.',
    );
  }
}

async function assertClassificationExists(tx: Tx, classification: string): Promise<void> {
  const row = await tx.maybeOne<{ id: string }>(
    'select id from registry.classification where id = $1',
    [classification],
  );
  if (row === undefined) {
    const known = await tx.query<{ id: string }>(
      'select id from registry.classification order by id',
    );
    const ids = known.map((row) => row.id).join(', ');
    throw new Error(`unknown --clearance ${classification}; registry.classification has: ${ids}`);
  }
}
