/**
 * The person's one gesture: a draft becomes the act it drafted (ADR 0040 decisions 5 to 7,
 * KF-SAS-RQ-263, RQ-265, RQ-266).
 *
 * The same landing the KF MCP server's `submit_act` gives (apps/mcp/src/server.ts), over the same
 * API, with the person's token exchanged for the in-app agent's:
 *
 *   - a `submit` act is performed for the person and recorded with the agent's participation, and
 *     what it writes is UNVERIFIED until someone with authority verifies it (or a verification
 *     policy in force does, which the receipt names);
 *   - a `propose` act is institutional: it is proposed with `propose_act`, performs nothing, and
 *     waits in the person's Needs you until they perform it there themselves.
 *
 * The draft is rebuilt from the submitted fields with `draftAgentAct` before anything is sent, so
 * what is written is exactly what the form showed, and a form the person left incomplete is
 * refused with its problems rather than half-written.
 */

import { agentAct, draftAgentAct, type AgentDraft } from '@kf/domain';
import { record, type ApiAnswer, type FabricClient } from './fabric.js';

export type SubmitOutcome =
  | {
      readonly disposition: 'submitted';
      readonly act: string;
      readonly actionId: string | null;
      readonly recordIds: readonly string[];
      /** Each record's verification as the person's own read reports it. */
      readonly verification: Readonly<Record<string, unknown>>;
    }
  | {
      readonly disposition: 'proposed';
      readonly act: string;
      readonly proposalId: string | null;
    }
  | {
      readonly disposition: 'refused';
      readonly act: string;
      readonly status: number;
      readonly code: string;
      readonly message: string;
      readonly problems?: readonly string[];
    };

function refusedBy(act: string, answer: ApiAnswer): SubmitOutcome {
  const body = record(answer.body);
  return {
    disposition: 'refused',
    act,
    status: answer.status,
    code: typeof body?.['error'] === 'string' ? body['error'] : 'refused',
    message:
      typeof body?.['message'] === 'string'
        ? body['message']
        : `the Fabric answered ${String(answer.status)}`,
  };
}

export interface SubmitInput {
  readonly act: string;
  readonly targetIds?: readonly string[];
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly reason?: string;
  /** The gesture's key: a retry of the same gesture replays, never repeats. */
  readonly idempotencyKey: string;
}

export async function submitDraft(
  fabric: FabricClient,
  input: SubmitInput,
): Promise<SubmitOutcome> {
  const entry = agentAct(input.act);
  if (entry === undefined) {
    return {
      disposition: 'refused',
      act: input.act,
      status: 400,
      code: 'not_an_agent_act',
      message: `${input.act} is not on the closed list of acts an agent may draft`,
    };
  }
  const draft: AgentDraft = draftAgentAct(entry, {
    ...(input.targetIds === undefined ? {} : { targetIds: input.targetIds }),
    ...(input.fields === undefined ? {} : { fields: input.fields }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
  if (!draft.ready) {
    return {
      disposition: 'refused',
      act: entry.act,
      status: 400,
      code: 'draft_incomplete',
      message: 'the form is not complete',
      problems: draft.problems,
    };
  }

  if (entry.disposition === 'propose') {
    const response = await fabric.call('POST', '/actions/propose_act', {
      body: {
        targetIds: draft.targetIds.length > 0 ? draft.targetIds : [fabric.organizationId],
        payload: {
          action_type: entry.act,
          target_ids: draft.targetIds,
          payload: draft.payload,
          ...(draft.reason === null ? {} : { reason: draft.reason }),
        },
        reason: `proposed by the in-app agent for its person: ${entry.act}`,
        idempotencyKey: input.idempotencyKey,
      },
    });
    if (response.status >= 300) return refusedBy(entry.act, response);
    const receipt = record(record(response.body)?.['receipt']);
    return {
      disposition: 'proposed',
      act: entry.act,
      proposalId: typeof receipt?.['proposalId'] === 'string' ? receipt['proposalId'] : null,
    };
  }

  const response =
    entry.route === 'capture'
      ? await fabric.call('POST', '/capture/observation', {
          body: { ...draft.payload, gesture_id: input.idempotencyKey },
        })
      : await fabric.call('POST', `/actions/${entry.act}`, {
          body: {
            targetIds: draft.targetIds,
            payload: draft.payload,
            ...(draft.reason === null ? {} : { reason: draft.reason }),
            idempotencyKey: input.idempotencyKey,
          },
        });
  if (response.status >= 300) return refusedBy(entry.act, response);
  const body = record(response.body) ?? {};
  const recordIds: string[] =
    typeof body['observationId'] === 'string'
      ? [body['observationId']]
      : Array.isArray(body['objectIds'])
        ? (body['objectIds'] as unknown[]).filter((id): id is string => typeof id === 'string')
        : [];
  const verification: Record<string, unknown> = {};
  for (const id of recordIds) {
    const read = await fabric.call('GET', `/objects/${encodeURIComponent(id)}/verification`);
    verification[id] = record(read.body)?.['verification'] ?? null;
  }
  return {
    disposition: 'submitted',
    act: entry.act,
    actionId: typeof body['actionId'] === 'string' ? body['actionId'] : null,
    recordIds,
    verification,
  };
}
