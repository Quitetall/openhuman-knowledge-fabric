/**
 * The bootstrap-tier commands as `kf` subcommands.
 *
 * Each needs DATABASE_OWNER_URL and is refused without it. Each prints refusals as refusals —
 * one line per reason, no stack trace — because a refusal is a feature and a stack trace says
 * where the throw was written, not what to do.
 */

import { createPool } from '@kf/database';

import {
  bootstrapUsage,
  parseBootstrapArgs,
  planBootstrap,
  runBootstrap,
} from './bootstrap-organization.js';
import {
  parseGrantAuthorityArgs,
  planGrantAuthority,
  runGrantAuthority,
} from './grant-authority.js';
import {
  parseRetireOrganizationArgs,
  planRetireOrganization,
  retireOrganizationUsage,
  runRetireOrganization,
} from './retire-organization.js';

type Out = NodeJS.WritableStream;

function ownerUrl(env: NodeJS.ProcessEnv, err: Out): string | undefined {
  const url = env['DATABASE_OWNER_URL'];
  if (url === undefined || url.trim() === '') {
    err.write('DATABASE_OWNER_URL is required: this writes authority and needs the owner role\n');
    return undefined;
  }
  return url;
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
