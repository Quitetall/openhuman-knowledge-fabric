/**
 * Agents submit; authority verifies (ADR 0040 decisions 5 and 6, KF-SAS-RQ-263 to RQ-266).
 *
 * Three acts, and none of them decides anything the database does not decide again
 * (`20261007100000_agents_submit_authority_verifies.sql`):
 *
 * - `set_verification_policy` — institutional, so no agent can set its own trust. Records, for the
 *   organization it targets, whether records of one kind written by one act with one declared
 *   agent's participation are verified on arrival (`verified_on_submit`) or wait for a person
 *   (`required`). The database refuses `verified_on_submit` for an institutional act type
 *   (KF-VPOL-001) and for an agent that is not declared (KF-VPOL-002).
 * - `propose_act` — an agent's request that its person perform an institutional act. Performs
 *   nothing. The database refuses it for a non-institutional type (KF-AGENT-003) and without an
 *   agent (KF-AGENT-004), and takes the person, assignment and agent from the sealed context.
 * - `resolve_act_proposal` — the person's answer, once: `declined`, or `confirmed` naming the act
 *   they performed, which the database checks is theirs, agent-free, of the proposed type and with
 *   the proposed request digest (KF-AGENT-005). Never an agent's (KF-AGENT-002).
 *
 * A proposal's request digest is `kf-action-request-v1` of the act as its person would dispatch
 * it, so "confirmed" is a comparison of two digests the dispatcher computed the same way, never a
 * claim the confirming route makes.
 */

import {
  ActionRejected,
  assertMeaningfulReason,
  semanticActionRequestDigest,
  type ActionEffect,
  type ActionReceiptReader,
  type ActionRequest,
  type PreconditionCheck,
} from '@kf/actions';
import type { JsonValue } from '@kf/canonicalization';
import type { Tx } from '@kf/database';

export const VERIFICATION_POLICY_MODES = ['required', 'verified_on_submit'] as const;
export type VerificationPolicyMode = (typeof VERIFICATION_POLICY_MODES)[number];

export const PROPOSAL_RESOLUTIONS = ['confirmed', 'declined'] as const;
export type ProposalResolution = (typeof PROPOSAL_RESOLUTIONS)[number];

export const AGENT_ACT_ACTION_IDS = [
  'set_verification_policy',
  'propose_act',
  'resolve_act_proposal',
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

function refuse(message: string, detail: Record<string, unknown> = {}): never {
  throw new ActionRejected('precondition_failed', message, detail);
}

function stringField(request: ActionRequest, key: string, pattern?: RegExp): string {
  const value = request.payload?.[key];
  if (typeof value !== 'string' || value.trim() === '' || (pattern && !pattern.test(value))) {
    refuse(`${request.actionType} needs ${key} in its payload`, { field: key });
  }
  return value;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return set.size === left.length && right.every((id) => set.has(id));
}

/** Its targets when it has any; otherwise the organization the act is made in. */
function targetsOrOrganization(request: ActionRequest, targets: readonly string[]): string[] {
  return targets.length > 0 ? [...targets] : [request.organizationId];
}

function assertTargets(request: ActionRequest, expected: readonly string[]): void {
  if (!sameSet(request.targetIds, expected)) {
    refuse(
      `${request.actionType} targets exactly ${expected.length === 1 ? 'one record' : 'the proposed act’s records'}: ` +
        (request.targetIds.length === 0 ? 'none was named' : 'the named targets differ'),
      { expected: [...expected].sort(), named: [...request.targetIds].sort() },
    );
  }
}

// set_verification_policy --------------------------------------------------------------------

interface PolicyPayload {
  readonly objectType: string;
  readonly actionType: string;
  readonly agentClientId: string;
  readonly mode: VerificationPolicyMode;
}

function policyPayload(request: ActionRequest): PolicyPayload {
  const mode = stringField(request, 'mode');
  if (!(VERIFICATION_POLICY_MODES as readonly string[]).includes(mode)) {
    refuse(`set_verification_policy mode must be one of ${VERIFICATION_POLICY_MODES.join(', ')}`, {
      field: 'mode',
    });
  }
  return {
    objectType: stringField(request, 'object_type', IDENTIFIER),
    actionType: stringField(request, 'action_type', IDENTIFIER),
    agentClientId: stringField(request, 'agent_client_id', CLIENT_ID),
    mode: mode as VerificationPolicyMode,
  };
}

const assertSetVerificationPolicy: PreconditionCheck = async (tx, request) => {
  assertTargets(request, [request.organizationId]);
  assertMeaningfulReason(request);
  const policy = policyPayload(request);
  const known = await tx.one<{ object_type: boolean; action_type: boolean }>(
    `select exists (select 1 from registry.object_type where id = $1) as object_type,
            exists (select 1 from registry.action_type where id = $2) as action_type`,
    [policy.objectType, policy.actionType],
  );
  if (!known.object_type) refuse(`${policy.objectType} is not a declared record kind`);
  if (!known.action_type) refuse(`${policy.actionType} is not a declared act`);
};

const setVerificationPolicy: ActionEffect = async (tx, request, _objects, ctx) => {
  const policy = policyPayload(request);
  // `set_by`, `set_by_action`, `set_at` and `revision` are drawn again by the database from the
  // sealed context (verification_policy_bounded); stated here so the row satisfies the policy.
  await tx.query(
    `insert into core.verification_policy
       (organization_id, object_type, action_type, agent_client_id, mode, reason, set_by,
        set_by_action)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      request.organizationId,
      policy.objectType,
      policy.actionType,
      policy.agentClientId,
      policy.mode,
      request.reason?.trim() ?? '',
      request.actorId,
      ctx.actionId,
    ],
  );
};

const readPolicyReceipt: ActionReceiptReader = async (tx, actionId) => {
  const row = await tx.maybeOne<{
    id: string;
    revision: string;
    object_type: string;
    action_type: string;
    agent_client_id: string;
    mode: string;
  }>(
    `select id, revision::text, object_type, action_type, agent_client_id, mode
       from core.verification_policy where set_by_action = $1`,
    [actionId],
  );
  if (row === undefined) return {};
  return {
    policyId: row.id,
    revision: Number(row.revision),
    objectType: row.object_type,
    actionType: row.action_type,
    agentClientId: row.agent_client_id,
    mode: row.mode,
  };
};

// propose_act --------------------------------------------------------------------------------

/** What an agent proposes: an act exactly as its person would dispatch it. */
export interface ProposedAct {
  readonly actionType: string;
  readonly targetIds: readonly string[];
  readonly payload: Readonly<Record<string, JsonValue>>;
  readonly reason?: string;
}

export function proposedActOf(request: ActionRequest): ProposedAct {
  const actionType = stringField(request, 'action_type', IDENTIFIER);
  const rawTargets = request.payload?.['target_ids'] ?? [];
  if (
    !Array.isArray(rawTargets) ||
    !rawTargets.every((id): id is string => typeof id === 'string' && UUID.test(id)) ||
    new Set(rawTargets).size !== rawTargets.length
  ) {
    refuse('propose_act target_ids must be distinct lowercase uuids', { field: 'target_ids' });
  }
  const payload = request.payload?.['payload'] ?? {};
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    refuse('propose_act payload must be an object: the proposed act’s own payload', {
      field: 'payload',
    });
  }
  const reason = request.payload?.['reason'];
  if (reason !== undefined && (typeof reason !== 'string' || reason.trim() === '')) {
    refuse('propose_act reason, when given, is the proposed act’s reason', { field: 'reason' });
  }
  return {
    actionType,
    targetIds: rawTargets,
    payload: payload as Readonly<Record<string, JsonValue>>,
    ...(typeof reason === 'string' ? { reason } : {}),
  };
}

/**
 * The request the person dispatches to perform a proposal, and the digest the proposal records.
 * The same fields in, so `semanticActionRequestDigest` of the two agrees exactly when the person
 * performs what was proposed, under the assignment it was proposed under.
 */
export function proposalRequest(
  proposal: ProposedAct,
  person: {
    readonly actorId: string;
    readonly actingRoleId: string;
    readonly organizationId: string;
    readonly maxClassification: string;
  },
  idempotencyKey: string,
): ActionRequest {
  return {
    actionType: proposal.actionType,
    actorId: person.actorId,
    actingRoleId: person.actingRoleId,
    organizationId: person.organizationId,
    maxClassification: person.maxClassification,
    targetIds: [...proposal.targetIds],
    payload: proposal.payload,
    ...(proposal.reason === undefined ? {} : { reason: proposal.reason }),
    idempotencyKey,
  };
}

const assertProposeAct: PreconditionCheck = async (tx, request) => {
  const proposal = proposedActOf(request);
  assertTargets(request, targetsOrOrganization(request, proposal.targetIds));
  const row = await tx.one<{ institutional: boolean; declared: boolean }>(
    `select core.action_type_is_institutional($1) as institutional,
            exists (select 1 from registry.action_type where id = $1) as declared`,
    [proposal.actionType],
  );
  if (!row.declared) refuse(`${proposal.actionType} is not a declared act`);
  if (!row.institutional) {
    // Said here with the way forward; the database says it again (KF-AGENT-003).
    refuse(
      `KF-AGENT-003: ${proposal.actionType} is not an institutional act; dispatch it for the ` +
        'person rather than proposing it',
      { rule: 'KF-AGENT-003' },
    );
  }
};

const proposeAct: ActionEffect = async (tx, request, _objects, ctx) => {
  const proposal = proposedActOf(request);
  const digest = semanticActionRequestDigest(proposalRequest(proposal, request, 'unused'));
  await tx.query(
    `insert into core.act_proposal
       (organization_id, proposed_for, acting_role_id, agent_client_id, action_type, target_ids,
        payload, reason, request_digest, proposed_by_action)
     values ($1, $2, $3, core.current_agent_or_null(), $4, $5::uuid[], $6::jsonb,
             $7, $8, $9)`,
    [
      request.organizationId,
      request.actorId,
      request.actingRoleId,
      proposal.actionType,
      [...proposal.targetIds],
      JSON.stringify(proposal.payload),
      proposal.reason ?? null,
      digest,
      ctx.actionId,
    ],
  );
};

const readProposalReceipt: ActionReceiptReader = async (tx, actionId) => {
  const row = await tx.maybeOne<{ id: string; action_type: string; agent_client_id: string }>(
    `select id, action_type, agent_client_id from core.act_proposal where proposed_by_action = $1`,
    [actionId],
  );
  return row === undefined
    ? {}
    : { proposalId: row.id, actionType: row.action_type, agentClientId: row.agent_client_id };
};

// resolve_act_proposal -----------------------------------------------------------------------

export interface PendingProposal {
  readonly id: string;
  readonly actionType: string;
  readonly targetIds: readonly string[];
  readonly payload: Readonly<Record<string, JsonValue>>;
  readonly reason: string | null;
  readonly actingRoleId: string;
  readonly agentClientId: string;
  readonly requestDigest: string;
  readonly proposedAt: string;
  readonly resolution: ProposalResolution | null;
}

/** One proposal as the bound person sees it, or undefined when it is not theirs to see. */
export async function readProposal(
  tx: Tx,
  proposalId: string,
): Promise<PendingProposal | undefined> {
  if (!UUID.test(proposalId)) return undefined;
  const row = await tx.maybeOne<{
    id: string;
    action_type: string;
    target_ids: string[];
    payload: Record<string, JsonValue>;
    reason: string | null;
    acting_role_id: string;
    agent_client_id: string;
    request_digest: string;
    proposed_at: Date;
    resolution: ProposalResolution | null;
  }>(
    `select p.id, p.action_type, p.target_ids::text[] as target_ids, p.payload, p.reason,
            p.acting_role_id, p.agent_client_id, p.request_digest, p.proposed_at, r.resolution
       from core.act_proposal p
       left join core.act_proposal_resolution r on r.proposal_id = p.id
      where p.id = $1`,
    [proposalId],
  );
  if (row === undefined) return undefined;
  return {
    id: row.id,
    actionType: row.action_type,
    targetIds: row.target_ids,
    payload: row.payload,
    reason: row.reason,
    actingRoleId: row.acting_role_id,
    agentClientId: row.agent_client_id,
    requestDigest: row.request_digest,
    proposedAt: row.proposed_at.toISOString(),
    resolution: row.resolution,
  };
}

const assertResolveActProposal: PreconditionCheck = async (tx, request) => {
  const proposalId = stringField(request, 'proposal_id', UUID);
  const resolution = stringField(request, 'resolution');
  if (!(PROPOSAL_RESOLUTIONS as readonly string[]).includes(resolution)) {
    refuse(`resolve_act_proposal resolution must be one of ${PROPOSAL_RESOLUTIONS.join(', ')}`, {
      field: 'resolution',
    });
  }
  const proposal = await readProposal(tx, proposalId);
  if (proposal === undefined) {
    throw new ActionRejected('object_not_visible', 'no such proposal awaits this person', {
      proposalId,
    });
  }
  if (proposal.resolution !== null) {
    refuse(`proposal ${proposalId} was already ${proposal.resolution}`, { proposalId });
  }
  assertTargets(request, targetsOrOrganization(request, proposal.targetIds));
  if (resolution === 'confirmed') {
    stringField(request, 'performed_action', UUID);
  } else {
    assertMeaningfulReason(request);
  }
};

const resolveActProposal: ActionEffect = async (tx, request, _objects, ctx) => {
  const performed = request.payload?.['performed_action'];
  await tx.query(
    `insert into core.act_proposal_resolution
       (proposal_id, organization_id, resolution, performed_action, resolved_by, resolved_by_action)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      request.payload?.['proposal_id'],
      request.organizationId,
      request.payload?.['resolution'],
      request.payload?.['resolution'] === 'confirmed' ? performed : null,
      request.actorId,
      ctx.actionId,
    ],
  );
};

const readResolutionReceipt: ActionReceiptReader = async (tx, actionId) => {
  const row = await tx.maybeOne<{
    proposal_id: string;
    resolution: string;
    performed_action: string | null;
  }>(
    `select proposal_id, resolution, performed_action
       from core.act_proposal_resolution where resolved_by_action = $1`,
    [actionId],
  );
  return row === undefined
    ? {}
    : {
        proposalId: row.proposal_id,
        resolution: row.resolution,
        performedAction: row.performed_action,
      };
};

export const AGENT_ACT_PRECONDITIONS: Readonly<Record<string, PreconditionCheck>> = {
  set_verification_policy: assertSetVerificationPolicy,
  propose_act: assertProposeAct,
  resolve_act_proposal: assertResolveActProposal,
};

export const AGENT_ACT_EFFECTS: Readonly<Record<string, ActionEffect>> = {
  set_verification_policy: setVerificationPolicy,
  propose_act: proposeAct,
  resolve_act_proposal: resolveActProposal,
};

export const AGENT_ACT_RECEIPTS: Readonly<Record<string, ActionReceiptReader>> = {
  set_verification_policy: readPolicyReceipt,
  propose_act: readProposalReceipt,
  resolve_act_proposal: readResolutionReceipt,
};
