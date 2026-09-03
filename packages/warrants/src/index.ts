/**
 * Warrants — OpenWarrant SAS §67 as Knowledge Fabric typed actions (ADR 0019).
 *
 * KF is the institutional authority for a Warrant; Git stays its Source Holder. So the writes
 * here record what OpenWarrant computed — a contract digest, a Compilation Basis, a canonical
 * IR — and never recompute or reconstruct authored atoms. Phase (§24.1) is the object's
 * lifecycle state and is driven by the registry's state machine; the other four dimensions
 * (§24.2–24.5) are columns on `work.warrant` that the effects below move, each by exactly the
 * action §24 names for it.
 *
 * Every one of §67's thirty-two action names is owned here, so the vocabulary is complete on
 * the wire. The evidence group and part of the execution group have no typed projection yet
 * (§84 lists the records); those actions are accepted, audited and replayed like every other,
 * and the ADR says which ones still write nothing typed.
 */

import { ActionRejected, type ActionEffect, type ActionMaterializer } from '@kf/actions';
import type { Tx } from '@kf/database';
import { insertBlocker, resolveBlocker, WARRANT_PROJECTION_EFFECTS } from './projections.js';

export const WARRANT_CONTRACT_ACTIONS = [
  'create_warrant_draft',
  'revise_warrant_draft',
  'submit_warrant',
  'authorize_warrant_contract',
  'withdraw_warrant_proposal',
  'propose_warrant_amendment',
  'authorize_warrant_amendment',
  'reject_warrant_amendment',
] as const;

export const WARRANT_EXECUTION_ACTIONS = [
  'record_warrant_preflight',
  'authorize_warrant_dispatch',
  'attach_warrant_runtime_receipt',
  'register_warrant_submission',
  'open_warrant_blocker',
  'resolve_warrant_blocker',
  'pause_warrant',
  'resume_warrant',
  'propose_warrant_deviation',
  'approve_warrant_deviation',
  'reject_warrant_deviation',
  'record_warrant_discovered_gap',
] as const;

export const WARRANT_EVIDENCE_ACTIONS = [
  'register_warrant_artifact',
  'register_warrant_evidence',
  'attach_warrant_gate_run',
  'record_warrant_inference',
  'record_warrant_judgment',
  'request_warrant_resolution',
] as const;

export const WARRANT_TERMINAL_ACTIONS = [
  'resolve_warrant',
  'dispute_warrant_resolution',
  'resolve_warrant_dispute',
  'annul_warrant_resolution',
  'supersede_warrant',
  'deprecate_warrant',
] as const;

export const WARRANT_ACTION_IDS = [
  ...WARRANT_CONTRACT_ACTIONS,
  ...WARRANT_EXECUTION_ACTIONS,
  ...WARRANT_EVIDENCE_ACTIONS,
  ...WARRANT_TERMINAL_ACTIONS,
] as const;

/** Every §67 action now writes something typed; kept so a reader can grep the claim. */
export const WARRANT_ACTIONS_WITHOUT_TYPED_WRITE = [] as const;

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PROFILES = ['delivery', 'research', 'operations', 'governance'] as const;
const ASSURANCE = ['basic', 'controlled', 'high_assurance'] as const;
const OUTCOMES = [
  'satisfied',
  'not_satisfied',
  'falsified',
  'rejected',
  'withdrawn',
  'cancelled',
  'inconclusive',
] as const;

type Payload = Readonly<Record<string, unknown>> | undefined;

function refuse(message: string, detail: Record<string, unknown> = {}): never {
  throw new ActionRejected('precondition_failed', message, detail);
}

function str(payload: Payload, key: string): string {
  const value = payload?.[key];
  if (typeof value !== 'string' || value.trim() === '') refuse(`${key} is required`);
  return value.trim();
}

function optional(payload: Payload, key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function oneOf<T extends string>(payload: Payload, key: string, values: readonly T[]): T {
  const value = str(payload, key);
  if (!(values as readonly string[]).includes(value)) {
    refuse(`${key} must be one of ${values.join(' | ')}`, { [key]: value });
  }
  return value as T;
}

function sha(payload: Payload, key: string): string {
  const value = str(payload, key).toLowerCase();
  if (!SHA256.test(value)) refuse(`${key} must be a sha256 (64 lowercase hex characters)`);
  return value;
}

function object(payload: Payload, key: string): Readonly<Record<string, unknown>> {
  const value = payload?.[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    refuse(`${key} is required and must be a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

interface WarrantRow extends Record<string, unknown> {
  readonly id: string;
  readonly current_revision_no: number | null;
  readonly authorized_revision_no: number | null;
  readonly execution_condition: string;
  readonly standing: string;
  readonly currency: string;
}

async function warrantOf(
  tx: Tx,
  objects: readonly { readonly id: string; readonly object_type: string }[],
): Promise<WarrantRow> {
  const target = objects.find((o) => o.object_type === 'warrant');
  if (target === undefined) refuse('the action must target the warrant');
  const row = await tx.maybeOne<WarrantRow>(
    `select id, current_revision_no, authorized_revision_no, execution_condition, standing, currency
       from work.warrant where id = $1`,
    [target.id],
  );
  if (row === undefined) refuse('the target is a warrant object without its typed row');
  return row;
}

async function latestRevision(
  tx: Tx,
  warrantId: string,
): Promise<{ revision_no: number; kind: string; contract_digest: string } | undefined> {
  return tx.maybeOne<{ revision_no: number; kind: string; contract_digest: string }>(
    `select revision_no, kind, contract_digest from work.warrant_contract_revision
      where warrant_id = $1 order by revision_no desc limit 1`,
    [warrantId],
  );
}

async function insertRevision(
  tx: Tx,
  input: {
    readonly warrantId: string;
    readonly kind: 'proposed' | 'authorized' | 'amendment_proposed' | 'amendment_rejected';
    readonly contractDigest: string;
    readonly compilationBasis: string;
    readonly canonicalIr: Readonly<Record<string, unknown>>;
    readonly predecessorNo: number | null;
    readonly structuredDifference: Readonly<Record<string, unknown>> | null;
    readonly recordedBy: string;
    readonly actionId: string;
    readonly authorization?: {
      readonly authorizer: string;
      readonly actingRole: string;
      readonly meaning: string;
      readonly policyBasis: string;
      readonly effectiveAt: Date;
    };
  },
): Promise<number> {
  const { next } = await tx.one<{ next: number }>(
    `select coalesce(max(revision_no), 0) + 1 as next from work.warrant_contract_revision
      where warrant_id = $1`,
    [input.warrantId],
  );
  const revisionNo = Number(next);
  await tx.query(
    `insert into work.warrant_contract_revision
       (warrant_id, revision_no, kind, contract_digest, compilation_basis, canonical_ir,
        predecessor_no, structured_difference, recorded_by, recorded_by_action,
        authorizer, acting_role, authorization_meaning, policy_basis, effective_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      input.warrantId,
      revisionNo,
      input.kind,
      input.contractDigest,
      input.compilationBasis,
      JSON.stringify(input.canonicalIr),
      input.predecessorNo,
      input.structuredDifference === null ? null : JSON.stringify(input.structuredDifference),
      input.recordedBy,
      input.actionId,
      input.authorization?.authorizer ?? null,
      input.authorization?.actingRole ?? null,
      input.authorization?.meaning ?? null,
      input.authorization?.policyBasis ?? null,
      input.authorization?.effectiveAt ?? null,
    ],
  );
  return revisionNo;
}

// ── Contract group ────────────────────────────────────────────────────────────────────────

/**
 * `create_warrant_draft` creates the object. The OpenWarrant UUIDv7 IS the object id (§12.2):
 * a Warrant that already exists under that identity is a replay of a different act, refused.
 */
export const createWarrantDraft: ActionMaterializer = async (tx, request) => {
  if (request.targetIds.length > 0) return [];
  const payload = request.payload;
  const warrantUuid = str(payload, 'warrant_uuid').toLowerCase();
  if (!UUID_V7.test(warrantUuid)) refuse('warrant_uuid must be a UUIDv7 (SAS §12.2)');
  const repository = str(payload, 'repository');
  const localAlias = optional(payload, 'local_alias');
  const title = str(payload, 'title');
  const profile = oneOf(payload, 'profile', PROFILES);
  const assuranceLevel = oneOf(payload, 'assurance_level', ASSURANCE);

  const existing = await tx.maybeOne<{ id: string }>('select id from core.object where id = $1', [
    warrantUuid,
  ]);
  if (existing !== undefined) {
    refuse('an object already exists under this warrant_uuid; identity is immutable (SAS §12.2)', {
      warrantUuid,
    });
  }
  const { version } = await tx.one<{ version: string }>(
    'select version from registry.schema_release where is_current',
  );
  await tx.query(
    `insert into core.object
       (id, object_type, authority_domain, lifecycle_state, classification, retention_class,
        schema_version, organization_id, title, created_by, updated_by)
     values ($1, 'warrant', 'project', 'draft', 'internal', 'project_record', $2, $3, $4, $5, $5)`,
    [warrantUuid, version, request.organizationId, title, request.actorId],
  );
  await tx.query(
    `insert into work.warrant (id, warrant_uuid, repository, local_alias, profile, assurance_level)
     values ($1, $1, $2, $3, $4, $5)`,
    [warrantUuid, repository, localAlias ?? null, profile, assuranceLevel],
  );
  return [warrantUuid];
};

/** `revise_warrant_draft`: draft atoms may change before proposal (§28.2); nothing else may. */
export const reviseWarrantDraft: ActionEffect = async (tx, request, objects) => {
  const warrant = await warrantOf(tx, objects);
  const state = objects.find((o) => o.id === warrant.id)!.lifecycle_state;
  if (state !== 'draft')
    refuse('only a draft may be revised in place (SAS §28.2, §28.7)', { state });
  const title = optional(request.payload, 'title');
  const localAlias = optional(request.payload, 'local_alias');
  if (title === undefined && localAlias === undefined) {
    refuse('revise_warrant_draft changes title and/or local_alias; nothing was supplied');
  }
  if (title !== undefined) {
    await tx.query(
      `update core.object set title = $2, row_version = row_version + 1, updated_at = now(),
              updated_by = $3 where id = $1`,
      [warrant.id, title, request.actorId],
    );
  }
  if (localAlias !== undefined) {
    await tx.query('update work.warrant set local_alias = $2 where id = $1', [
      warrant.id,
      localAlias,
    ]);
  }
};

/** `submit_warrant`: the proposal snapshot (§28.3) — an immutable proposed revision. */
export const submitWarrant: ActionEffect = async (tx, request, objects, ctx) => {
  const warrant = await warrantOf(tx, objects);
  const latest = await latestRevision(tx, warrant.id);
  const revisionNo = await insertRevision(tx, {
    warrantId: warrant.id,
    kind: 'proposed',
    contractDigest: sha(request.payload, 'contract_digest'),
    compilationBasis: sha(request.payload, 'compilation_basis'),
    canonicalIr: object(request.payload, 'canonical_ir'),
    predecessorNo: latest?.revision_no ?? null,
    structuredDifference:
      request.payload?.['structured_difference'] === undefined
        ? null
        : object(request.payload, 'structured_difference'),
    recordedBy: request.actorId,
    actionId: ctx.actionId,
  });
  await tx.query('update work.warrant set current_revision_no = $2 where id = $1', [
    warrant.id,
    revisionNo,
  ]);
};

/**
 * `authorize_warrant_contract`: an immutable authorized revision (§28.4) carrying the
 * proposed digest forward with authorizer, role, meaning, policy basis and effective time.
 */
export const authorizeWarrantContract: ActionEffect = async (tx, request, objects, ctx) => {
  const warrant = await warrantOf(tx, objects);
  const latest = await latestRevision(tx, warrant.id);
  if (
    latest === undefined ||
    (latest.kind !== 'proposed' && latest.kind !== 'amendment_proposed')
  ) {
    refuse('nothing is proposed: authorization needs a proposed revision to authorize', {
      latest: latest?.kind ?? null,
    });
  }
  // §28.4: an authorization names what it authorizes. The digest is required, not defaulted —
  // "authorize whatever is latest" is exactly the reading a careless caller would want.
  const expected = sha(request.payload, 'contract_digest');
  if (expected !== latest.contract_digest) {
    refuse('the digest being authorized is not the digest that was proposed', {
      proposed: latest.contract_digest,
      offered: expected,
    });
  }
  const proposed = await tx.one<{
    compilation_basis: string;
    canonical_ir: Record<string, unknown>;
  }>(
    `select compilation_basis, canonical_ir from work.warrant_contract_revision
      where warrant_id = $1 and revision_no = $2`,
    [warrant.id, latest.revision_no],
  );
  const revisionNo = await insertRevision(tx, {
    warrantId: warrant.id,
    kind: 'authorized',
    contractDigest: latest.contract_digest,
    compilationBasis: proposed.compilation_basis,
    canonicalIr: proposed.canonical_ir,
    predecessorNo: latest.revision_no,
    structuredDifference: null,
    recordedBy: request.actorId,
    actionId: ctx.actionId,
    authorization: {
      authorizer: request.actorId,
      actingRole: request.actingRoleId,
      meaning: str(request.payload, 'authorization_meaning'),
      policyBasis: str(request.payload, 'policy_basis'),
      effectiveAt: ctx.effectiveAt,
    },
  });
  await tx.query(
    `update work.warrant set authorized_revision_no = $2, current_revision_no = $2 where id = $1`,
    [warrant.id, revisionNo],
  );
};

/** `withdraw_warrant_proposal`: back to draft; the proposed revision stays as history. */
export const withdrawWarrantProposal: ActionEffect = async (tx, _request, objects) => {
  const warrant = await warrantOf(tx, objects);
  await tx.query(
    `update work.warrant set current_revision_no = authorized_revision_no where id = $1`,
    [warrant.id],
  );
};

/** `propose_warrant_amendment`: a proposed revision against the authorized one (§28.6). */
export const proposeWarrantAmendment: ActionEffect = async (tx, request, objects, ctx) => {
  const warrant = await warrantOf(tx, objects);
  if (warrant.authorized_revision_no === null) {
    refuse('an amendment proposes a change to an AUTHORIZED contract; none is authorized yet');
  }
  const revisionNo = await insertRevision(tx, {
    warrantId: warrant.id,
    kind: 'amendment_proposed',
    contractDigest: sha(request.payload, 'contract_digest'),
    compilationBasis: sha(request.payload, 'compilation_basis'),
    canonicalIr: object(request.payload, 'canonical_ir'),
    predecessorNo: warrant.authorized_revision_no,
    structuredDifference: object(request.payload, 'structured_difference'),
    recordedBy: request.actorId,
    actionId: ctx.actionId,
  });
  await tx.query('update work.warrant set current_revision_no = $2 where id = $1', [
    warrant.id,
    revisionNo,
  ]);
};

/** `reject_warrant_amendment`: recorded as a revision of its own; the authorized one stands. */
export const rejectWarrantAmendment: ActionEffect = async (tx, request, objects, ctx) => {
  const warrant = await warrantOf(tx, objects);
  const latest = await latestRevision(tx, warrant.id);
  if (latest === undefined || latest.kind !== 'amendment_proposed') {
    refuse('no amendment is proposed', { latest: latest?.kind ?? null });
  }
  const proposed = await tx.one<{
    compilation_basis: string;
    canonical_ir: Record<string, unknown>;
  }>(
    `select compilation_basis, canonical_ir from work.warrant_contract_revision
      where warrant_id = $1 and revision_no = $2`,
    [warrant.id, latest.revision_no],
  );
  await insertRevision(tx, {
    warrantId: warrant.id,
    kind: 'amendment_rejected',
    contractDigest: latest.contract_digest,
    compilationBasis: proposed.compilation_basis,
    canonicalIr: proposed.canonical_ir,
    predecessorNo: latest.revision_no,
    structuredDifference: { rejection_reason: str(request.payload, 'rejection_reason') },
    recordedBy: request.actorId,
    actionId: ctx.actionId,
  });
  await tx.query(
    `update work.warrant set current_revision_no = authorized_revision_no where id = $1`,
    [warrant.id],
  );
};

// ── Condition (§24.2), outcome (§24.3), currency (§24.4), standing (§24.5) ───────────────

/** §24.7: blocking and pausing overlay these phases and no other. */
const OVERLAY_PHASES = ['authorized', 'ready', 'executing', 'verifying'] as const;

function requireOverlayPhase(
  objects: readonly { readonly id: string; readonly lifecycle_state: string }[],
  warrantId: string,
): void {
  const phase = objects.find((o) => o.id === warrantId)?.lifecycle_state ?? 'unknown';
  if (!(OVERLAY_PHASES as readonly string[]).includes(phase)) {
    refuse(`a warrant in phase '${phase}' cannot be blocked or paused (SAS §24.7)`, { phase });
  }
}

// The column is one of four literals fixed at the call sites below; nothing from a request
// reaches this template.
function setColumn(column: 'execution_condition' | 'outcome' | 'currency' | 'standing') {
  return async (tx: Tx, warrantId: string, value: string): Promise<void> => {
    await tx.query(`update work.warrant set ${column} = $2 where id = $1`, [warrantId, value]);
  };
}
const setCondition = setColumn('execution_condition');
const setOutcome = setColumn('outcome');
const setCurrency = setColumn('currency');
const setStanding = setColumn('standing');

export const openWarrantBlocker: ActionEffect = async (tx, request, objects, ctx) => {
  const warrant = await warrantOf(tx, objects);
  requireOverlayPhase(objects, warrant.id);
  await insertBlocker(tx, warrant.id, request, ctx.actionId);
  await setCondition(tx, warrant.id, 'blocked');
};
export const resolveWarrantBlocker: ActionEffect = async (tx, request, objects, ctx) => {
  const warrant = await warrantOf(tx, objects);
  if (warrant.execution_condition !== 'blocked') refuse('the warrant is not blocked');
  await resolveBlocker(tx, warrant.id, request, ctx.actionId);
  const open = await tx.one<{ count: string }>(
    `select count(*)::text as count from work.warrant_blocker where warrant_id = $1 and resolved_at is null`,
    [warrant.id],
  );
  // The condition clears when the LAST open blocker does.
  if (Number(open.count) === 0) await setCondition(tx, warrant.id, 'clear');
};
export const pauseWarrant: ActionEffect = async (tx, _request, objects) => {
  const warrant = await warrantOf(tx, objects);
  requireOverlayPhase(objects, warrant.id);
  if (warrant.execution_condition !== 'clear') {
    refuse(`cannot pause while ${warrant.execution_condition}`);
  }
  await setCondition(tx, warrant.id, 'paused');
};
export const resumeWarrant: ActionEffect = async (tx, _request, objects) => {
  const warrant = await warrantOf(tx, objects);
  if (warrant.execution_condition !== 'paused') refuse('the warrant is not paused');
  await setCondition(tx, warrant.id, 'clear');
};

export const resolveWarrant: ActionEffect = async (tx, request, objects) => {
  const warrant = await warrantOf(tx, objects);
  await setOutcome(tx, warrant.id, oneOf(request.payload, 'outcome', OUTCOMES));
};
export const disputeWarrantResolution: ActionEffect = async (tx, request, objects) => {
  const warrant = await warrantOf(tx, objects);
  if (warrant.standing !== 'valid') refuse(`standing is already ${warrant.standing}`);
  str(request.payload, 'dispute');
  await setStanding(tx, warrant.id, 'disputed');
};
export const resolveWarrantDispute: ActionEffect = async (tx, _request, objects) => {
  const warrant = await warrantOf(tx, objects);
  if (warrant.standing !== 'disputed') refuse('no dispute is open');
  await setStanding(tx, warrant.id, 'valid');
};
export const annulWarrantResolution: ActionEffect = async (tx, request, objects) => {
  const warrant = await warrantOf(tx, objects);
  str(request.payload, 'annulment_basis');
  // §24.6: the original outcome remains; standing records that reliance is withdrawn.
  await setStanding(tx, warrant.id, 'annulled');
};
export const supersedeWarrant: ActionEffect = async (tx, request, objects) => {
  const warrant = await warrantOf(tx, objects);
  const successor = str(request.payload, 'superseded_by').toLowerCase();
  if (!UUID_V7.test(successor) || successor === warrant.id)
    refuse('superseded_by must name another warrant');
  const exists = await tx.maybeOne<{ id: string; currency: string }>(
    'select id, currency from work.warrant where id = $1',
    [successor],
  );
  if (exists === undefined)
    refuse('superseded_by names no warrant visible to this caller', { successor });
  if (exists.currency !== 'current') {
    refuse(`superseded_by names a warrant that is itself ${exists.currency}`, { successor });
  }
  await tx.query(
    `update work.warrant set currency = 'superseded', superseded_by = $2 where id = $1`,
    [warrant.id, successor],
  );
};
export const deprecateWarrant: ActionEffect = async (tx, _request, objects) => {
  const warrant = await warrantOf(tx, objects);
  await setCurrency(tx, warrant.id, 'deprecated');
};

export const WARRANT_MATERIALIZERS: Readonly<Record<string, ActionMaterializer>> = {
  create_warrant_draft: createWarrantDraft,
};

export const WARRANT_EFFECTS: Readonly<Record<string, ActionEffect>> = {
  ...WARRANT_PROJECTION_EFFECTS,
  revise_warrant_draft: reviseWarrantDraft,
  submit_warrant: submitWarrant,
  authorize_warrant_contract: authorizeWarrantContract,
  withdraw_warrant_proposal: withdrawWarrantProposal,
  propose_warrant_amendment: proposeWarrantAmendment,
  authorize_warrant_amendment: authorizeWarrantContract,
  reject_warrant_amendment: rejectWarrantAmendment,
  open_warrant_blocker: openWarrantBlocker,
  resolve_warrant_blocker: resolveWarrantBlocker,
  pause_warrant: pauseWarrant,
  resume_warrant: resumeWarrant,
  resolve_warrant: resolveWarrant,
  dispute_warrant_resolution: disputeWarrantResolution,
  resolve_warrant_dispute: resolveWarrantDispute,
  annul_warrant_resolution: annulWarrantResolution,
  supersede_warrant: supersedeWarrant,
  deprecate_warrant: deprecateWarrant,
};

export const PACKAGE = {
  name: '@kf/warrants',
  role: 'OpenWarrant SAS §67 controlled actions',
  owns: [],
} as const;
