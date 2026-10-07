/**
 * The KF MCP server: nine tools, one closed list of acts, no authority of its own
 * (ADR 0040 decisions 1, 5 and 6; SAS §24B, §82; KF-SAS-RQ-020, RQ-150, RQ-263 to RQ-266).
 *
 * READ, as the person reads (every answer is the API's, under their grants and row security,
 * each record labelled verified or unverified as every other read labels it, KF-SAS-RQ-229):
 *
 *   search            fused, lexical and semantic rankings, and how many matches were withheld
 *   read_record       one record's Object View
 *   master_record     the person's master record (their scope, compiled)
 *   context_retrieve  the context source's retrieval (SourceRefs, no text)
 *   context_read      one SourceRef's text, re-checked against current authority
 *   list_needs_you    what waits on the person
 *
 * WRITE, through a closed list (`AGENT_ACTS` in @kf/domain): no tool takes an act type outside
 * it, and none reaches a general write.
 *
 *   list_actions      the acts this agent may write, and how each lands
 *   draft_act         the form a person would fill for one of them, filled; writes nothing
 *   submit_act        writes it: a `submit` act is performed for the person and lands UNVERIFIED
 *                     (unless a verification policy in force verifies it, which the answer
 *                     names); a `propose` act is institutional, so it is proposed and waits in the
 *                     person's Needs you
 *
 * Nothing here can verify, confirm a proposal, set a verification policy or perform an
 * institutional act. The API refuses an agent's token each of those by name, and the database
 * refuses them again (KF-AGENT-001, KF-AGENT-002). The log carries tool names, outcomes and
 * refusal codes, never record content or a token.
 */

import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AGENT_ACT_NAMES, AGENT_ACTS, agentAct, draftAgentAct, type AgentAct } from '@kf/domain';
import type { ApiAnswer, FabricApi } from './api.js';

export const SERVER_NAME = 'knowledge-fabric';
export const SERVER_VERSION = '0.1.0';

/** The tool names, closed. A test pins this list. */
export const KF_MCP_TOOLS = [
  'search',
  'read_record',
  'master_record',
  'context_retrieve',
  'context_read',
  'list_actions',
  'draft_act',
  'submit_act',
  'list_needs_you',
] as const;

/** An answer the agent's context can hold; a longer one says where the rest is. */
const MAX_ANSWER_CHARACTERS = 200_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GESTURE = /^[A-Za-z0-9._:-]{8,48}$/;

export interface Log {
  (entry: {
    tool: string;
    outcome: 'ok' | 'refused' | 'error';
    status?: number;
    code?: string;
  }): void;
}

const stderrLog: Log = (entry) => {
  process.stderr.write(`${JSON.stringify({ service: 'kf-mcp', ...entry })}\n`);
};

interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function text(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  return json.length <= MAX_ANSWER_CHARACTERS
    ? json
    : `${json.slice(0, MAX_ANSWER_CHARACTERS)}\n… truncated at ${String(MAX_ANSWER_CHARACTERS)} ` +
        'characters; narrow the request (search, then read_record one record)';
}

function ok(value: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: text(value) }],
    ...(typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { structuredContent: value as Record<string, unknown> }
      : {}),
  };
}

function refused(value: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: text(value) }],
    structuredContent: value,
    isError: true,
  };
}

function codeOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as Record<string, unknown>)['error'];
  return typeof error === 'string' ? error : undefined;
}

/** Map one API answer to a tool result: 2xx is the answer, anything else the API's refusal. */
function answer(log: Log, tool: string, response: ApiAnswer): ToolResult {
  if (response.status >= 200 && response.status < 300) {
    log({ tool, outcome: 'ok', status: response.status });
    return ok(response.body);
  }
  const code = codeOf(response.body);
  log({
    tool,
    outcome: response.status >= 500 ? 'error' : 'refused',
    status: response.status,
    ...(code === undefined ? {} : { code }),
  });
  return refused({
    status: response.status,
    refusal: response.body,
  });
}

function catalogEntry(entry: AgentAct) {
  return {
    act: entry.act,
    disposition: entry.disposition,
    title: entry.title,
    description: entry.description,
    targets: entry.targets,
    ...(entry.targetKind === undefined ? {} : { targetKind: entry.targetKind }),
    ...(entry.creates === undefined ? {} : { creates: entry.creates }),
    reasonRequired: entry.reasonRequired,
    fields: entry.fields,
    lands:
      entry.disposition === 'submit'
        ? 'performed for your person, recorded with this agent’s participation, UNVERIFIED until ' +
          'a person with authority verifies it (or a verification policy in force does)'
        : 'institutional: proposed only; it waits in your person’s Needs you and only they perform it',
  };
}

const actSchema = z.enum(AGENT_ACT_NAMES as [string, ...string[]]);
const writeInput = z.object({
  act: actSchema.describe('One act from list_actions; there is no other way to write'),
  targetIds: z
    .array(z.string().regex(UUID))
    .max(1)
    .optional()
    .describe('The one record it acts on, for an act with targets "one"'),
  fields: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('The form’s fields, by name, as list_actions describes them'),
  reason: z.string().max(4000).optional().describe('Why — required where the act requires it'),
});

/** Build the server over one person's API client. Tools are registered once, here. */
export function createKfMcpServer(api: FabricApi, log: Log = stderrLog): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Knowledge Fabric, for the person whose delegated token this server holds. Reads return ' +
        'only what that person may read, each record labelled verified or UNVERIFIED. Writes go ' +
        'through a closed list of acts (list_actions): what you submit is recorded as the ' +
        'person’s act with your participation and is UNVERIFIED until someone with authority ' +
        'verifies it; institutional acts can only be proposed, and wait for the person. Show the ' +
        'person a draft (draft_act) before you submit it.',
    },
  );

  server.registerTool(
    'search',
    {
      title: 'Search the record',
      description:
        'Search what the person may read: the fused ranking first, the lexical and semantic ' +
        'rankings it came from, and withheldCount — how many matches within their clearance no ' +
        'grant of theirs reaches (ADR 0037).',
      inputSchema: z.object({
        query: z.string().min(1).max(512),
        limit: z.number().int().min(1).max(50).optional(),
        objectType: z
          .string()
          .regex(/^[a-z][a-z0-9_]{0,62}$/)
          .optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit, objectType }) =>
      answer(
        log,
        'search',
        await api.call('GET', '/search', {
          query: {
            q: query,
            limit: String(limit ?? 10),
            ...(objectType === undefined ? {} : { objectType }),
          },
        }),
      ),
  );

  server.registerTool(
    'read_record',
    {
      title: 'Read one record',
      description:
        'One record as the person’s Object View shows it, with its verification label. A record ' +
        'they may not read is not found, whether or not it exists. When their master record is ' +
        'out of date this compiles it first, which is recorded as their act with your ' +
        'participation.',
      inputSchema: z.object({ id: z.string().regex(UUID) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const path = `/objects/${encodeURIComponent(id)}`;
      const first = await api.call('GET', path);
      // A view reads over the person's master record. Stale, the API's way forward is the refresh,
      // which compiles it — a recorded act of the person, with this agent's participation.
      if (first.status === 409 && codeOf(first.body) === 'master_record_stale') {
        return answer(log, 'read_record', await api.call('POST', `${path}/refresh`));
      }
      return answer(log, 'read_record', first);
    },
  );

  server.registerTool(
    'master_record',
    {
      title: 'The person’s master record',
      description:
        'The person’s scope, compiled: every record their grants reach, sectioned, each labelled. ' +
        'Large; prefer search and read_record for one question.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => answer(log, 'master_record', await api.call('GET', '/master-record')),
  );

  server.registerTool(
    'context_retrieve',
    {
      title: 'Retrieve context references',
      description:
        'The context source’s retrieval: SourceRefs for the records most relevant to a query, ' +
        'under the person’s current authority. Read each with context_read.',
      inputSchema: z.object({
        query: z.string().min(1).max(512),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) =>
      answer(
        log,
        'context_retrieve',
        await api.call('POST', '/context-source/retrieve', {
          body: { query, limit: limit ?? 10 },
        }),
      ),
  );

  server.registerTool(
    'context_read',
    {
      title: 'Read one context reference',
      description:
        'The text of one SourceRef from context_retrieve, re-checked against the person’s current ' +
        'authority and the revision named; a moved or withdrawn record is refused.',
      inputSchema: z.object({
        record: z.string().regex(UUID),
        revision: z.string().min(1).max(128),
        digest: z.string().min(1).max(128),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ record, revision, digest }) =>
      answer(
        log,
        'context_read',
        await api.call('POST', '/context-source/read', {
          body: { adapter: 'knowledge-fabric', record, revision, digest },
        }),
      ),
  );

  server.registerTool(
    'list_needs_you',
    {
      title: 'What waits on the person',
      description:
        'Unverified records the person may verify, what their agents submitted that waits for ' +
        'someone else, and institutional acts proposed for them. Only the person answers these, in ' +
        'the web application; this agent cannot verify or confirm.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => answer(log, 'list_needs_you', await api.call('GET', '/needs-you')),
  );

  server.registerTool(
    'list_actions',
    {
      title: 'What this agent may write',
      description:
        'The closed list of acts this agent may write for the person, the fields a person would ' +
        'fill for each, and how each lands (submitted unverified, or proposed). With recordId, ' +
        'also the transitions that record’s state allows the person.',
      inputSchema: z.object({ recordId: z.string().regex(UUID).optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ recordId }) => {
      const catalog = AGENT_ACTS.map(catalogEntry);
      if (recordId === undefined) {
        log({ tool: 'list_actions', outcome: 'ok' });
        return ok({ acts: catalog });
      }
      const response = await api.call(
        'GET',
        `/objects/${encodeURIComponent(recordId)}/available-actions`,
      );
      if (response.status !== 200) return answer(log, 'list_actions', response);
      const available = response.body as { actions?: { actionType: string }[] };
      const allowed = new Set((available.actions ?? []).map((a) => a.actionType));
      log({ tool: 'list_actions', outcome: 'ok', status: 200 });
      return ok({
        recordId,
        acts: catalog.filter((entry) => entry.targets === 'none' || allowed.has(entry.act)),
        stateAllows: available.actions ?? [],
      });
    },
  );

  server.registerTool(
    'draft_act',
    {
      title: 'Draft an act for the person',
      description:
        'The form a person would fill for one act, filled with your values, and what is missing. ' +
        'Writes nothing. Show it to the person before submit_act.',
      inputSchema: writeInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ act, targetIds, fields, reason }) => {
      const entry = agentAct(act)!;
      const draft = draftAgentAct(entry, {
        ...(targetIds === undefined ? {} : { targetIds }),
        ...(fields === undefined ? {} : { fields }),
        ...(reason === undefined ? {} : { reason }),
      });
      log({ tool: 'draft_act', outcome: 'ok' });
      return ok({ draft, lands: catalogEntry(entry).lands });
    },
  );

  server.registerTool(
    'submit_act',
    {
      title: 'Submit an act for the person',
      description:
        'Write one act from the closed list for the person. A submitted act is recorded as their ' +
        'act with your participation and is UNVERIFIED until someone with authority verifies it ' +
        '(the answer names a verification policy if one verified it on arrival). An institutional ' +
        'act is only proposed: it waits in the person’s Needs you.',
      inputSchema: writeInput.extend({
        idempotencyKey: z
          .string()
          .regex(GESTURE)
          .optional()
          .describe('Retry the same submission with the same key and it replays, never repeats'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ act, targetIds, fields, reason, idempotencyKey }) => {
      const entry = agentAct(act)!;
      const draft = draftAgentAct(entry, {
        ...(targetIds === undefined ? {} : { targetIds }),
        ...(fields === undefined ? {} : { fields }),
        ...(reason === undefined ? {} : { reason }),
      });
      if (!draft.ready) {
        log({ tool: 'submit_act', outcome: 'refused', code: 'draft_incomplete' });
        return refused({ error: 'draft_incomplete', problems: draft.problems, draft });
      }
      const key = idempotencyKey ?? `mcp-${randomUUID()}`;
      if (entry.disposition === 'propose') {
        const response = await api.call('POST', '/actions/propose_act', {
          body: {
            targetIds: draft.targetIds.length > 0 ? draft.targetIds : [api.organizationId],
            payload: {
              action_type: entry.act,
              target_ids: draft.targetIds,
              payload: draft.payload,
              ...(draft.reason === null ? {} : { reason: draft.reason }),
            },
            reason: `proposed by an agent for its person: ${entry.act}`,
            idempotencyKey: key,
          },
        });
        if (response.status >= 300) return answer(log, 'submit_act', response);
        log({ tool: 'submit_act', outcome: 'ok', status: response.status });
        const receipt = (response.body as { receipt?: Record<string, unknown> }).receipt ?? {};
        return ok({
          disposition: 'proposed',
          act: entry.act,
          proposalId: receipt['proposalId'] ?? null,
          performed: false,
          message:
            `${entry.act} is institutional, so it was proposed, not performed. It waits in your ` +
            'person’s Needs you; only they can perform it.',
        });
      }

      const response =
        entry.route === 'capture'
          ? await api.call('POST', '/capture/observation', {
              body: { ...draft.payload, gesture_id: key },
            })
          : await api.call('POST', `/actions/${entry.act}`, {
              body: {
                targetIds: draft.targetIds,
                payload: draft.payload,
                ...(draft.reason === null ? {} : { reason: draft.reason }),
                idempotencyKey: key,
              },
            });
      if (response.status >= 300) return answer(log, 'submit_act', response);
      const body = response.body as Record<string, unknown>;
      const recordIds: string[] =
        typeof body['observationId'] === 'string'
          ? [body['observationId']]
          : Array.isArray(body['objectIds'])
            ? (body['objectIds'] as string[])
            : [];
      // The verification as the person's own read reports it, so a record a policy verified on
      // arrival is not described as unverified, and an unverified one never as checked.
      const verifications: Record<string, unknown> = {};
      for (const id of recordIds) {
        const read = await api.call('GET', `/objects/${encodeURIComponent(id)}/verification`);
        const found = read.body as { verification?: unknown } | null;
        verifications[id] =
          read.status === 200 && found?.verification !== undefined
            ? found.verification
            : { verified: false, label: 'UNVERIFIED — nobody has checked this record' };
      }
      log({ tool: 'submit_act', outcome: 'ok', status: response.status });
      return ok({
        disposition: 'submitted',
        act: entry.act,
        actionId: body['actionId'] ?? null,
        replayed: body['replayed'] ?? false,
        recordIds,
        verification: verifications,
        message:
          'Recorded as your person’s act with this agent’s participation. It is UNVERIFIED until ' +
          'someone with authority verifies it, unless the verification above names a policy.',
      });
    },
  );

  return server;
}
