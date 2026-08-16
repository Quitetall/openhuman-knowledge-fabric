import type { Pool } from '@kf/database';
import { searchIn, type SearchHit } from '@kf/search';
import { scoped } from './scope.js';
import type { AgentScope, AvailableAction, HistoryEntry, ObjectSummary } from './types.js';

export async function findRecords(
  pool: Pool,
  scope: AgentScope,
  query: { text: string; objectTypes?: readonly string[]; limit?: number },
): Promise<readonly SearchHit[]> {
  return scoped(pool, scope, async (tx) =>
    searchIn(
      tx,
      { organizationId: scope.organizationId, maxClassification: scope.maxClassification },
      query,
    ),
  );
}

export async function readRecord(
  pool: Pool,
  scope: AgentScope,
  objectId: string,
): Promise<ObjectSummary | undefined> {
  return scoped(pool, scope, async (tx) => {
    const row = await tx.maybeOne<{
      id: string;
      enterprise_id: string | null;
      object_type: string;
      title: string;
      lifecycle_state: string;
      classification: string;
      row_version: string;
      created_at: Date;
    }>(
      `select id, enterprise_id, object_type, title, lifecycle_state, classification,
              row_version, created_at
         from core.object where id = $1`,
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
    };
  });
}

export async function readHistory(
  pool: Pool,
  scope: AgentScope,
  objectId: string,
): Promise<readonly HistoryEntry[]> {
  return scoped(pool, scope, async (tx) => {
    const visible = await tx.maybeOne<{ id: string }>('select id from core.object where id = $1', [
      objectId,
    ]);
    if (visible === undefined) return [];
    const rows = await tx.query<{
      seq: string;
      action_type: string;
      actor_id: string;
      recorded_at: Date;
      reason: string | null;
    }>(
      `select e.seq, e.action_type, e.actor_id, e.recorded_at, e.reason
         from core.audit_event e
        where e.object_id = $1
           or $1 = any(select unnest(a.target_ids) from core.action a where a.id = e.action_id)
        order by e.seq`,
      [objectId],
    );
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
  return scoped(pool, scope, async (tx) => {
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
