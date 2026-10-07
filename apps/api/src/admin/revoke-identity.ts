/**
 * Withdraw an identity provider account's link to a person, as a recorded act.
 *
 * The link is made by `kf grant-authority` over the owner credential, because since
 * `20260923000200` the application login holds neither INSERT nor UPDATE on
 * `org.external_identity`. Its withdrawal had no command at all: the runbook said "revokeIdentity
 * sets revoked_at — over the owner connection; there is no command for it yet", which in practice
 * meant an owner typing an UPDATE with no act, no reason and no audit entry — the one change to
 * who can sign in as whom that the record would not show.
 *
 * This is the same shape as grant-authority: the OWNER connection, outside the dispatcher (there
 * is no dispatched path to the identity table to go through), recording a real
 * `revoke_external_identity` action with the operator's reason and extending the audit chain
 * through `appendAuditEvent`, then setting `revoked_at` through `revokeIdentity` — in one
 * transaction, so there is never a revoked link without its act or an act without its revocation.
 *
 * The row is never deleted: who used to be able to sign in as whom is a fact an investigation
 * needs. A link already revoked is refused, not re-recorded: there was no act.
 *
 * Attestations the person holds are withdrawn in the same transaction. They live at most a
 * minute, but "revoked" should mean the next request is refused, not the one after next.
 */

import { randomUUID } from 'node:crypto';
import { taggedDigest } from '@kf/canonicalization';
import { appendAuditEvent } from '@kf/actions';
import { revokeIdentity } from '@kf/authorization';
import {
  setAccessContext,
  setTransactionContext,
  withTransaction,
  type Pool,
  type Tx,
} from '@kf/database';

import { BOOTSTRAP_IDENTITY } from './bootstrap-organization.js';

export interface RevokeIdentityRequest {
  /** The `org.external_identity` row. Or issuer and subject, never both forms. */
  readonly identityId?: string;
  readonly issuer?: string;
  readonly subject?: string;
  readonly revokedBy?: string;
  readonly reason?: string;
}

export type RevokeIdentityTarget =
  { readonly identityId: string } | { readonly issuer: string; readonly subject: string };

export interface RevokeIdentityDecision {
  readonly target: RevokeIdentityTarget;
  readonly revokedBy: string;
  readonly reason: string;
}

export type RevokeIdentityPlan =
  | { readonly ok: true; readonly decision: RevokeIdentityDecision }
  | { readonly ok: false; readonly refusals: readonly string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function revokeIdentityUsage(): string {
  return [
    'kf revoke-identity (--identity <uuid> | --issuer <url> --subject <sub>) \\',
    '    --revoked-by <person uuid> --reason <text>',
  ].join('\n');
}

/** Validate a revocation without touching a database; every refusal at once. */
export function planRevokeIdentity(request: RevokeIdentityRequest): RevokeIdentityPlan {
  const refusals: string[] = [];
  const identityId = request.identityId?.trim() ?? '';
  const issuer = request.issuer?.trim() ?? '';
  const subject = request.subject?.trim() ?? '';
  const revokedBy = request.revokedBy?.trim() ?? '';
  const reason = request.reason?.trim() ?? '';

  const byId = identityId !== '';
  const byAccount = issuer !== '' || subject !== '';
  if (byId && byAccount) {
    refusals.push(
      'give --identity OR --issuer with --subject, not both: two names for the link could name ' +
        'two different links',
    );
  } else if (!byId && !byAccount) {
    refusals.push('no link named: give --identity <uuid>, or --issuer <url> with --subject <sub>');
  } else if (byId && !UUID.test(identityId)) {
    refusals.push(`--identity must be a uuid, got ${JSON.stringify(identityId)}`);
  } else if (byAccount && (issuer === '' || subject === '')) {
    refusals.push(
      '--issuer and --subject must be given together: a subject is unique only within its ' +
        'issuer, so either alone identifies no account.',
    );
  }

  if (revokedBy === '') {
    refusals.push(
      'no --revoked-by given: who decided this. A revocation with no decider is not auditable',
    );
  } else if (!UUID.test(revokedBy)) {
    refusals.push(`--revoked-by must be a person's uuid, got ${JSON.stringify(revokedBy)}`);
  }

  if (reason === '') {
    refusals.push(
      'no --reason given. The record has to say why this account can no longer sign in as ' +
        'this person: a departure, a compromised account, a link made in error.',
    );
  }

  if (refusals.length > 0) return { ok: false, refusals };
  return {
    ok: true,
    decision: {
      target: byId ? { identityId } : { issuer, subject },
      revokedBy,
      reason,
    },
  };
}

/** `--flag value` and `--flag=value`; unknown flags are refused, not ignored. */
export function parseRevokeIdentityArgs(argv: readonly string[]): RevokeIdentityRequest {
  const known = new Map<string, keyof RevokeIdentityRequest>([
    ['--identity', 'identityId'],
    ['--issuer', 'issuer'],
    ['--subject', 'subject'],
    ['--revoked-by', 'revokedBy'],
    ['--reason', 'reason'],
  ]);
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    const eq = token.indexOf('=');
    const flag = eq === -1 ? token : token.slice(0, eq);
    const key = known.get(flag);
    if (key === undefined) {
      throw new Error(`unknown flag ${flag}; expected one of ${[...known.keys()].join(', ')}`);
    }
    if (eq !== -1) {
      out[key] = token.slice(eq + 1);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    out[key] = value;
    index += 1;
  }
  return out as RevokeIdentityRequest;
}

export interface RevokeIdentityResult {
  readonly actionId: string;
  readonly auditDigest: string;
  readonly identityId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly personId: string;
  readonly organizationId: string;
  readonly revokedAt: Date;
  /** The role assignment the revoker exercised, or undefined when they hold none there. */
  readonly actingRoleId?: string;
  /** Attestations the person held that stopped counting with this act. */
  readonly attestationsWithdrawn: number;
}

type LinkRow = {
  readonly id: string;
  readonly issuer: string;
  readonly subject: string;
  readonly person_id: string;
  readonly revoked_at: Date | null;
};

export class IdentityAlreadyRevoked extends Error {
  constructor(link: LinkRow) {
    super(
      `identity ${link.id} (${link.issuer} / ${link.subject}) was already revoked at ` +
        `${(link.revoked_at as Date).toISOString()}. Nothing was written: there was no act.`,
    );
    this.name = 'IdentityAlreadyRevoked';
  }
}

async function findLink(tx: Tx, target: RevokeIdentityTarget): Promise<LinkRow> {
  // FOR UPDATE: two operators revoking the same link at once must not record two acts.
  const row =
    'identityId' in target
      ? await tx.maybeOne<LinkRow>(
          `select id, issuer, subject, person_id, revoked_at from org.external_identity
            where id = $1 for update`,
          [target.identityId],
        )
      : // `external_identity_unique`: one row per (issuer, subject), revoked or not.
        await tx.maybeOne<LinkRow>(
          `select id, issuer, subject, person_id, revoked_at from org.external_identity
            where issuer = $1 and subject = $2 for update`,
          [target.issuer, target.subject],
        );
  if (row === undefined) {
    throw new Error(
      'identityId' in target
        ? `no identity link ${target.identityId}`
        : `no identity link for ${target.issuer} / ${target.subject}`,
    );
  }
  return row;
}

export async function runRevokeIdentity(
  owner: Pool,
  decision: RevokeIdentityDecision,
): Promise<RevokeIdentityResult> {
  return withTransaction(owner, async (tx: Tx) => {
    const link = await findLink(tx, decision.target);
    if (link.revoked_at !== null) throw new IdentityAlreadyRevoked(link);

    const person = await tx.one<{ organization: string }>(
      'select organization from org.person where id = $1',
      [link.person_id],
    );
    const organizationId = person.organization;
    await setAccessContext(tx, { organizationId, maxClassification: 'restricted' });

    const revoker = await tx.maybeOne<{ id: string }>('select id from org.person where id = $1', [
      decision.revokedBy,
    ]);
    if (revoker === undefined) {
      throw new Error(`--revoked-by ${decision.revokedBy} is not a person in this system`);
    }

    // The role the revoker exercises in the person's organization, when they hold one, so the
    // record says which authority was used. Revocation is not refused when they hold none: it is
    // how access is withdrawn in an emergency, from an organization that may have nobody left to
    // act in it. The act is then recorded under the bootstrap role, as `kf retire-organization`
    // records one, and the output says so.
    const role = await tx.maybeOne<{ id: string }>(
      `select id from org.role_assignment
        where subject_id = $1 and scope_id = $2
          and valid_from <= now() and (valid_to is null or valid_to > now())
        order by valid_from limit 1`,
      [decision.revokedBy, organizationId],
    );
    const actingRoleId = role?.id ?? BOOTSTRAP_IDENTITY;

    const actionId = randomUUID();
    const effectiveAt = new Date();
    await setTransactionContext(tx, {
      actorId: decision.revokedBy,
      actingRoleId,
      actionId,
      requestId: 'kf-revoke-identity',
    });

    // Outstanding attestations for this person stop counting now rather than within the minute.
    // A person who still holds another live link is attested again on their next request.
    const withdrawn = await tx.query<{ digest: Buffer }>(
      'delete from core.principal_attestation where person_id = $1 returning digest',
      [link.person_id],
    );

    const parameters = {
      identity_id: link.id,
      issuer: link.issuer,
      subject: link.subject,
    };
    // Tagged and canonical (KF-SAS-RQ-016, SAS §100.27). Acts recorded before carry an untagged
    // sha256 over JSON.stringify of the same values; nothing recomputes either.
    const requestDigest = taggedDigest('kf-revoke-external-identity-request-v1', {
      actionType: 'revoke_external_identity',
      identityId: link.id,
      issuer: link.issuer,
      subject: link.subject,
      personId: link.person_id,
      revokedBy: decision.revokedBy,
    });

    await tx.query(
      `insert into core.action
         (id, organization_id, request_digest, action_type, actor_id, acting_role_id,
          target_ids, parameters, preconditions, idempotency_key, effective_at,
          reason, result_status, result)
       values ($1,$2,$3,'revoke_external_identity',$4,$5,array[$6]::uuid[],$7::jsonb,'{}'::jsonb,
               $8,$9,$10,'applied',$11::jsonb)`,
      [
        actionId,
        organizationId,
        requestDigest,
        decision.revokedBy,
        actingRoleId,
        link.person_id,
        JSON.stringify(parameters),
        // A link is revoked once; its id is the whole key.
        `revoke-identity:${link.id}`,
        effectiveAt.toISOString(),
        decision.reason,
        JSON.stringify({ attestations_withdrawn: withdrawn.length }),
      ],
    );

    const auditDigest = await appendAuditEvent(tx, {
      actionId,
      actionType: 'revoke_external_identity',
      actorId: decision.revokedBy,
      actingRoleId,
      objectIds: [link.person_id],
      effectiveAt,
      requestId: 'kf-revoke-identity',
      reason: decision.reason,
      // The identity row is not a controlled object; no object state moved.
      beforeDigest: null,
      afterDigest: null,
    });

    // The SAME write the identity package owns for this, not a second way of making it.
    await revokeIdentity(tx, link.id);
    const revoked = await tx.one<{ revoked_at: Date | null }>(
      'select revoked_at from org.external_identity where id = $1',
      [link.id],
    );
    if (revoked.revoked_at === null) {
      throw new Error(`identity ${link.id} was not revoked; nothing was committed`);
    }

    return {
      actionId,
      auditDigest,
      identityId: link.id,
      issuer: link.issuer,
      subject: link.subject,
      personId: link.person_id,
      organizationId,
      revokedAt: revoked.revoked_at,
      ...(role === undefined ? {} : { actingRoleId: role.id }),
      attestationsWithdrawn: withdrawn.length,
    };
  });
}
