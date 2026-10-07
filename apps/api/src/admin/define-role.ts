/**
 * Add a role to the installation's vocabulary, over the owner credential (ADR 0040).
 *
 * A role is a name an assignment can carry. What a role GRANTS is not decided here: in each
 * organization that is the role's preset (`org.role_preset_grant`, `org.role_inclusion`), changed
 * only by the institutional acts `grant_role_scope`, `revoke_role_scope`, `include_role` and
 * `exclude_role`, attributed and audited. This command only makes the name exist, as the migrations
 * that seeded the first twelve did, so that an organization can give it a preset and the owner can
 * assign it (`kf grant-authority --role <id>`).
 *
 * WHY THE OWNER, AND NOT AN ACT. `org.role` is the installation's vocabulary, shared by every
 * organization in it and readable by every login; the application login may read it and nothing
 * more. Minting a role is minting a kind of authority — every `org.holds_role` check, every
 * separation-of-duty rule and every assignment refers to these names — and authority is minted on
 * the owner credential or not at all. A name carries no scope until an organization's own act
 * gives it one, so a role defined here grants nobody anything.
 *
 * Idempotent: the same id with the same description changes nothing; a different description for
 * an existing id is refused rather than rewritten, because assignments already carry the name.
 */

import { withTransaction, type Pool } from '@kf/database';

export interface DefineRoleRequest {
  readonly id?: string;
  readonly description?: string;
}

export interface DefineRoleDecision {
  readonly id: string;
  readonly description: string;
}

export type DefineRolePlan =
  | { readonly ok: true; readonly decision: DefineRoleDecision }
  | { readonly ok: false; readonly refusals: readonly string[] };

const ROLE_ID = /^[a-z][a-z0-9_]{1,62}$/;

export function defineRoleUsage(): string {
  return [
    'kf define-role --id <role id> --description <text>',
    '  Adds a role name to the vocabulary (owner credential). It grants nothing until an',
    '  organization gives it a preset with grant_role_scope / include_role.',
  ].join('\n');
}

export function parseDefineRoleArgs(argv: readonly string[]): DefineRoleRequest {
  const out: { id?: string; description?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--id' && value !== undefined) out.id = value;
    else if (flag === '--description' && value !== undefined) out.description = value;
    else throw new Error(`unknown or incomplete argument ${String(flag)}`);
    i += 1;
  }
  return out;
}

/** Validate without touching a database; every refusal at once. */
export function planDefineRole(request: DefineRoleRequest): DefineRolePlan {
  const refusals: string[] = [];
  const id = request.id?.trim() ?? '';
  const description = request.description?.trim() ?? '';
  if (!ROLE_ID.test(id)) {
    refusals.push(
      `--id must be a lower-case identifier (a-z, 0-9, _; 2 to 63 characters), got ${JSON.stringify(id)}`,
    );
  }
  if (description.length < 8) {
    refusals.push('--description must say what the role is for (eight characters or more)');
  }
  return refusals.length > 0
    ? { ok: false, refusals }
    : { ok: true, decision: { id, description } };
}

export interface DefineRoleResult {
  readonly id: string;
  readonly created: boolean;
}

export async function runDefineRole(
  owner: Pool,
  decision: DefineRoleDecision,
): Promise<DefineRoleResult> {
  return withTransaction(owner, async (tx) => {
    const existing = await tx.maybeOne<{ description: string }>(
      'select description from org.role where id = $1',
      [decision.id],
    );
    if (existing !== undefined) {
      if (existing.description !== decision.description) {
        throw new Error(
          `role ${decision.id} already exists with another description; a role name is not ` +
            'redefined, because assignments already carry it',
        );
      }
      return { id: decision.id, created: false };
    }
    await tx.query('insert into org.role (id, description) values ($1, $2)', [
      decision.id,
      decision.description,
    ]);
    return { id: decision.id, created: true };
  });
}
