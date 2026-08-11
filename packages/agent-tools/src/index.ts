/**
 * The tools an agent may use.
 *
 * Nine of them, and the shape of the set is the safety argument. Eight read. The ninth
 * REHEARSES: it runs a real action through the real dispatcher, in a transaction that is
 * always rolled back, and reports exactly what would have happened.
 *
 * There is no tenth tool that acts. Not because an agent cannot be trusted with a work order
 * — that is a policy question and reasonable people differ — but because "the agent may act
 * under these conditions" is a decision somebody must make explicitly, in code, for a named
 * action. A general-purpose act() tool makes that decision once, invisibly, for all of them.
 *
 * Every tool takes a scope and passes it to the same row-level security the API uses. An
 * agent sees exactly what the person it is acting for sees — never more, and never a
 * convenient superset for "context".
 */

import { createDispatcher, type ActionRequest, ActionRejected } from '@kf/actions';
import { withTransaction, type Pool, type Tx } from '@kf/database';
import { searchIn, type SearchHit } from '@kf/search';

export interface AgentScope {
  readonly organizationId: string;
  readonly maxClassification: string;
  /** Who the agent is acting for. Every read is scoped as that person, never as the agent. */
  readonly actorId: string;
  readonly actingRoleId: string;
}

/** Bind the reader's scope. Every tool does this first; none of them may skip it. */
async function scoped<T>(pool: Pool, scope: AgentScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTransaction(pool, async (tx) => {
    await tx.query('select core.set_access_context($1, $2)', [
      scope.organizationId,
      scope.maxClassification,
    ]);
    return fn(tx);
  });
}

// ── 1. search ───────────────────────────────────────────────────────────────────────────

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

// ── 2. read one record ──────────────────────────────────────────────────────────────────

export interface ObjectSummary {
  readonly id: string;
  readonly enterpriseId: string | null;
  readonly objectType: string;
  readonly title: string;
  readonly lifecycleState: string;
  readonly classification: string;
  readonly rowVersion: string;
  readonly createdAt: string;
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

// ── 3. history ──────────────────────────────────────────────────────────────────────────

export interface HistoryEntry {
  readonly seq: string;
  readonly actionType: string;
  readonly actorId: string;
  readonly recordedAt: string;
  readonly reason: string | null;
}

export async function readHistory(
  pool: Pool,
  scope: AgentScope,
  objectId: string,
): Promise<readonly HistoryEntry[]> {
  return scoped(pool, scope, async (tx) => {
    // Visibility first. Without it an agent could read the history of a record it cannot
    // read, which leaks the record's existence and much of its content through action names.
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

// ── 4. what can be done next ────────────────────────────────────────────────────────────

export interface AvailableAction {
  readonly actionType: string;
  readonly toStates: readonly string[];
  readonly requiresChoice: boolean;
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

// ── 5. trace the graph ──────────────────────────────────────────────────────────────────

export interface TracedEdge {
  readonly relationType: string;
  readonly fromId: string;
  readonly toId: string;
  readonly toTitle: string;
  readonly toType: string;
  readonly depth: number;
}

/**
 * Walk typed relations outward from a record.
 *
 * Depth-bounded, and the bound is not negotiable from outside: an unbounded traversal over a
 * cyclic graph is a way to make the database do arbitrary work on request, and the graph is
 * only acyclic for the relation types that declare themselves so.
 */
export async function traceRelations(
  pool: Pool,
  scope: AgentScope,
  objectId: string,
  options: { readonly relationTypes?: readonly string[]; readonly maxDepth?: number } = {},
): Promise<readonly TracedEdge[]> {
  const depth = Math.min(Math.max(1, options.maxDepth ?? 3), 6);
  return scoped(pool, scope, async (tx) => {
    const rows = await tx.query<{
      relation_type: string;
      from_id: string;
      to_id: string;
      to_title: string;
      to_type: string;
      depth: number;
    }>(
      `with recursive walk(relation_type, from_id, to_id, depth, path) as (
         select r.relation_type, r.source_id, r.target_id, 1, array[r.source_id, r.target_id]
           from core.relation r
          where r.source_id = $1
            and ($2::text[] is null or r.relation_type = any($2))
         union all
         select r.relation_type, r.source_id, r.target_id, w.depth + 1, w.path || r.target_id
           from core.relation r
           join walk w on r.source_id = w.to_id
          where w.depth < $3
            and ($2::text[] is null or r.relation_type = any($2))
            -- A cycle would otherwise loop until the depth bound, returning the same edges
            -- repeatedly and calling it a traversal.
            and not r.target_id = any(w.path)
       )
       select w.relation_type, w.from_id, w.to_id, o.title as to_title, o.object_type as to_type,
              w.depth
         from walk w
         -- An inner join, so a target the caller cannot see is dropped rather than returned
         -- as a bare id. A bare id is still a disclosure.
         join core.object o on o.id = w.to_id
        order by w.depth, o.title`,
      [objectId, options.relationTypes === undefined ? null : [...options.relationTypes], depth],
    );
    return rows.map((r) => ({
      relationType: r.relation_type,
      fromId: r.from_id,
      toId: r.to_id,
      toTitle: r.to_title,
      toType: r.to_type,
      depth: Number(r.depth),
    }));
  });
}

// ── 6. is it verified ───────────────────────────────────────────────────────────────────

export interface VerificationSummary {
  readonly subjectId: string;
  readonly verified: boolean;
  readonly approvedDefinitions: number;
  readonly definitionsPassed: number;
  readonly failed: number;
  readonly invalidated: number;
  readonly unexecuted: number;
}

export async function verificationOf(
  pool: Pool,
  scope: AgentScope,
  subjectId: string,
): Promise<VerificationSummary | undefined> {
  return scoped(pool, scope, async (tx) => {
    const visible = await tx.maybeOne<{ id: string }>('select id from core.object where id = $1', [
      subjectId,
    ]);
    if (visible === undefined) return undefined;

    const row = await tx.maybeOne<{
      verified: boolean;
      approved_definitions: string;
      definitions_passed: string;
      failed: string;
      invalidated: string;
      unexecuted: string;
    }>('select * from engineering.verification_status where subject_id = $1', [subjectId]);

    // Absent from the view means nothing has ever been claimed about it. Reported as
    // unverified with zero evidence rather than omitted, because an absent row in a left
    // join reads as "no problems found".
    if (row === undefined) {
      return {
        subjectId,
        verified: false,
        approvedDefinitions: 0,
        definitionsPassed: 0,
        failed: 0,
        invalidated: 0,
        unexecuted: 0,
      };
    }
    return {
      subjectId,
      verified: row.verified,
      approvedDefinitions: Number(row.approved_definitions),
      definitionsPassed: Number(row.definitions_passed),
      failed: Number(row.failed),
      invalidated: Number(row.invalidated),
      unexecuted: Number(row.unexecuted),
    };
  });
}

// ── 7. what does this cite, elsewhere ───────────────────────────────────────────────────

export interface ExternalCitation {
  readonly source: string;
  readonly repository: string;
  readonly externalId: string;
  readonly commitSha: string;
  readonly path: string;
  readonly contentSha256: string;
  readonly linkKind: string;
}

export async function externalCitations(
  pool: Pool,
  scope: AgentScope,
  objectId: string,
): Promise<readonly ExternalCitation[]> {
  return scoped(pool, scope, async (tx) => {
    const rows = await tx.query<{
      source_id: string;
      repository: string;
      external_id: string;
      commit_sha: string;
      path: string;
      content_sha256: string;
      link_kind: string;
    }>(
      `select r.source_id, s.repository, r.external_id, r.commit_sha, r.path,
              r.content_sha256, l.link_kind
         from quality.federated_link l
         join quality.federated_reference r on r.id = l.reference_id
         join quality.federated_source s on s.id = r.source_id
         -- Through core.object so the caller's visibility of the CITING record decides
         -- whether they see the citation.
         join core.object o on o.id = l.object_id
        where l.object_id = $1
        order by r.source_id, r.external_id`,
      [objectId],
    );
    return rows.map((r) => ({
      source: r.source_id,
      repository: r.repository,
      externalId: r.external_id,
      commitSha: r.commit_sha,
      path: r.path,
      contentSha256: r.content_sha256,
      linkKind: r.link_kind,
    }));
  });
}

// ── 8. what is this record's evidence ───────────────────────────────────────────────────

export interface EvidenceItem {
  readonly versionId: string;
  readonly artifactId: string;
  readonly versionNo: number;
  readonly mediaType: string;
  readonly sha256: string;
  readonly sizeBytes: string;
}

/**
 * The artifact versions attached to a record.
 *
 * Digests and identity only. There is no tool here that returns artifact BYTES: an agent that
 * can stream the evidence vault is an exfiltration path with a friendly name, and nothing an
 * agent legitimately does with a record requires the file itself.
 */
export async function evidenceFor(
  pool: Pool,
  scope: AgentScope,
  objectId: string,
): Promise<readonly EvidenceItem[]> {
  return scoped(pool, scope, async (tx) => {
    const rows = await tx.query<{
      id: string;
      artifact_id: string;
      version_no: number;
      media_type: string;
      sha256: string;
      size_bytes: string;
    }>(
      `select v.id, v.artifact_id, v.version_no, v.media_type, v.sha256, v.size_bytes
         from content.artifact_version v
         join core.object o on o.id = v.artifact_id
        where v.artifact_id = $1
        order by v.version_no`,
      [objectId],
    );
    return rows.map((r) => ({
      versionId: r.id,
      artifactId: r.artifact_id,
      versionNo: Number(r.version_no),
      mediaType: r.media_type,
      sha256: r.sha256,
      sizeBytes: r.size_bytes,
    }));
  });
}

// ── 9. rehearse ─────────────────────────────────────────────────────────────────────────

export interface Rehearsal {
  readonly wouldSucceed: boolean;
  /** Present when it would be refused, with the same code the API would return. */
  readonly refusal?: {
    readonly failure: string;
    readonly message: string;
    readonly detail: unknown;
  };
  /** Objects the action would have moved, and where to. */
  readonly wouldMove: readonly {
    readonly objectId: string;
    readonly from: string;
    readonly to: string;
  }[];
  readonly wouldCreate: number;
}

/** Thrown to force the rollback. Never escapes `rehearseAction`. */
class RollbackRehearsal extends Error {
  readonly outcome: Rehearsal;
  constructor(outcome: Rehearsal) {
    super('rehearsal complete');
    this.outcome = outcome;
  }
}

/**
 * Run an action for real, and throw it away.
 *
 * The ninth tool, and the only one that touches the write path. It uses the REAL dispatcher —
 * every precondition, every trigger, every invariant — inside a transaction that always
 * rolls back. So the answer is not a model of what would happen; it is what happened, undone.
 *
 * The rollback is not a flag anybody can pass. It is an exception thrown after the dispatcher
 * returns, which `withTransaction` turns into a rollback: there is no code path through this
 * function that commits, and adding one would mean deleting the throw.
 */
export async function rehearseAction(
  pool: Pool,
  scope: AgentScope,
  request: Omit<ActionRequest, 'organizationId' | 'maxClassification' | 'actorId' | 'actingRoleId'>,
  dispatcherOptions: Parameters<typeof createDispatcher>[1] = {},
): Promise<Rehearsal> {
  const full: ActionRequest = {
    ...request,
    actorId: scope.actorId,
    actingRoleId: scope.actingRoleId,
    organizationId: scope.organizationId,
    maxClassification: scope.maxClassification,
  };

  try {
    await withTransaction(pool, async (tx) => {
      // Bind the caller's scope on the OUTER transaction before reading anything.
      //
      // Without this the before-snapshot came back empty — row-level security correctly
      // hiding records from a transaction that had not said who it was — and the rehearsal
      // reported "nothing would move" for an action that moved something. The dispatcher
      // binds its own scope, but that happens inside the savepoint and does not reach here.
      await tx.query('select core.set_access_context($1, $2)', [
        scope.organizationId,
        scope.maxClassification,
      ]);

      const before = await stateSnapshot(tx, full.targetIds);

      // A dispatcher over a pool whose only client is THIS transaction. The action runs
      // exactly as it would in production, and the enclosing rollback is what makes it a
      // rehearsal rather than a performance.
      const execute = createDispatcher(singleTransactionPool(tx), dispatcherOptions);
      const result = await execute(full);

      const after = await stateSnapshot(tx, result.objectIds);
      const wouldMove = [...after.entries()]
        .filter(([id, to]) => before.get(id) !== undefined && before.get(id) !== to)
        .map(([id, to]) => ({ objectId: id, from: before.get(id)!, to }));

      throw new RollbackRehearsal({
        wouldSucceed: true,
        wouldMove,
        wouldCreate: result.objectIds.length - full.targetIds.length,
      });
    });
  } catch (err: unknown) {
    if (err instanceof RollbackRehearsal) return err.outcome;
    if (err instanceof ActionRejected) {
      return {
        wouldSucceed: false,
        refusal: { failure: err.failure, message: err.message, detail: err.detail },
        wouldMove: [],
        wouldCreate: 0,
      };
    }
    // Anything else is a fault in the rehearsal itself, and is reported as a refusal with the
    // message rather than swallowed — a rehearsal that returns "would succeed" because it
    // crashed is worse than one that fails loudly.
    return {
      wouldSucceed: false,
      refusal: {
        failure: 'rehearsal_failed',
        message: err instanceof Error ? err.message : String(err),
        detail: null,
      },
      wouldMove: [],
      wouldCreate: 0,
    };
  }

  // withTransaction returned without the throw firing, which cannot happen while the throw is
  // there. Reported rather than assumed, because the day it can is the day a rehearsal
  // committed.
  throw new Error('rehearsal did not roll back — refusing to report a result');
}

async function stateSnapshot(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.query<{ id: string; lifecycle_state: string }>(
    'select id, lifecycle_state from core.object where id = any($1::uuid[])',
    [[...ids]],
  );
  return new Map(rows.map((r) => [r.id, r.lifecycle_state]));
}

const REHEARSAL_SAVEPOINT = 'kf_rehearsal';

/**
 * Statements that decide whether work becomes durable.
 *
 * Matched by leading verb rather than exact string, and anything in this family that is not
 * explicitly handled is REFUSED rather than passed through. The safety argument used to rest
 * on this list being exhaustive, which is the kind of assumption that is true until somebody
 * changes the dispatcher: `RELEASE SAVEPOINT kf_rehearsal` would have folded the rehearsal
 * into the enclosing transaction, and the outer rollback would have had nothing to undo.
 *
 * Now the list only has to be exhaustive about what is SAFE. Everything else fails loudly.
 */
const TRANSACTION_CONTROL =
  /^(begin|start\s+transaction|commit|end|rollback|savepoint|release|set\s+transaction|abort)\b/;

/**
 * A Pool facade over one open transaction, translating the dispatcher's transaction control
 * into SAVEPOINTS.
 *
 * The obvious version of this is a trap. The dispatcher opens its own transaction, and on the
 * same connection PostgreSQL treats a nested BEGIN as a warning and a no-op — but it treats
 * the matching COMMIT as a REAL COMMIT of the outer transaction. So a facade that passed
 * these through would commit the rehearsal, and the rollback afterwards would have nothing
 * left to undo. The rehearsal would have happened.
 *
 * So:  BEGIN -> savepoint,  COMMIT -> nothing,  ROLLBACK -> rollback to savepoint.
 *
 * COMMIT maps to nothing rather than to RELEASE SAVEPOINT deliberately. Releasing would fold
 * the work into the enclosing transaction, which is correct for a real nested transaction and
 * exactly wrong here: the outer rollback must still be able to discard it. Nothing in this
 * function can make a write durable.
 */
function singleTransactionPool(tx: Tx): Pool {
  const control = async (sql: string): Promise<Record<string, unknown>[]> => {
    const verb = sql.trim().toLowerCase();
    if (/^begin\b/.test(verb) || /^start\s+transaction\b/.test(verb)) {
      return tx.query(`savepoint ${REHEARSAL_SAVEPOINT}`);
    }
    // Deliberately NOT `release savepoint`. See above.
    if (/^(commit|end)\b/.test(verb)) return [];
    if (/^(rollback|abort)\b/.test(verb)) {
      return tx.query(`rollback to savepoint ${REHEARSAL_SAVEPOINT}`);
    }
    if (TRANSACTION_CONTROL.test(verb)) {
      // Fail closed. A savepoint the rehearsal did not create, or a release, or an isolation
      // change — none of these have a translation that is obviously safe, and guessing at one
      // is how a rehearsal becomes a performance.
      throw new Error(
        `rehearsal refuses transaction control it cannot safely translate: ${sql.trim().slice(0, 60)}`,
      );
    }
    return tx.query(sql);
  };

  return {
    connect: async () => ({
      query: async (sql: string, params?: readonly unknown[]) => {
        // The VERB decides, not the presence of parameters. Routing on parameters meant a
        // hypothetical `query('commit', [x])` would have bypassed the facade entirely.
        const rows = TRANSACTION_CONTROL.test(sql.trim().toLowerCase())
          ? await control(sql)
          : await tx.query(sql, params ?? []);
        return { rows };
      },
      release: () => {
        /* the caller owns this transaction */
      },
    }),
    end: async () => {
      /* not ours to end */
    },
  } as unknown as Pool;
}

export const AGENT_TOOLS = [
  'find_records',
  'read_record',
  'read_history',
  'available_actions',
  'trace_relations',
  'verification_of',
  'external_citations',
  'evidence_for',
  'rehearse_action',
] as const;

export const PACKAGE = {
  name: '@kf/agent-tools',
  role: 'Typed agent tools: eight reads and one rehearsal, no writes',
  owns: [],
} as const;
