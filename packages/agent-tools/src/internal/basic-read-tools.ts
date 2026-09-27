import { OBJECT_HISTORY_SQL, type ObjectHistoryRow } from '@kf/actions';
import { readGrantedSubset } from '@kf/authorization';
import type { Pool } from '@kf/database';
import { recordVerification } from '@kf/domain';
import { searchIn, type SearchHit } from '@kf/search';
import { scoped, scopedToGranted } from './scope.js';
import type { AgentScope, AvailableAction, HistoryEntry, ObjectSummary } from './types.js';

export async function findRecords(
  pool: Pool,
  scope: AgentScope,
  query: { text: string; objectTypes?: readonly string[]; limit?: number },
): Promise<readonly SearchHit[]> {
  return scoped(pool, scope, async (tx) => {
    const hits = await searchIn(
      tx,
      { organizationId: scope.organizationId, maxClassification: scope.maxClassification },
      query,
    );
    // A hit is a title and a place a record appears; only a granted record may appear.
    const granted = new Set(
      (
        await readGrantedSubset(
          tx,
          scope,
          hits.map((hit) => ({ id: hit.objectId })),
        )
      ).map((item) => item.id),
    );
    return hits.filter((hit) => granted.has(hit.objectId));
  });
}

export async function readRecord(
  pool: Pool,
  scope: AgentScope,
  objectId: string,
): Promise<ObjectSummary | undefined> {
  return scopedToGranted(pool, scope, objectId, undefined, async (tx) => {
    const row = await tx.maybeOne<{
      id: string;
      enterprise_id: string | null;
      object_type: string;
      title: string;
      lifecycle_state: string;
      classification: string;
      row_version: string;
      created_at: Date;
      verified_at: Date | null;
      verified_by: string | null;
      verification_basis: string | null;
    }>(
      // Left join: absence IS the unverified state. Under the caller's row security the
      // verification row is visible exactly when the record is (`object_verification_read`).
      `select o.id, o.enterprise_id, o.object_type, o.title, o.lifecycle_state, o.classification,
              o.row_version, o.created_at,
              v.verified_at, v.verified_by, v.basis as verification_basis
         from core.object o
         left join core.object_verification v on v.object_id = o.id
        where o.id = $1`,
      [objectId],
    );
    if (row === undefined) return undefined;
    return {
      id: row.id,
      enterpriseId: row.enterprise_id,
      objectType: row.object_type,
      title: row.title,
      lifecycleState: row.lifecycle_state,
      classification: row.classification,
      rowVersion: row.row_version,
      createdAt: row.created_at.toISOString(),
      verification: verificationOfRow(row),
    };
  });
}

export async function readHistory(
  pool: Pool,
  scope: AgentScope,
  objectId: string,
): Promise<readonly HistoryEntry[]> {
  // The gate is false for an object the session cannot see: it is the visibility check too.
  return scopedToGranted(pool, scope, objectId, [], async (tx) => {
    const rows = await tx.query<ObjectHistoryRow>(OBJECT_HISTORY_SQL, [objectId]);
    return rows.map((r) => ({
      seq: r.seq,
      actionType: r.action_type,
      actorId: r.actor_id,
      recordedAt: r.recorded_at.toISOString(),
      reason: r.reason,
    }));
  });
}

export async function availableActions(
  pool: Pool,
  scope: AgentScope,
  objectId: string,
): Promise<readonly AvailableAction[]> {
  return scopedToGranted(pool, scope, objectId, [], async (tx) => {
    const object = await tx.maybeOne<{ object_type: string; lifecycle_state: string }>(
      'select object_type, lifecycle_state from core.object where id = $1',
      [objectId],
    );
    if (object === undefined) return [];
    const rows = await tx.query<{ action_id: string; to_state: string }>(
      `select action_id, to_state from registry.state_transition
        where object_type = $1 and from_state = $2 order by action_id, to_state`,
      [object.object_type, object.lifecycle_state],
    );
    const byAction = new Map<string, string[]>();
    for (const r of rows) {
      byAction.set(r.action_id, [...(byAction.get(r.action_id) ?? []), r.to_state]);
    }
    return [...byAction.entries()].map(([actionType, toStates]) => ({
      actionType,
      toStates,
      requiresChoice: toStates.length > 1,
    }));
  });
}

/** A verification row's columns as the reads select them; any fact missing reads as unverified. */
export function verificationOfRow(row: {
  readonly verified_at: Date | null;
  readonly verified_by: string | null;
  readonly verification_basis: string | null;
}) {
  const { verified_at: at, verified_by: by, verification_basis: basis } = row;
  return recordVerification(
    at === null || by === null || basis === null
      ? undefined
      : { basis, verifiedAt: at, verifiedBy: by },
  );
}
