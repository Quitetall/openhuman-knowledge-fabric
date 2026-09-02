/**
 * Enterprise identifier allocation — R01 rule R6, as a typed action (ADR 0018).
 *
 * One action, `allocate_enterprise_identifier`, targets exactly one object and asks the
 * database to allocate the next free identifier under the namespace the object's TYPE
 * declares. Nothing in the request names the identifier: a caller cannot choose, suggest or
 * fabricate one — the refusal that the OpenWarrant SAS (§12.4) requires is that there is no
 * field to put it in. The identifier comes back in the action RECEIPT, read from the
 * allocation ledger by the action that made it, so a replayed request returns the same
 * receipt as the first.
 */

import { ActionRejected, type ActionEffect, type ActionReceiptReader } from '@kf/actions';
import type { Tx } from '@kf/database';

export const IDENTIFIER_ACTION_IDS = ['allocate_enterprise_identifier'] as const;

export interface IdentifierAllocationRow extends Record<string, unknown> {
  readonly enterprise_id: string;
  readonly object_id: string;
  readonly qualified_code: string;
  readonly sequence: string | number;
  readonly allocated_at: Date;
  readonly allocated_by: string;
  readonly allocated_by_action: string;
}

/** Read one allocation by identifier, under the caller's row-level security. */
export async function allocationOf(
  tx: Tx,
  enterpriseId: string,
): Promise<IdentifierAllocationRow | undefined> {
  return tx.maybeOne<IdentifierAllocationRow>(
    `select enterprise_id, object_id, qualified_code, sequence, allocated_at, allocated_by,
            allocated_by_action
       from registry.identifier_allocation where enterprise_id = $1`,
    [enterpriseId],
  );
}

/**
 * The effect. The target must be exactly one object; the payload is refused if it names an
 * identifier, because that is the one thing this action exists never to accept.
 */
export const allocateEnterpriseIdentifierEffect: ActionEffect = async (
  tx,
  request,
  objects,
  ctx,
) => {
  if (request.targetIds.length !== 1 || objects.length !== 1) {
    throw new ActionRejected(
      'precondition_failed',
      'allocate_enterprise_identifier targets exactly one object',
      { targetIds: request.targetIds },
    );
  }
  const offered = request.payload?.['enterprise_id'];
  if (offered !== undefined) {
    throw new ActionRejected(
      'precondition_failed',
      'allocate_enterprise_identifier does not accept an enterprise_id: the registry allocates, ' +
        'the caller never proposes (OH-DOC-000001-3 R01 R6; OpenWarrant SAS §12.4)',
      { offered: String(offered) },
    );
  }
  const target = objects[0]!;
  try {
    await tx.one<{ allocated: string }>(
      'select core.allocate_enterprise_id($1, $2, $3) as allocated',
      [target.id, request.actorId, ctx.actionId],
    );
  } catch (error: unknown) {
    const code = (error as { code?: string }).code;
    const message = (error as Error).message;
    // 23505 unique_violation: already allocated (R8). 23514 check_violation: a namespace fact
    // (undeclared, unallocated here, not active). 2200H / P0002 no_data_found: the object is not
    // visible — SQL and PL/pgSQL spell the same condition differently. All are facts about the
    // record, not failures of the service; anything else propagates.
    if (code === '23505' || code === '23514' || code === '2200H' || code === 'P0002') {
      throw new ActionRejected('precondition_failed', message, { objectId: target.id });
    }
    throw error;
  }
};

/** The receipt: what this act allocated, read back from the ledger it wrote. */
export const allocateEnterpriseIdentifierReceipt: ActionReceiptReader = async (tx, actionId) => {
  const row = await tx.maybeOne<IdentifierAllocationRow>(
    `select enterprise_id, object_id, qualified_code, sequence, allocated_at
       from registry.identifier_allocation where allocated_by_action = $1`,
    [actionId],
  );
  if (row === undefined) {
    throw new Error(`allocation receipt for action ${actionId} is missing from the ledger`);
  }
  return {
    enterprise_id: row.enterprise_id,
    object_id: row.object_id,
    namespace: row.qualified_code,
    sequence: Number(row.sequence),
    allocated_at: row.allocated_at.toISOString(),
  };
};

export const IDENTIFIER_EFFECTS: Readonly<Record<string, ActionEffect>> = {
  allocate_enterprise_identifier: allocateEnterpriseIdentifierEffect,
};

export const IDENTIFIER_RECEIPTS: Readonly<Record<string, ActionReceiptReader>> = {
  allocate_enterprise_identifier: allocateEnterpriseIdentifierReceipt,
};

export const PACKAGE = {
  name: '@kf/identifiers',
  role: 'Enterprise identifier allocation (R01 R6)',
  owns: [],
} as const;
