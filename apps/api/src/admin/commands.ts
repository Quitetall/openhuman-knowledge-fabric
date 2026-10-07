/**
 * The bootstrap-tier commands as `kf` subcommands.
 *
 * Each needs the owner connection string and is refused without it. It is read through the
 * shared secret loader from `DATABASE_OWNER_URL_FILE` (an owner-only file); the inline
 * `DATABASE_OWNER_URL` is accepted only when `NODE_ENV` is `development` or `test` (RQ-151).
 * The owner URL carries the one password that can rewrite authority, and an environment
 * variable is readable from `/proc`, inherited by every child and printed by crash reporters.
 *
 * Each prints refusals as refusals —
 * one line per reason, no stack trace — because a refusal is a feature and a stack trace says
 * where the throw was written, not what to do.
 */

import { createPool } from '@kf/database';
import { loadSecret } from '@kf/operations';

import {
  bootstrapUsage,
  parseBootstrapArgs,
  planBootstrap,
  runBootstrap,
} from './bootstrap-organization.js';
import {
  declareAgentUsage,
  parseDeclareAgentArgs,
  planDeclareAgent,
  runDeclareAgent,
} from './declare-agent.js';
import {
  defineRoleUsage,
  parseDefineRoleArgs,
  planDefineRole,
  runDefineRole,
} from './define-role.js';
import {
  parseDeclareServiceActorArgs,
  planDeclareServiceActor,
  runDeclareServiceActor,
} from './declare-service-actor.js';
import {
  parseGrantAuthorityArgs,
  planGrantAuthority,
  runGrantAuthority,
} from './grant-authority.js';
import { inviteUsage, parseInviteArgs, planInvite, runInvite } from './invite.js';
import type { KeycloakAdmin } from './keycloak-invite.js';
import {
  parseRevokeIdentityArgs,
  planRevokeIdentity,
  revokeIdentityUsage,
  runRevokeIdentity,
} from './revoke-identity.js';
import {
  parseRetireOrganizationArgs,
  planRetireOrganization,
  retireOrganizationUsage,
  runRetireOrganization,
} from './retire-organization.js';

type Out = NodeJS.WritableStream;

/**
 * The owner connection string, or `undefined` after printing why not.
 *
 * `DATABASE_OWNER_URL_FILE` always; the inline variable only in development and test, the same
 * rule every other secret in the system follows (`@kf/operations` `loadSecret`). The refusal
 * names the variable and the path, never the value.
 */
export function ownerUrl(env: NodeJS.ProcessEnv, err: Out): string | undefined {
  try {
    return loadSecret('DATABASE_OWNER_URL', env, {
      allowInline: env['NODE_ENV'] === 'development' || env['NODE_ENV'] === 'test',
    });
  } catch (error: unknown) {
    err.write(
      `${message(error)}\nthe owner connection is required: this writes authority and needs ` +
        'the owner role (DATABASE_OWNER_URL_FILE, owner-only)\n',
    );
    return undefined;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runBootstrapCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  out: Out = process.stdout,
  err: Out = process.stderr,
): Promise<number> {
  const url = ownerUrl(env, err);
  if (url === undefined) return 1;
  let request;
  try {
    request = parseBootstrapArgs(argv);
  } catch (error: unknown) {
    err.write(`${message(error)}\n\n${bootstrapUsage()}\n`);
    return 2;
  }
  const plan = planBootstrap(request);
  if (!plan.ok || plan.declaration === undefined) {
    for (const refusal of plan.refusals) err.write(`${refusal}\n`);
    err.write(`\n${bootstrapUsage()}\n`);
    return 2;
  }
  const pool = createPool({ connectionString: url, maxConnections: 2 });
  try {
    const result = await runBootstrap(pool, plan.declaration);
    out.write(`${result.reused ? 'already present:' : 'created:'}\n`);
    out.write(`  organization ${result.organizationId}\n`);
    out.write(`  person       ${result.personId}\n`);
    out.write('\nNext: grant this person a role and a clearance. That is a human act:\n');
    out.write(`  kf grant-authority --person ${result.personId} \\\n`);
    out.write(`      --organization ${result.organizationId} --role <role> ...\n`);
    return 0;
  } catch (error: unknown) {
    err.write(`${message(error)}\n`);
    return 1;
  } finally {
    await pool.end();
  }
}

export async function runGrantAuthorityCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  out: Out = process.stdout,
  err: Out = process.stderr,
): Promise<number> {
  const url = ownerUrl(env, err);
  if (url === undefined) return 1;
  let request;
  try {
    request = parseGrantAuthorityArgs(argv);
  } catch (error: unknown) {
    err.write(`${message(error)}\n`);
    return 2;
  }
  const plan = planGrantAuthority(request);
  if (!plan.ok) {
    err.write('refusing to grant authority:\n');
    for (const refusal of plan.refusals) err.write(`  - ${refusal}\n`);
    return 2;
  }
  const owner = createPool({ connectionString: url, maxConnections: 2 });
  try {
    const result = await runGrantAuthority(owner, plan.grant);
    const held = (reused: boolean): string => (reused ? '(already held)' : '(granted now)');
    if (result.changed) {
      out.write('authority granted, and recorded:\n');
      out.write(`  action        ${result.actionId}  (grant_person_clearance)\n`);
      out.write(`  audit digest  ${result.auditDigest}\n`);
    } else {
      // No act, so no action row and no audit link. Saying "granted" here would put a decision
      // in the operator's head that is not in the record.
      out.write('nothing to do — this authority already holds. Nothing was written:\n');
    }
    out.write(
      `  clearance     ${result.clearanceId}  ${plan.grant.classification} ${held(result.clearanceReused)}\n`,
    );
    out.write(
      `  role          ${result.roleAssignmentId}  ${plan.grant.roleId} ${held(result.roleAssignmentReused)}\n`,
    );
    // The review date, always: an operator who took the default must see what they agreed to.
    out.write(
      result.roleAssignmentValidTo === null
        ? '  ends          never recorded (made before ADR 0036): renew it with --renew\n'
        : `  ends          ${result.roleAssignmentValidTo.toISOString()}${
            !result.roleAssignmentReused && plan.grant.validToDefaulted
              ? '  (one year: the default; --valid-to sets another)'
              : ''
          }\n`,
    );
    if (result.renewedAssignmentId !== undefined) {
      out.write(`  renews        ${result.renewedAssignmentId}  (ended now)\n`);
    }
    if (result.identityId !== undefined) {
      out.write(`  identity      ${result.identityId} ${held(result.identityReused)}\n`);
    }
    return 0;
  } catch (error: unknown) {
    err.write(`${message(error)}\n`);
    return 1;
  } finally {
    await owner.end();
  }
}

export async function runRetireOrganizationCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  out: Out = process.stdout,
  err: Out = process.stderr,
): Promise<number> {
  const url = ownerUrl(env, err);
  if (url === undefined) return 1;
  let request;
  try {
    request = parseRetireOrganizationArgs(argv);
  } catch (error: unknown) {
    err.write(`${message(error)}\n\n${retireOrganizationUsage()}\n`);
    return 2;
  }
  const plan = planRetireOrganization(request);
  if (!plan.ok) {
    err.write('refusing to retire:\n');
    for (const refusal of plan.refusals) err.write(`  - ${refusal}\n`);
    return 2;
  }
  const owner = createPool({ connectionString: url, maxConnections: 2 });
  try {
    const result = await runRetireOrganization(owner, plan.decision);
    out.write('organization retired, and recorded:\n');
    out.write(`  organization  ${result.organizationId}\n`);
    out.write(`  action        ${result.actionId}  (retire_organization)\n`);
    out.write(`  audit digest  ${result.auditDigest}\n`);
    if (result.peopleDeactivated.length === 0) {
      out.write('  people        none were active\n');
    } else {
      out.write(
        `  people        ${result.peopleDeactivated.length} made inactive under this act:\n`,
      );
      for (const person of result.peopleDeactivated) {
        out.write(`                ${person.id}  ${person.name}\n`);
      }
    }
    return 0;
  } catch (error: unknown) {
    // ActionRejected carries a code and detail; the message is what the operator reads.
    err.write(`${message(error)}\n`);
    return 1;
  } finally {
    await owner.end();
  }
}

export async function runRevokeIdentityCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  out: Out = process.stdout,
  err: Out = process.stderr,
): Promise<number> {
  const url = ownerUrl(env, err);
  if (url === undefined) return 1;
  let request;
  try {
    request = parseRevokeIdentityArgs(argv);
  } catch (error: unknown) {
    err.write(`${message(error)}\n\n${revokeIdentityUsage()}\n`);
    return 2;
  }
  const plan = planRevokeIdentity(request);
  if (!plan.ok) {
    err.write('refusing to revoke:\n');
    for (const refusal of plan.refusals) err.write(`  - ${refusal}\n`);
    err.write(`\n${revokeIdentityUsage()}\n`);
    return 2;
  }
  const owner = createPool({ connectionString: url, maxConnections: 2 });
  try {
    const result = await runRevokeIdentity(owner, plan.decision);
    out.write('identity revoked, and recorded:\n');
    out.write(`  action        ${result.actionId}  (revoke_external_identity)\n`);
    out.write(`  audit digest  ${result.auditDigest}\n`);
    out.write(`  identity      ${result.identityId}  ${result.issuer} / ${result.subject}\n`);
    out.write(`  person        ${result.personId}\n`);
    out.write(`  revoked at    ${result.revokedAt.toISOString()}\n`);
    out.write(
      result.actingRoleId === undefined
        ? '  acting role   none held in that organization; recorded under the bootstrap role\n'
        : `  acting role   ${result.actingRoleId}\n`,
    );
    out.write(`  attestations  ${result.attestationsWithdrawn} withdrawn\n`);
    return 0;
  } catch (error: unknown) {
    err.write(`${message(error)}\n`);
    return 1;
  } finally {
    await owner.end();
  }
}

export async function runDeclareAgentCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  out: Out = process.stdout,
  err: Out = process.stderr,
): Promise<number> {
  const url = ownerUrl(env, err);
  if (url === undefined) return 1;
  let request;
  try {
    request = parseDeclareAgentArgs(argv);
  } catch (error: unknown) {
    err.write(`${message(error)}\n\n${declareAgentUsage()}\n`);
    return 2;
  }
  const plan = planDeclareAgent(request);
  if (!plan.ok) {
    err.write(`refusing to ${request.withdraw === true ? 'withdraw' : 'declare'} an agent:\n`);
    for (const refusal of plan.refusals) err.write(`  - ${refusal}\n`);
    err.write(`\n${declareAgentUsage()}\n`);
    return 2;
  }
  const owner = createPool({ connectionString: url, maxConnections: 2 });
  try {
    const result = await runDeclareAgent(owner, plan.decision);
    if (result.withdrawnAt !== undefined) {
      out.write(`agent ${result.clientId} withdrawn at ${result.withdrawnAt.toISOString()}\n`);
      out.write(
        '  its next token is refused undeclared_agent; one attested already lives out its minute\n',
      );
    } else if (result.unchanged) {
      out.write(
        `agent ${result.clientId} was already declared at ${result.declaredAt.toISOString()}; ` +
          'nothing was written\n',
      );
    } else {
      out.write(`agent ${result.clientId} declared at ${result.declaredAt.toISOString()}\n`);
      out.write(
        '  the realm must stamp act.client_id on its tokens (identity_provider_policy checks it)\n',
      );
    }
    return 0;
  } catch (error: unknown) {
    err.write(`${message(error)}\n`);
    return 1;
  } finally {
    await owner.end();
  }
}

/**
 * `kf:declare-service-actor` (ADR 0020): the result as JSON on `out`, refusals one per line on
 * `err`, and an exit code — 2 for a usage or plan refusal, 1 for a failure — like the other
 * owner-tier commands.
 */
export async function runDeclareServiceActorCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  out: Out = process.stdout,
  err: Out = process.stderr,
): Promise<number> {
  const url = ownerUrl(env, err);
  if (url === undefined) return 1;
  let request;
  try {
    request = parseDeclareServiceActorArgs(argv);
  } catch (error: unknown) {
    err.write(`${message(error)}\n`);
    return 2;
  }
  const plan = planDeclareServiceActor(request);
  if (!plan.ok || plan.declaration === undefined) {
    err.write('refusing to declare a service actor:\n');
    for (const refusal of plan.refusals) err.write(`  - ${refusal}\n`);
    return 2;
  }
  const declaration = plan.declaration;
  const owner = createPool({ connectionString: url, maxConnections: 1 });
  try {
    const result = await runDeclareServiceActor(owner, declaration);
    out.write(
      `${JSON.stringify(
        {
          service_actor: declaration.name,
          person_id: result.personId,
          role_assignment_id: result.roleAssignmentId,
          role_assignment_valid_to: result.roleAssignmentValidTo?.toISOString() ?? null,
          clearance_id: result.clearanceId,
          action_id: result.actionId,
          reused: result.reused,
          next:
            'set KF_STORAGE_ACTOR=<person_id> KF_STORAGE_ROLE=<role_assignment_id> for kf-storage; ' +
            'renew before role_assignment_valid_to with kf:grant-authority --renew (ADR 0036)',
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  } catch (error: unknown) {
    err.write(`${message(error)}\n`);
    return 1;
  } finally {
    await owner.end();
  }
}

/** `kf define-role` (ADR 0040): a role name in the vocabulary; it grants nothing by itself. */
export async function runDefineRoleCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  out: Out = process.stdout,
  err: Out = process.stderr,
): Promise<number> {
  const url = ownerUrl(env, err);
  if (url === undefined) return 1;
  let request;
  try {
    request = parseDefineRoleArgs(argv);
  } catch (error: unknown) {
    err.write(`${message(error)}\n\n${defineRoleUsage()}\n`);
    return 2;
  }
  const plan = planDefineRole(request);
  if (!plan.ok) {
    err.write('refusing to define a role:\n');
    for (const refusal of plan.refusals) err.write(`  - ${refusal}\n`);
    err.write(`\n${defineRoleUsage()}\n`);
    return 2;
  }
  const owner = createPool({ connectionString: url, maxConnections: 1 });
  try {
    const result = await runDefineRole(owner, plan.decision);
    out.write(
      result.created
        ? `role ${result.id} defined; it grants nothing until an organization gives it a preset\n`
        : `role ${result.id} already defined; nothing to change\n`,
    );
    return 0;
  } catch (error: unknown) {
    err.write(`${message(error)}\n`);
    return 1;
  } finally {
    await owner.end();
  }
}

/**
 * `kf invite` (ADR 0040 decision 12): the person, their account, their authority, their
 * qualification record and an invitation link, all the owner's acts (KF-SAS-RQ-236). With
 * `--keycloak` the account is created at the identity provider with the admin credential from
 * `KEYCLOAK_ADMIN_PASSWORD_FILE` (inline only in development and test), `KEYCLOAK_ADMIN_USERNAME`,
 * `KEYCLOAK_BASE_URL` and `KEYCLOAK_REALM`.
 */
export async function runInviteCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  out: Out = process.stdout,
  err: Out = process.stderr,
): Promise<number> {
  const url = ownerUrl(env, err);
  if (url === undefined) return 1;
  let request;
  try {
    request = parseInviteArgs(argv);
  } catch (error: unknown) {
    err.write(`${message(error)}\n\n${inviteUsage()}\n`);
    return 2;
  }
  const planned = planInvite(request);
  if (!planned.ok) {
    err.write('refusing to invite:\n');
    for (const refusal of planned.refusals) err.write(`  - ${refusal}\n`);
    err.write(`\n${inviteUsage()}\n`);
    return 2;
  }
  let keycloak: KeycloakAdmin | undefined;
  if (planned.plan.keycloak) {
    try {
      keycloak = {
        baseUrl: env['KEYCLOAK_BASE_URL'] ?? '',
        realm: env['KEYCLOAK_REALM'] ?? 'knowledge-fabric',
        username: env['KEYCLOAK_ADMIN_USERNAME'] ?? '',
        password: loadSecret('KEYCLOAK_ADMIN_PASSWORD', env, {
          allowInline: env['NODE_ENV'] === 'development' || env['NODE_ENV'] === 'test',
        }),
      };
      if (keycloak.baseUrl === '' || keycloak.username === '') {
        throw new Error(
          'KEYCLOAK_BASE_URL and KEYCLOAK_ADMIN_USERNAME are required with --keycloak',
        );
      }
    } catch (error: unknown) {
      err.write(`${message(error)}\n`);
      return 1;
    }
  }
  const owner = createPool({ connectionString: url, maxConnections: 2 });
  try {
    const result = await runInvite(owner, planned.plan, keycloak);
    out.write('invited, and recorded:\n');
    out.write(`  person        ${result.personId}\n`);
    out.write(`  account       ${result.subject}\n`);
    out.write(`  assignment    ${result.roleAssignmentId}  ${planned.plan.roleId}\n`);
    if (result.recordId !== undefined) out.write(`  qualification ${result.recordId}\n`);
    out.write(
      `  invitation    ${result.invitationId}  (expires ${result.expiresAt.toISOString()})\n`,
    );
    if (result.keycloak !== undefined) {
      out.write(
        result.keycloak.actionsEmailSent
          ? '  email         sent by the identity provider (set a password, verify the address)\n'
          : '  email         NOT sent: the identity provider has no mail server; send the link\n',
      );
    }
    // The link, once. The database holds only its digest; it carries no authority by itself.
    out.write(`\nThe link, for ${planned.plan.email} only:\n  ${result.link}\n`);
    return 0;
  } catch (error: unknown) {
    err.write(`${message(error)}\n`);
    return 1;
  } finally {
    await owner.end();
  }
}
