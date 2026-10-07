/**
 * Invite a person: `kf invite` (ADR 0040 decision 12; ADR 0038; KF-SAS-RQ-236, RQ-275).
 *
 * Joining is being granted scope, then qualifying, and nothing else (RQ-275). An invitation is
 * therefore not a mechanism of its own: it is the owner doing, in one run, the acts that already
 * make someone a member, plus a link that takes them to Start Here.
 *
 *   1. THE PERSON — `bootstrap-organization --organization`, the owner's act (RQ-236).
 *   2. THE ACCOUNT — with `--keycloak`, the invitee's identity-provider account, created by the
 *      owner with "set a password" and "verify your email" required, and Keycloak's own action
 *      email sent; its subject is what the identity link names. Without it, `--subject` names an
 *      account the operator already made (`create-dev-user.sh`).
 *   3. THE AUTHORITY — `grant-authority`: the identity link, the role assignment ending within 366
 *      days (ADR 0036; one year unless `--valid-to` says otherwise) and the clearance, granted by
 *      the inviter. Owner-only (RQ-236).
 *   4. THE QUALIFICATION — with `--pack`, an `assign_qualification` act of the inviter, recorded
 *      under the owner credential as grant-authority records `grant_person_clearance`: the record
 *      pinned to the pack's current approved revision, with the named contact. The same row the
 *      dispatched act writes, by the same rules, checked here first.
 *   5. THE INVITATION — an `invite_person` act and its row: the digest of a fresh token, never
 *      the token; the assignment and the record prepared; an expiry within 30 days.
 *
 * The link is `<web>/join/<token>`. It carries no authority: it is a way back to the Fabric for
 * the account the owner linked, and the web application only follows it for that signed-in
 * person (`GET /invitations/:token`). Printed once; not stored.
 */

import { randomBytes } from 'node:crypto';
import { taggedDigest } from '@kf/canonicalization';
import { invitationTokenDigest } from '@kf/qualification';
import { appendAuditEvent } from '@kf/actions';
import {
  setAccessContext,
  setTransactionContext,
  withTransaction,
  type Pool,
  type Tx,
} from '@kf/database';
import { createControlledObject } from '@kf/record-atoms';
import { resolveAssignmentEnd } from './assignment-end.js';
import { runBootstrap } from './bootstrap-organization.js';
import { runGrantAuthority } from './grant-authority.js';
import { inviteAtKeycloak, type KeycloakAdmin } from './keycloak-invite.js';

export interface InviteRequest {
  readonly organizationId?: string;
  readonly name?: string;
  readonly email?: string;
  readonly roleId?: string;
  readonly classification?: string;
  readonly roleCeiling?: string;
  readonly invitedBy?: string;
  readonly contactId?: string;
  readonly packId?: string;
  readonly scopeObjectId?: string;
  readonly reason?: string;
  readonly issuer?: string;
  readonly subject?: string;
  readonly validTo?: string;
  readonly expiresInDays?: string;
  readonly webOrigin?: string;
  /** Create the account at Keycloak (needs the admin credential). */
  readonly keycloak?: boolean;
}

export interface InvitePlan {
  readonly organizationId: string;
  readonly name: string;
  readonly email: string;
  readonly roleId: string;
  readonly classification: string;
  readonly roleCeiling?: string;
  readonly invitedBy: string;
  readonly contactId: string;
  readonly packId?: string;
  readonly scopeObjectId?: string;
  readonly reason: string;
  readonly issuer: string;
  readonly subject?: string;
  readonly validTo: Date;
  readonly expiresAt: Date;
  readonly webOrigin: string;
  readonly keycloak: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_MS = 86_400_000;
export const INVITATION_MAX_DAYS = 30;

export function planInvite(
  request: InviteRequest,
  now: Date = new Date(),
): { ok: true; plan: InvitePlan } | { ok: false; refusals: string[] } {
  const refusals: string[] = [];
  const need = (value: string | undefined, flag: string, why: string): string => {
    const text = value?.trim() ?? '';
    if (text === '') refusals.push(`${flag} is required: ${why}`);
    return text;
  };
  const organizationId = need(request.organizationId, '--organization', 'where they join');
  const name = need(request.name, '--name', 'a person is named, never a placeholder');
  const email = need(request.email, '--email', 'where the invitation goes');
  const roleId = need(request.roleId, '--role', 'the scope they are granted (a role preset)');
  const classification = need(request.classification, '--clearance', 'nothing widens by default');
  const invitedBy = need(request.invitedBy, '--invited-by', 'who decided, under which authority');
  const contactId = need(request.contactId, '--contact', 'each person has one named contact');
  const reason = need(request.reason, '--reason', 'why they are invited');
  const webOrigin = need(request.webOrigin, '--web', 'the web application the link opens');
  for (const [value, flag] of [
    [organizationId, '--organization'],
    [invitedBy, '--invited-by'],
    [contactId, '--contact'],
    [request.packId, '--pack'],
    [request.scopeObjectId, '--scope'],
  ] as const) {
    if (value !== undefined && value !== '' && !UUID.test(value))
      refusals.push(`${flag} is a uuid`);
  }
  if (email !== '' && !EMAIL.test(email)) refusals.push(`--email ${email} is not an address`);
  if (request.scopeObjectId !== undefined && request.packId === undefined) {
    refusals.push('--scope names the scope of a qualification: give --pack too');
  }
  if (webOrigin !== '' && !/^https?:\/\/[^/\s]+$/.test(webOrigin.replace(/\/+$/, ''))) {
    refusals.push('--web is an origin, like https://kf.example');
  }
  const keycloak = request.keycloak === true;
  if (!keycloak && (request.subject === undefined || request.subject.trim() === '')) {
    refusals.push(
      '--subject names the account the operator already created, or --keycloak creates one: ' +
        'the identity link must name an account',
    );
  }
  if (keycloak && request.subject !== undefined) {
    refusals.push('--subject and --keycloak are exclusive: one names an account, one creates it');
  }
  const issuer = need(request.issuer, '--issuer', 'the identity provider that vouches for them');
  const end = resolveAssignmentEnd(request.validTo, now);
  if (!end.ok) refusals.push(end.refusal);
  const days = request.expiresInDays === undefined ? 7 : Number(request.expiresInDays);
  if (!Number.isInteger(days) || days < 1 || days > INVITATION_MAX_DAYS) {
    refusals.push(`--expires-in-days is 1 to ${String(INVITATION_MAX_DAYS)}`);
  }
  if (refusals.length > 0 || !end.ok) return { ok: false, refusals };
  return {
    ok: true,
    plan: {
      organizationId,
      name,
      email,
      roleId,
      classification,
      ...(request.roleCeiling === undefined ? {} : { roleCeiling: request.roleCeiling }),
      invitedBy,
      contactId,
      ...(request.packId === undefined ? {} : { packId: request.packId }),
      ...(request.scopeObjectId === undefined ? {} : { scopeObjectId: request.scopeObjectId }),
      reason,
      issuer,
      ...(request.subject === undefined ? {} : { subject: request.subject.trim() }),
      validTo: end.validTo,
      expiresAt: new Date(now.getTime() + days * DAY_MS),
      webOrigin: webOrigin.replace(/\/+$/, ''),
      keycloak,
    },
  };
}

export function parseInviteArgs(argv: readonly string[]): InviteRequest {
  const values: Record<string, string> = {};
  let keycloak = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--keycloak') {
      keycloak = true;
      continue;
    }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (match === null) throw new Error(`unexpected argument ${arg}`);
    const value = match[2] ?? argv[++i];
    if (value === undefined || value === '') throw new Error(`--${match[1]!} needs a value`);
    values[match[1]!] = value;
  }
  const map: Record<string, keyof InviteRequest> = {
    organization: 'organizationId',
    name: 'name',
    email: 'email',
    role: 'roleId',
    clearance: 'classification',
    'role-ceiling': 'roleCeiling',
    'invited-by': 'invitedBy',
    contact: 'contactId',
    pack: 'packId',
    scope: 'scopeObjectId',
    reason: 'reason',
    issuer: 'issuer',
    subject: 'subject',
    'valid-to': 'validTo',
    'expires-in-days': 'expiresInDays',
    web: 'webOrigin',
  };
  const out: Record<string, unknown> = { keycloak };
  for (const [flag, value] of Object.entries(values)) {
    const key = map[flag];
    if (key === undefined) throw new Error(`unknown option --${flag}`);
    out[key] = value;
  }
  return out as InviteRequest;
}

export function inviteUsage(): string {
  return [
    'usage: kf invite --organization <uuid> --name <full name> --email <address>',
    '                 --role <role> --clearance <classification> [--role-ceiling <c>]',
    '                 --invited-by <person uuid> --contact <person uuid> --reason <why>',
    '                 --issuer <oidc issuer> (--subject <account subject> | --keycloak)',
    '                 [--pack <qualification pack uuid> [--scope <object uuid>]]',
    '                 [--valid-to <date>] [--expires-in-days <1..30>] --web <origin>',
  ].join('\n');
}

export interface InviteResult {
  readonly personId: string;
  readonly subject: string;
  readonly roleAssignmentId: string;
  readonly recordId?: string;
  readonly invitationId: string;
  /** Shown once; the database holds only its digest. */
  readonly link: string;
  readonly expiresAt: Date;
  readonly keycloak?: { readonly created: boolean; readonly actionsEmailSent: boolean };
}

async function recordAct(
  tx: Tx,
  act: {
    readonly actionId: string;
    readonly organizationId: string;
    readonly actionType: 'assign_qualification' | 'invite_person';
    readonly actorId: string;
    readonly actingRoleId: string;
    readonly targetIds: readonly string[];
    readonly parameters: Record<string, unknown>;
    readonly reason: string;
  },
): Promise<void> {
  const effectiveAt = (
    await tx.one<{ at: Date }>(
      "select date_trunc('milliseconds', now() + interval '999 microseconds') as at",
    )
  ).at;
  await tx.query(
    `insert into core.action
       (id, organization_id, request_digest, action_type, actor_id, acting_role_id, target_ids,
        parameters, preconditions, idempotency_key, effective_at, request_id, reason,
        result_status, result)
     values ($1, $2, $3, $4, $5, $6, $7::uuid[], $8::jsonb, '{}'::jsonb, $9, $10, 'kf-invite', $11,
             'applied', '{}'::jsonb)`,
    [
      act.actionId,
      act.organizationId,
      taggedDigest('kf-invite-request-v1', {
        actionType: act.actionType,
        targetIds: [...act.targetIds],
        parameters: act.parameters,
      }),
      act.actionType,
      act.actorId,
      act.actingRoleId,
      [...act.targetIds],
      JSON.stringify(act.parameters),
      `kf-invite:${act.actionId}`,
      new Date(effectiveAt).toISOString(),
      act.reason,
    ],
  );
  await appendAuditEvent(tx, {
    actionId: act.actionId,
    actionType: act.actionType,
    actorId: act.actorId,
    actingRoleId: act.actingRoleId,
    objectIds: [...act.targetIds],
    effectiveAt: new Date(effectiveAt),
    requestId: 'kf-invite',
    reason: act.reason,
    beforeDigest: null,
    afterDigest: null,
  });
}

/** Steps 4 and 5, in one owner transaction. Exported for the test that runs them alone. */
export async function prepareJoining(
  owner: Pool,
  input: {
    readonly organizationId: string;
    readonly personId: string;
    readonly roleAssignmentId: string;
    readonly invitedBy: string;
    readonly contactId: string;
    readonly packId?: string;
    readonly scopeObjectId?: string;
    readonly reason: string;
    readonly expiresAt: Date;
    readonly tokenDigest: string;
  },
): Promise<{ recordId?: string; invitationId: string }> {
  return withTransaction(owner, async (tx) => {
    await setAccessContext(tx, {
      organizationId: input.organizationId,
      maxClassification: 'restricted',
    });
    const inviterAssignment = await tx.maybeOne<{ id: string }>(
      `select ra.id from org.role_assignment ra join core.object o on o.id = ra.id
        where ra.subject_id = $1 and o.organization_id = $2 and o.lifecycle_state = 'active'
          and ra.valid_from <= now() and (ra.valid_to is null or ra.valid_to > now())
        order by ra.valid_from limit 1`,
      [input.invitedBy, input.organizationId],
    );
    if (inviterAssignment === undefined) {
      throw new Error(
        `--invited-by ${input.invitedBy} holds no live assignment here; the record has to say ` +
          'which authority invited them',
      );
    }
    const contactLive = await tx.maybeOne<{ id: string }>(
      `select ra.id from org.role_assignment ra join core.object o on o.id = ra.id
        where ra.subject_id = $1 and o.organization_id = $2 and o.lifecycle_state = 'active'
          and ra.valid_from <= now() and (ra.valid_to is null or ra.valid_to > now())
        limit 1`,
      [input.contactId, input.organizationId],
    );
    if (contactLive === undefined || input.contactId === input.personId) {
      throw new Error(
        `--contact ${input.contactId} must be someone else with a live assignment here: the ` +
          'person they can ask (ADR 0038 decision 10)',
      );
    }
    let recordId: string | undefined;
    if (input.packId !== undefined) {
      const pack = await tx.maybeOne<{ title: string; revision: number | null }>(
        `select o.title,
                (select max(r.revision) from org.qualification_pack_revision r
                  where r.pack_id = o.id and r.approved_at is not null) as revision
           from core.object o
          where o.id = $1 and o.object_type = 'qualification_pack'
            and o.lifecycle_state = 'approved' and o.organization_id = $2`,
        [input.packId, input.organizationId],
      );
      if (pack === undefined || pack.revision === null) {
        throw new Error(`--pack ${input.packId} is not an approved qualification pack here`);
      }
      const scope =
        input.scopeObjectId === undefined
          ? undefined
          : await tx.maybeOne<{ title: string }>(
              'select title from core.object where id = $1 and organization_id = $2',
              [input.scopeObjectId, input.organizationId],
            );
      if (input.scopeObjectId !== undefined && scope === undefined) {
        throw new Error(`--scope ${input.scopeObjectId} is not a record in this organization`);
      }
      const actionId = (await tx.one<{ id: string }>('select uuidv7()::text as id')).id;
      await setTransactionContext(tx, {
        actorId: input.invitedBy,
        actingRoleId: inviterAssignment.id,
        actionId,
        requestId: 'kf-invite',
      });
      recordId = await createControlledObject(tx, {
        objectType: 'qualification_record',
        authorityDomain: 'organization',
        lifecycleState: 'assigned',
        title:
          scope === undefined
            ? `Qualification: ${pack.title}`
            : `Qualification: ${pack.title} — ${scope.title}`,
        organizationId: input.organizationId,
        createdBy: input.invitedBy,
      });
      await recordAct(tx, {
        actionId,
        organizationId: input.organizationId,
        actionType: 'assign_qualification',
        actorId: input.invitedBy,
        actingRoleId: inviterAssignment.id,
        targetIds: [recordId],
        parameters: {
          person_id: input.personId,
          pack_id: input.packId,
          contact_person_id: input.contactId,
          ...(input.scopeObjectId === undefined ? {} : { scope_object_id: input.scopeObjectId }),
        },
        reason: input.reason,
      });
      // The row the dispatched act writes, with the values its trigger would set.
      await tx.query(
        `insert into org.qualification_record
           (id, organization_id, person_id, scope_object_id, pack_id, pack_revision,
            contact_person_id, assigned_by, assigned_by_action)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          recordId,
          input.organizationId,
          input.personId,
          input.scopeObjectId ?? null,
          input.packId,
          pack.revision,
          input.contactId,
          input.invitedBy,
          actionId,
        ],
      );
    }
    const inviteAction = (await tx.one<{ id: string }>('select uuidv7()::text as id')).id;
    await setTransactionContext(tx, {
      actorId: input.invitedBy,
      actingRoleId: inviterAssignment.id,
      actionId: inviteAction,
      requestId: 'kf-invite',
    });
    await recordAct(tx, {
      actionId: inviteAction,
      organizationId: input.organizationId,
      actionType: 'invite_person',
      actorId: input.invitedBy,
      actingRoleId: inviterAssignment.id,
      targetIds: [
        input.personId,
        input.roleAssignmentId,
        ...(recordId === undefined ? [] : [recordId]),
      ],
      parameters: { expires_at: input.expiresAt.toISOString() },
      reason: input.reason,
    });
    const invitation = await tx.one<{ id: string }>(
      `insert into org.invitation
         (organization_id, person_id, token_digest, role_assignment_id, qualification_record_id,
          contact_person_id, invited_by, invited_by_action, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id`,
      [
        input.organizationId,
        input.personId,
        input.tokenDigest,
        input.roleAssignmentId,
        recordId ?? null,
        input.contactId,
        input.invitedBy,
        inviteAction,
        input.expiresAt.toISOString(),
      ],
    );
    return { ...(recordId === undefined ? {} : { recordId }), invitationId: invitation.id };
  });
}

export async function runInvite(
  owner: Pool,
  plan: InvitePlan,
  keycloakAdmin?: KeycloakAdmin,
  webClientId = 'knowledge-fabric-web',
): Promise<InviteResult> {
  const token = randomBytes(32).toString('base64url');
  const link = `${plan.webOrigin}/join/${token}`;
  const person = await runBootstrap(owner, {
    legalName: '',
    personName: plan.name,
    organizationKind: 'company',
    organizationId: plan.organizationId,
  });
  let subject = plan.subject;
  let keycloak: InviteResult['keycloak'];
  if (plan.keycloak) {
    if (keycloakAdmin === undefined)
      throw new Error('--keycloak needs the Keycloak admin credential');
    const [firstName = plan.name, ...rest] = plan.name.split(/\s+/);
    const invited = await inviteAtKeycloak(
      keycloakAdmin,
      {
        username: plan.email.toLowerCase(),
        email: plan.email,
        firstName,
        lastName: rest.join(' ') || firstName,
      },
      {
        clientId: webClientId,
        redirectUri: link,
        lifespanSeconds: Math.round((plan.expiresAt.getTime() - Date.now()) / 1000),
      },
    );
    subject = invited.subject;
    keycloak = { created: invited.created, actionsEmailSent: invited.actionsEmailSent };
  }
  if (subject === undefined) throw new Error('no account subject to link');
  const grant = await runGrantAuthority(owner, {
    personId: person.personId,
    organizationId: plan.organizationId,
    roleId: plan.roleId,
    classification: plan.classification,
    ...(plan.roleCeiling === undefined ? {} : { roleCeiling: plan.roleCeiling }),
    grantedBy: plan.invitedBy,
    reason: plan.reason,
    identity: { issuer: plan.issuer, subject },
    validTo: plan.validTo,
  });
  const prepared = await prepareJoining(owner, {
    organizationId: plan.organizationId,
    personId: person.personId,
    roleAssignmentId: grant.roleAssignmentId,
    invitedBy: plan.invitedBy,
    contactId: plan.contactId,
    ...(plan.packId === undefined ? {} : { packId: plan.packId }),
    ...(plan.scopeObjectId === undefined ? {} : { scopeObjectId: plan.scopeObjectId }),
    reason: plan.reason,
    expiresAt: plan.expiresAt,
    tokenDigest: invitationTokenDigest(token),
  });
  return {
    personId: person.personId,
    subject,
    roleAssignmentId: grant.roleAssignmentId,
    ...(prepared.recordId === undefined ? {} : { recordId: prepared.recordId }),
    invitationId: prepared.invitationId,
    link,
    expiresAt: plan.expiresAt,
    ...(keycloak === undefined ? {} : { keycloak }),
  };
}
