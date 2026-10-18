import { answerTurn, type Backends, type FabricClient } from '@kf/agent';
import { webCaller } from '../../lib/session';
import { loadAgentConfig, sealKey } from '../../lib/agent/config';
import { DelegationUnavailable, exchangeForAgent, fabricClient } from '../../lib/agent/fabric';
import type { AnswerEntry, CarriedTurnView } from './state';

/**
 * One answer from the record, shared by the chat (`actions.ts`) and Home's ask box: the same
 * retrieval over the reader's corpus, the same routing by classification, the same citations and
 * withheld count (ADR 0040 decisions 7 and 8). Nothing here is stored.
 */

/** The agent's view of the Fabric, and whether it holds an agent identity for writing. */
export async function agentFabric(
  returnTo: string,
): Promise<{ fabric: FabricClient; delegated: boolean; why?: string }> {
  const caller = await webCaller(returnTo);
  const config = loadAgentConfig();
  try {
    const bearer = await exchangeForAgent(caller, config);
    return { fabric: fabricClient(caller, bearer), delegated: true };
  } catch (error: unknown) {
    if (error instanceof DelegationUnavailable) {
      // Reads are the person's own and are recorded as theirs; writing waits for an identity.
      return { fabric: fabricClient(caller, undefined), delegated: false, why: error.message };
    }
    throw error;
  }
}

/**
 * Whether this deployment has any model to answer with. Without one an answer can only be
 * refused; Home then says so in plain words and shows the search results instead.
 */
export function answeringModelConfigured(): boolean {
  const config = loadAgentConfig();
  return config.lamu !== undefined || config.provider !== undefined;
}

export async function answerQuestion(
  agent: {
    readonly fabric: FabricClient;
    readonly backends: Backends;
    readonly delegated: boolean;
    readonly why?: string;
  },
  question: string,
  history: readonly CarriedTurnView[] = [],
): Promise<AnswerEntry> {
  const answer = await answerTurn(
    { fabric: agent.fabric, backends: agent.backends, sealKey: sealKey() },
    { question, history: [...history] },
  );
  return {
    kind: 'answer',
    status: answer.status,
    text: answer.text,
    backend: answer.backend,
    ...(answer.refusal === undefined ? {} : { refusal: answer.refusal }),
    citations: answer.citations.map(({ n, recordId, title, classification }) => ({
      n,
      recordId,
      title,
      classification,
    })),
    consulted: answer.consulted.map(({ n, recordId, title, classification }) => ({
      n,
      recordId,
      title,
      classification,
    })),
    withheldCount: answer.withheldCount,
    semanticRanking: answer.semanticRanking,
    notes: agent.delegated
      ? answer.notes
      : [...answer.notes, `Read as you: ${agent.why ?? ''}`.trim()],
    classification: answer.classification,
    guide: answer.guide,
    seal: answer.seal,
  };
}
