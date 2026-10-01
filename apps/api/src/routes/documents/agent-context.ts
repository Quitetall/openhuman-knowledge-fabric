import type { Tx } from '@kf/database';
import { enumerateRelevanceGraph } from '@kf/documents';
import {
  project,
  ProjectionRefused,
  type ProjectionDefinitionSet,
  type ProjectionResult,
} from '@kf/projections';
import { readCurrentProjectionCorpus } from './current-master-record.js';

/** What the AI planner is given to draw its context from (KF-SAS-RQ-115), or why not. */
export type AgentContextOutcome =
  | { readonly status: 'ready'; readonly projection: ProjectionResult }
  | { readonly status: 'projections_unavailable' }
  | { readonly status: 'master_record_not_found' }
  | { readonly status: 'master_record_stale' }
  | { readonly status: 'projection_refused'; readonly reason: string; readonly message: string };

export type ReadAgentContext = (
  tx: Tx,
  reader: { readonly actorId: string; readonly organizationId: string },
  tokenBudget: number,
) => Promise<AgentContextOutcome>;

/**
 * The reader's `agent_context` Result, evaluated exactly as `GET /master-record/projections/
 * agent_context` evaluates it: over their current master record, refused when that record is
 * stale, with verification read live. The session must already be bound as the reader.
 *
 * Read-only: a missing or stale master record is reported, not compiled — compiling is an act,
 * and the planner route is not where a person should be made to perform one.
 */
export function agentContextReader(
  definitions: ProjectionDefinitionSet | undefined,
): ReadAgentContext {
  return async (tx, reader, tokenBudget) => {
    const definition = definitions?.byId('agent_context');
    if (definition === undefined) return { status: 'projections_unavailable' };
    try {
      const reading = await readCurrentProjectionCorpus(tx, reader, definition, {
        token_budget: tokenBudget,
      });
      if (reading.status === 'missing') return { status: 'master_record_not_found' };
      if (reading.status === 'stale') return { status: 'master_record_stale' };
      return {
        status: 'ready',
        projection: project({
          definition,
          parameters: { token_budget: tokenBudget },
          corpus: reading.corpus,
          graph: await enumerateRelevanceGraph(tx),
        }),
      };
    } catch (error: unknown) {
      if (error instanceof ProjectionRefused && error.reason !== 'unlabelled_member') {
        return { status: 'projection_refused', reason: error.reason, message: error.message };
      }
      throw error;
    }
  };
}
