/**
 * Roles as composable presets of scope (ADR 0040 decision 4; KF-SAS-RQ-269, RQ-270).
 *
 * A role's preset is what holding it in an organization grants: templates of capability, scope
 * object and ceiling (`org.role_preset_grant`). A role may include other roles
 * (`org.role_inclusion`), and the database keeps that graph acyclic. Nothing here grants anything
 * by itself: every template reaches a person only as a row of `org.effective_access_grant` (source
 * `role_preset`), the one view every read and the dispatcher's act check consult — so a preset is
 * a less manual way to grant scope, not a second access mechanism (ADR 0016).
 *
 * The four acts are institutional (`requires: act`) and each must target the organization itself:
 * a preset applies to every holder of the role across the organization, so a person whose act
 * grant reaches one project cannot define what a role grants everywhere. Retirement is a state on
 * the row, never a delete.
 */

import { ActionRejected, type ActionEffect, type ObjectRow } from '@kf/actions';
import type { Tx } from '@kf/database';

export const ROLE_PRESET_ACTION_IDS = [
  'grant_role_scope',
  'revoke_role_scope',
  'include_role',
  'exclude_role',
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLASSIFICATIONS = new Set(['public', 'internal', 'confidential', 'restricted']);

function payloadString(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = payload?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function required(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
  act: string,
  what: string,
): string {
  const value = payloadString(payload, key);
  if (value === undefined) {
    throw new ActionRejected('precondition_failed', `${act} needs ${key} in its payload: ${what}`, {
      field: key,
    });
  }
  return value;
}

function reasonOf(reason: string | undefined, act: string): string {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new ActionRejected(
      'precondition_failed',
      `${act} needs a reason: a preset changes what every holder of the role may read`,
    );
  }
  return reason.trim();
}

/** The organization among the targets; a preset act that does not name it is refused. */
function organizationTarget(
  objects: readonly ObjectRow[],
  targetIds: readonly string[],
  act: string,
) {
  const organization = objects.find(
    (object) =>
      targetIds.includes(object.id) &&
      object.object_type === 'organization' &&
      object.id === object.organization_id,
  );
  if (organization === undefined) {
    throw new ActionRejected(
      'precondition_failed',
      `${act} must target the organization: a role's preset applies to every holder of the role ` +
        'in it, so it needs act authority over the whole organization',
    );
  }
  return organization;
}

/** A database refusal the caller can act on, as `precondition_failed` with its message. */
function refusalOf(error: unknown, context: Readonly<Record<string, unknown>>): never {
  const code = (error as { code?: string }).code;
  if (code === '23505') {
    throw new ActionRejected(
      'precondition_failed',
      'that is already part of the preset; retire the live one first',
      context,
    );
  }
  if (code === '23514' || code === '23503' || code === '55000') {
    throw new ActionRejected('precondition_failed', (error as Error).message, context);
  }
  throw error;
}

/**
 * `grant_role_scope`: add one template to a role's preset. Targets the organization and, for an
 * object-scoped template, that object; a template whose only target is the organization is
 * organization-wide (as an organization-scoped grant is, ADR 0016).
 */
export const grantRoleScopeEffect: ActionEffect = async (tx, request, objects, ctx) => {
  const act = 'grant_role_scope';
  const organization = organizationTarget(objects, request.targetIds, act);
  const others = objects.filter(
    (object) => request.targetIds.includes(object.id) && object.id !== organization.id,
  );
  if (others.length > 1) {
    throw new ActionRejected(
      'precondition_failed',
      'grant_role_scope adds one template: target the organization and at most one scope object',
    );
  }
  const scope = others[0] ?? organization;
  const roleId = required(request.payload, 'role_id', act, 'which role the preset belongs to');
  const capability = required(request.payload, 'capability', act, 'read or act');
  if (capability !== 'read' && capability !== 'act') {
    throw new ActionRejected('precondition_failed', 'capability must be read or act');
  }
  const ceiling = payloadString(request.payload, 'classification_ceiling');
  if (ceiling !== undefined && !CLASSIFICATIONS.has(ceiling)) {
    throw new ActionRejected('precondition_failed', `unknown classification ${ceiling}`);
  }
  const reason = reasonOf(request.reason, act);
  try {
    await tx.query(
      `insert into org.role_preset_grant
         (organization_id, role_id, capability, scope_object_id, classification_ceiling, reason,
          defined_by, defined_by_action)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        organization.id,
        roleId,
        capability,
        scope.id,
        ceiling ?? null,
        reason,
        request.actorId,
        ctx.actionId,
      ],
    );
  } catch (error: unknown) {
    refusalOf(error, { roleId, capability, scopeObjectId: scope.id });
  }
};

/** `revoke_role_scope`: retire one template. The row stays; it said what the role granted. */
export const revokeRoleScopeEffect: ActionEffect = async (tx, request, objects, ctx) => {
  const act = 'revoke_role_scope';
  const organization = organizationTarget(objects, request.targetIds, act);
  const id = required(request.payload, 'preset_grant_id', act, 'which template to retire');
  if (!UUID.test(id)) throw new ActionRejected('precondition_failed', 'preset_grant_id is a uuid');
  const reason = reasonOf(request.reason, act);
  const retired = await tx.query<{ id: string }>(
    `update org.role_preset_grant
        set retired_at = now(), retired_by = $3, retired_by_action = $4, retirement_reason = $5
      where id = $1 and organization_id = $2 and retired_at is null
      returning id`,
    [id, organization.id, request.actorId, ctx.actionId, reason],
  );
  if (retired.length === 0) {
    throw new ActionRejected(
      'precondition_failed',
      'no live preset template with that id exists in this organization; it may already be retired',
      { presetGrantId: id },
    );
  }
};

/** `include_role`: whoever holds `role_id` also receives `included_role_id`'s preset. */
export const includeRoleEffect: ActionEffect = async (tx, request, objects, ctx) => {
  const act = 'include_role';
  const organization = organizationTarget(objects, request.targetIds, act);
  const roleId = required(request.payload, 'role_id', act, 'the including role');
  const includedRoleId = required(request.payload, 'included_role_id', act, 'the included role');
  const reason = reasonOf(request.reason, act);
  try {
    await tx.query(
      `insert into org.role_inclusion
         (organization_id, role_id, included_role_id, reason, defined_by, defined_by_action)
       values ($1, $2, $3, $4, $5, $6)`,
      [organization.id, roleId, includedRoleId, reason, request.actorId, ctx.actionId],
    );
  } catch (error: unknown) {
    refusalOf(error, { roleId, includedRoleId });
  }
};

/** `exclude_role`: retire one inclusion. */
export const excludeRoleEffect: ActionEffect = async (tx, request, objects, ctx) => {
  const act = 'exclude_role';
  const organization = organizationTarget(objects, request.targetIds, act);
  const id = required(request.payload, 'inclusion_id', act, 'which inclusion to retire');
  if (!UUID.test(id)) throw new ActionRejected('precondition_failed', 'inclusion_id is a uuid');
  const reason = reasonOf(request.reason, act);
  const retired = await tx.query<{ id: string }>(
    `update org.role_inclusion
        set retired_at = now(), retired_by = $3, retired_by_action = $4, retirement_reason = $5
      where id = $1 and organization_id = $2 and retired_at is null
      returning id`,
    [id, organization.id, request.actorId, ctx.actionId, reason],
  );
  if (retired.length === 0) {
    throw new ActionRejected(
      'precondition_failed',
      'no live role inclusion with that id exists in this organization; it may already be retired',
      { inclusionId: id },
    );
  }
};

export const ROLE_PRESET_EFFECTS: Readonly<Record<string, ActionEffect>> = {
  grant_role_scope: grantRoleScopeEffect,
  revoke_role_scope: revokeRoleScopeEffect,
  include_role: includeRoleEffect,
  exclude_role: excludeRoleEffect,
};

// ── Reading the presets ──────────────────────────────────────────────────────────────────────

export interface RolePresetTemplate {
  readonly id: string;
  readonly capability: 'read' | 'act';
  readonly scopeObjectId: string;
  /** True when the scope is the organization itself: every object in it. */
  readonly organizationWide: boolean;
  readonly classificationCeiling: string | null;
  readonly reason: string;
  readonly definedAt: string;
}

export interface RolePreset {
  readonly roleId: string;
  readonly description: string;
  readonly templates: readonly RolePresetTemplate[];
  readonly includes: readonly { readonly inclusionId: string; readonly roleId: string }[];
}

/**
 * The organization's live presets, read under the caller's row security: a template whose scope
 * object the caller cannot see is not listed, as an access grant on it would not be. Only roles
 * that carry a template or take part in an inclusion are listed; the rest grant nothing beyond
 * their assignment and have no preset to show.
 */
export async function listRolePresets(tx: Tx, organizationId: string): Promise<RolePreset[]> {
  const templates = await tx.query<{
    id: string;
    role_id: string;
    capability: 'read' | 'act';
    scope_object_id: string;
    classification_ceiling: string | null;
    reason: string;
    defined_at: Date;
  }>(
    `select /* role-presets.templates */ id, role_id, capability, scope_object_id,
            classification_ceiling, reason, defined_at
       from org.role_preset_grant
      where organization_id = $1 and retired_at is null
      order by role_id, capability, scope_object_id`,
    [organizationId],
  );
  const inclusions = await tx.query<{ id: string; role_id: string; included_role_id: string }>(
    `select /* role-presets.inclusions */ id, role_id, included_role_id
       from org.role_inclusion
      where organization_id = $1 and retired_at is null
      order by role_id, included_role_id`,
    [organizationId],
  );
  const roleIds = new Set<string>([
    ...templates.map((t) => t.role_id),
    ...inclusions.flatMap((i) => [i.role_id, i.included_role_id]),
  ]);
  if (roleIds.size === 0) return [];
  const roles = await tx.query<{ id: string; description: string }>(
    'select id, description from org.role where id = any($1::text[]) order by id',
    [[...roleIds]],
  );
  return roles.map((role) => ({
    roleId: role.id,
    description: role.description,
    templates: templates
      .filter((t) => t.role_id === role.id)
      .map((t) => ({
        id: t.id,
        capability: t.capability,
        scopeObjectId: t.scope_object_id,
        organizationWide: t.scope_object_id === organizationId,
        classificationCeiling: t.classification_ceiling,
        reason: t.reason,
        definedAt: new Date(t.defined_at).toISOString(),
      })),
    includes: inclusions
      .filter((i) => i.role_id === role.id)
      .map((i) => ({ inclusionId: i.id, roleId: i.included_role_id })),
  }));
}
