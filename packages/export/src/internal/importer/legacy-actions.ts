import { createHash } from 'node:crypto';
import type { Tx } from '@kf/database';
import type { Row } from '../encoding.js';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function legacyActionDigest(actionId: string): string {
  return createHash('sha256').update(`kf-action-legacy-v1:${actionId}`, 'utf8').digest('hex');
}

export async function upconvertLegacyActions(tx: Tx, rows: readonly Row[]): Promise<Row[]> {
  const converted: Row[] = [];
  for (const [index, row] of rows.entries()) {
    const actionId = row['id'];
    const targetIds = row['target_ids'];
    if (
      typeof actionId !== 'string' ||
      !CANONICAL_UUID.test(actionId) ||
      !Array.isArray(targetIds) ||
      targetIds.length === 0
    ) {
      throw new Error(`refusing to import: actions.json row ${index} has invalid legacy identity`);
    }
    if (row['organization_id'] !== undefined || row['request_digest'] !== undefined) {
      throw new Error(
        `refusing to import: actions.json row ${index} mixes format-1 and semantic action columns`,
      );
    }
    if (!targetIds.every((targetId) => typeof targetId === 'string')) {
      throw new Error(`refusing to import: actions.json row ${index} has invalid target_ids`);
    }

    const uniqueTargetIds = [...new Set(targetIds as string[])];
    const targets = await tx.query<{ id: string; organization_id: string }>(
      `select id::text as id, organization_id::text as organization_id
         from core.object
        where id = any($1::uuid[])
        order by id`,
      [uniqueTargetIds],
    );
    const organizations = new Set(targets.map((target) => target.organization_id));
    if (targets.length !== uniqueTargetIds.length || organizations.size !== 1) {
      throw new Error(
        `refusing to import: actions.json row ${index} targets do not resolve to one organization`,
      );
    }
    converted.push({
      ...row,
      organization_id: [...organizations][0]!,
      request_digest: legacyActionDigest(actionId),
    });
  }
  return converted;
}

export async function assertLegacyActionProvenance(tx: Tx): Promise<void> {
  const mismatch = await tx.query<{ action_id: string }>(
    `select legacy.action_id::text as action_id
       from core.action_migration019_legacy legacy
       join core.action action on action.id = legacy.action_id
      where action.request_digest <> encode(
              public.digest(convert_to('kf-action-legacy-v1:' || action.id::text, 'UTF8'), 'sha256'),
              'hex'
            )
     union all
     select action.id::text as action_id
       from core.action action
      where action.request_digest = encode(
              public.digest(convert_to('kf-action-legacy-v1:' || action.id::text, 'UTF8'), 'sha256'),
              'hex'
            )
        and not exists (
          select 1 from core.action_migration019_legacy legacy
           where legacy.action_id = action.id
        )
     limit 1`,
  );
  if (mismatch.length > 0) {
    throw new Error(
      `refusing to import: legacy action provenance mismatch for ${mismatch[0]!.action_id}`,
    );
  }
}

export async function assertActionTargetScope(tx: Tx): Promise<void> {
  const mismatch = await tx.query<{ action_id: string }>(
    `select action.id::text as action_id
       from core.action action
      where exists (
        select 1
          from unnest(action.target_ids) target(id)
          left join core.object object on object.id = target.id
         where target.id is null
            or object.id is null
            or object.organization_id is distinct from action.organization_id
      )
      limit 1`,
  );
  if (mismatch.length > 0) {
    throw new Error(
      `refusing to import: action target scope mismatch for ${mismatch[0]!.action_id}`,
    );
  }
}
