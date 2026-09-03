/**
 * The §84 typed projections — one effect per §67 action that was, until now, audit-only.
 *
 * Each effect validates the payload against the shape OpenWarrant's own struct declares and
 * writes one row into the table the migration `20260902000500_warrant_projections.sql`
 * shaped for it. Nothing is derived here: what OpenWarrant computed (digests, refs,
 * outcomes) is recorded as it came, under the act that brought it.
 */

import { ActionRejected, type ActionEffect } from '@kf/actions';
import type { Tx } from '@kf/database';

type Payload = Readonly<Record<string, unknown>> | undefined;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function refuse(message: string, detail: Record<string, unknown> = {}): never {
  throw new ActionRejected('precondition_failed', message, detail);
}
function str(payload: Payload, key: string): string {
  const value = payload?.[key];
  if (typeof value !== 'string' || value.trim() === '') refuse(`${key} is required`);
  return value.trim();
}
function optional(payload: Payload, key: string): string | null {
  const value = payload?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
function sha(payload: Payload, key: string): string {
  const value = str(payload, key).toLowerCase();
  if (!SHA256.test(value)) refuse(`${key} must be a sha256`);
  return value;
}
function optionalSha(payload: Payload, key: string): string | null {
  const value = optional(payload, key);
  if (value === null) return null;
  if (!SHA256.test(value.toLowerCase())) refuse(`${key} must be a sha256`);
  return value.toLowerCase();
}
function strings(payload: Payload, key: string, minimum = 0): string[] {
  const value = payload?.[key] ?? [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.trim() === '')) {
    refuse(`${key} must be an array of non-empty strings`);
  }
  if (value.length < minimum)
    refuse(`${key} needs at least ${String(minimum)} entr${minimum === 1 ? 'y' : 'ies'}`);
  return (value as string[]).map((v) => v.trim());
}
function object(payload: Payload, key: string): Readonly<Record<string, unknown>> {
  const value = payload?.[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    refuse(`${key} is required and must be a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}
function oneOf<T extends string>(payload: Payload, key: string, values: readonly T[]): T {
  const value = str(payload, key);
  if (!(values as readonly string[]).includes(value)) {
    refuse(`${key} must be one of ${values.join(' | ')}`, { [key]: value });
  }
  return value as T;
}
function bool(payload: Payload, key: string, fallback: boolean): boolean {
  const value = payload?.[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') refuse(`${key} must be a boolean`);
  return value;
}
function instant(payload: Payload, key: string): Date {
  const value = str(payload, key);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) refuse(`${key} must be a timestamp`);
  return date;
}

function warrantId(
  objects: readonly { readonly id: string; readonly object_type: string }[],
): string {
  const target = objects.find((o) => o.object_type === 'warrant');
  if (target === undefined) refuse('the action must target the warrant');
  return target.id;
}

/** Map a unique-violation on (warrant, ref) to a refusal that names the duplicate. */
async function insertOnce(
  tx: Tx,
  label: string,
  ref: string,
  sql: string,
  params: unknown[],
): Promise<void> {
  try {
    await tx.query(sql, params);
  } catch (error: unknown) {
    const code = (error as { code?: string }).code;
    if (code === '23505') {
      refuse(`${label} '${ref}' is already recorded on this warrant`, { ref });
    }
    // 23503 foreign key, 23514 check: a payload naming a classification, retention class or
    // role the registry does not have is a fact about the request, refused by the database's
    // own wording rather than surfacing as an internal error. Existence of an artifact
    // version is checked earlier only because that column is nullable and the caller needs to
    // hear which of the two it got wrong.
    if (code === '23503' || code === '23514') {
      refuse(`${label} '${ref}': ${(error as Error).message}`, { ref });
    }
    throw error;
  }
}

// ── execution group ───────────────────────────────────────────────────────────────────────

/** §32: the preflight receipt — outcomes per check and the readiness they derive. */
export const recordWarrantPreflight: ActionEffect = async (tx, request, objects, ctx) => {
  const warrant = warrantId(objects);
  const outcomes = object(request.payload, 'outcomes');
  const readiness = oneOf(request.payload, 'readiness', ['ready', 'not_ready'] as const);
  const digest = sha(request.payload, 'receipt_digest');
  await insertOnce(
    tx,
    'preflight',
    digest,
    `insert into work.warrant_preflight
       (warrant_id, receipt_digest, outcomes, readiness, performed_at, recorded_by, recorded_by_action)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      warrant,
      digest,
      JSON.stringify(outcomes),
      readiness,
      instant(request.payload, 'performed_at'),
      request.actorId,
      ctx.actionId,
    ],
  );
};

/** Dispatch authorization: what was dispatched, to whom, under which authorized revision. */
export const authorizeWarrantDispatch: ActionEffect = async (tx, request, objects, ctx) => {
  const warrant = warrantId(objects);
  const row = await tx.one<{ authorized_revision_no: number | null }>(
    'select authorized_revision_no from work.warrant where id = $1',
    [warrant],
  );
  if (row.authorized_revision_no === null) refuse('nothing is authorized to dispatch');
  const digest = sha(request.payload, 'dispatch_digest');
  await insertOnce(
    tx,
    'dispatch',
    digest,
    `insert into work.warrant_dispatch
       (warrant_id, dispatch_digest, performer_ref, authorized_revision, authorized_by, acting_role, recorded_by_action)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      warrant,
      digest,
      str(request.payload, 'performer_ref'),
      row.authorized_revision_no,
      request.actorId,
      request.actingRoleId,
      ctx.actionId,
    ],
  );
};

/** §85: a runtime receipt bound to the dispatch it answers. */
export const attachWarrantRuntimeReceipt: ActionEffect = async (tx, request, objects, ctx) => {
  const warrant = warrantId(objects);
  const adapter = oneOf(request.payload, 'adapter', [
    'oh.war/katana-receipt/v1',
    'oh.war/blut-receipt/v1',
    'oh.war/liminal-compilation-receipt/v1',
    'oh.war/gate-run-receipt/v1',
  ] as const);
  const dispatch = sha(request.payload, 'dispatch_digest');
  const known = await tx.maybeOne<{ id: string }>(
    'select id from work.warrant_dispatch where warrant_id = $1 and dispatch_digest = $2',
    [warrant, dispatch],
  );
  if (known === undefined)
    refuse('the receipt answers no dispatch recorded on this warrant', { dispatch });
  const digest = sha(request.payload, 'receipt_digest');
  await insertOnce(
    tx,
    'runtime receipt',
    digest,
    `insert into work.warrant_runtime_receipt
       (warrant_id, adapter, dispatch_digest, receipt_digest, terminal_status, artifact_refs, receipt, recorded_by, recorded_by_action)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      warrant,
      adapter,
      dispatch,
      digest,
      str(request.payload, 'terminal_status'),
      strings(request.payload, 'artifact_refs'),
      JSON.stringify(object(request.payload, 'receipt')),
      request.actorId,
      ctx.actionId,
    ],
  );
};

/** §37.4: the performer's claim envelope. */
export const registerWarrantSubmission: ActionEffect = async (tx, request, objects, ctx) => {
  const warrant = warrantId(objects);
  const ref = str(request.payload, 'submission_ref');
  await insertOnce(
    tx,
    'submission',
    ref,
    `insert into work.warrant_submission
       (warrant_id, submission_ref, artifact_refs, blocker_refs, deviation_refs, requested_next_action, declared_as_deliverable, recorded_by, recorded_by_action)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      warrant,
      ref,
      strings(request.payload, 'artifact_refs'),
      strings(request.payload, 'blocker_refs'),
      strings(request.payload, 'deviation_refs'),
      str(request.payload, 'requested_next_action'),
      bool(request.payload, 'declared_as_deliverable', false),
      request.actorId,
      ctx.actionId,
    ],
  );
};

/** §53.1: the blocker row that `open_warrant_blocker` opens beside setting the condition. */
export async function insertBlocker(
  tx: Tx,
  warrant: string,
  request: { readonly payload?: Payload; readonly actorId: string },
  actionId: string,
): Promise<void> {
  const ref = str(request.payload, 'blocker_ref');
  await insertOnce(
    tx,
    'blocker',
    ref,
    `insert into work.warrant_blocker
       (warrant_id, blocker_ref, condition_ref, reason, owner_ref, required_to_unblock, opened_by, opened_by_action)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      warrant,
      ref,
      str(request.payload, 'condition_ref'),
      str(request.payload, 'reason'),
      str(request.payload, 'owner_ref'),
      str(request.payload, 'required_to_unblock'),
      request.actorId,
      actionId,
    ],
  );
}

/** §53.1 / §24.7: resolving names the blocker and says whether the basis changed. */
export async function resolveBlocker(
  tx: Tx,
  warrant: string,
  request: { readonly payload?: Payload; readonly actorId: string },
  actionId: string,
): Promise<void> {
  const ref = str(request.payload, 'blocker_ref');
  const resolved = await tx.query<{ id: string }>(
    `update work.warrant_blocker
        set resolved_at = now(), resolved_by = $3, resolved_by_action = $4, resolution = $5, basis_changed = $6
      where warrant_id = $1 and blocker_ref = $2 and resolved_at is null
      returning id`,
    [
      warrant,
      ref,
      request.actorId,
      actionId,
      str(request.payload, 'resolution'),
      bool(request.payload, 'basis_changed', false),
    ],
  );
  if (resolved.length === 0) refuse(`no open blocker '${ref}' on this warrant`, { ref });
}

/** §53.2: a deviation is proposed with its impact stated. */
export const proposeWarrantDeviation: ActionEffect = async (tx, request, objects, ctx) => {
  const warrant = warrantId(objects);
  const ref = str(request.payload, 'deviation_ref');
  const path = str(request.payload, 'affected_contract_path');
  if (!path.startsWith('/'))
    refuse('affected_contract_path must be a contract path starting with /');
  await insertOnce(
    tx,
    'deviation',
    ref,
    `insert into work.warrant_deviation
       (warrant_id, deviation_ref, affected_contract_path, proposed_change, reason, impact, proposed_by, proposed_by_action)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      warrant,
      ref,
      path,
      JSON.stringify(object(request.payload, 'proposed_change')),
      str(request.payload, 'reason'),
      JSON.stringify(object(request.payload, 'impact')),
      request.actorId,
      ctx.actionId,
    ],
  );
};

function decideDeviation(disposition: 'approved' | 'rejected'): ActionEffect {
  return async (tx, request, objects, ctx) => {
    const warrant = warrantId(objects);
    const ref = str(request.payload, 'deviation_ref');
    const decided = await tx.query<{ id: string }>(
      `update work.warrant_deviation
          set disposition = $3, decided_by = $4, decided_by_action = $5, decided_at = now(), decision_reason = $6
        where warrant_id = $1 and deviation_ref = $2 and disposition = 'proposed'
        returning id`,
      [
        warrant,
        ref,
        disposition,
        request.actorId,
        ctx.actionId,
        str(request.payload, 'decision_reason'),
      ],
    );
    if (decided.length === 0) refuse(`no proposed deviation '${ref}' on this warrant`, { ref });
  };
}
export const approveWarrantDeviation = decideDeviation('approved');
export const rejectWarrantDeviation = decideDeviation('rejected');

/** §53.4: a discovered gap, never repaired in place. */
export const recordWarrantDiscoveredGap: ActionEffect = async (tx, request, objects, ctx) => {
  const warrant = warrantId(objects);
  if (bool(request.payload, 'repaired_in_place', false)) {
    refuse('a discovered gap is not silently repaired (SAS §53.4); disposition it instead');
  }
  const ref = str(request.payload, 'gap_ref');
  const disposition = optional(request.payload, 'disposition');
  if (
    disposition !== null &&
    !['clarification', 'amendment', 'adr', 'child_warrant', 'supersession'].includes(disposition)
  ) {
    refuse('disposition must be clarification | amendment | adr | child_warrant | supersession');
  }
  await insertOnce(
    tx,
    'discovered gap',
    ref,
    `insert into work.warrant_discovered_gap
       (warrant_id, gap_ref, statement, under_specified, disposition, recorded_by, recorded_by_action)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      warrant,
      ref,
      str(request.payload, 'statement'),
      oneOf(request.payload, 'under_specified', [
        'contract',
        'sas',
        'adr',
        'gate',
        'source',
      ] as const),
      disposition,
      request.actorId,
      ctx.actionId,
    ],
  );
};

// ── evidence group ────────────────────────────────────────────────────────────────────────

/** §37.2: artifact provenance, every field the SAS lists. */
export const registerWarrantArtifact: ActionEffect = async (tx, request, objects, ctx) => {
  const warrant = warrantId(objects);
  const ref = str(request.payload, 'artifact_ref');
  const versionId = optional(request.payload, 'artifact_version_id');
  if (versionId !== null) {
    if (!UUID_V7.test(versionId) && !/^[0-9a-f-]{36}$/.test(versionId))
      refuse('artifact_version_id must be a uuid');
    const known = await tx.maybeOne<{ id: string }>(
      'select id from content.artifact_version where id = $1',
      [versionId],
    );
    if (known === undefined) refuse('artifact_version_id names no version visible to this caller');
  }
  await insertOnce(
    tx,
    'artifact',
    ref,
    `insert into work.warrant_artifact
       (warrant_id, artifact_ref, producer_ref, producing_attempt, contract_digest, input_digests, tool_identity, creation_method,
        content_digest, media_type, classification, retention_class, source_holder, artifact_version_id, recorded_by, recorded_by_action)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      warrant,
      ref,
      str(request.payload, 'producer_ref'),
      str(request.payload, 'producing_attempt'),
      sha(request.payload, 'contract_digest'),
      strings(request.payload, 'input_digests').map((d) => {
        if (!SHA256.test(d.toLowerCase())) refuse('input_digests must be sha256s');
        return d.toLowerCase();
      }),
      str(request.payload, 'tool_identity'),
      str(request.payload, 'creation_method'),
      sha(request.payload, 'content_digest'),
      str(request.payload, 'media_type'),
      str(request.payload, 'classification'),
      str(request.payload, 'retention_class'),
      oneOf(request.payload, 'source_holder', [
        'git',
        'fabric_native',
        'external',
        'generated_projection',
        'runtime_receipt',
      ] as const),
      versionId,
      request.actorId,
      ctx.actionId,
    ],
  );
};

/** §40.2 / §41: an evidence item; occurred_at is the actor's, recorded_at is ours. */
export const registerWarrantEvidence: ActionEffect = async (tx, request, objects, ctx) => {
  const warrant = warrantId(objects);
  const ref = str(request.payload, 'evidence_ref');
  const occurred = optional(request.payload, 'occurred_at');
  const occurredAt = occurred === null ? null : instant(request.payload, 'occurred_at');
  await insertOnce(
    tx,
    'evidence',
    ref,
    `insert into work.warrant_evidence
       (warrant_id, evidence_ref, kind, origin, admissibility, content_digest, collection_method, occurred_at, recorded_by, recorded_by_action)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      warrant,
      ref,
      str(request.payload, 'kind'),
      str(request.payload, 'origin'),
      str(request.payload, 'admissibility'),
      optionalSha(request.payload, 'content_digest'),
      optional(request.payload, 'collection_method'),
      occurredAt,
      request.actorId,
      ctx.actionId,
    ],
  );
};

/** §44.6: a gate receipt with the definition and binding digests it ran under. */
export const attachWarrantGateRun: ActionEffect = async (tx, request, objects, ctx) => {
  const warrant = warrantId(objects);
  const ref = str(request.payload, 'gate_run_ref');
  await insertOnce(
    tx,
    'gate run',
    ref,
    `insert into work.warrant_gate_run
       (warrant_id, gate_run_ref, gate_ref, definition_digest, binding_digest, execution_status, verdict, reason_code, receipt_digest, receipt, recorded_by, recorded_by_action)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      warrant,
      ref,
      str(request.payload, 'gate_ref'),
      sha(request.payload, 'definition_digest'),
      sha(request.payload, 'binding_digest'),
      str(request.payload, 'execution_status'),
      str(request.payload, 'verdict'),
      optional(request.payload, 'reason_code'),
      sha(request.payload, 'receipt_digest'),
      JSON.stringify(object(request.payload, 'receipt')),
      request.actorId,
      ctx.actionId,
    ],
  );
};

/** §40.4: an inference names its premises and the claim it bears on. */
export const recordWarrantInference: ActionEffect = async (tx, request, objects, ctx) => {
  const warrant = warrantId(objects);
  const ref = str(request.payload, 'inference_ref');
  await insertOnce(
    tx,
    'inference',
    ref,
    `insert into work.warrant_inference
       (warrant_id, inference_ref, kind, statement, premise_refs, claim_ref, recorded_by, recorded_by_action)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      warrant,
      ref,
      str(request.payload, 'kind'),
      str(request.payload, 'statement'),
      strings(request.payload, 'premise_refs', 1),
      str(request.payload, 'claim_ref'),
      request.actorId,
      ctx.actionId,
    ],
  );
};

/** §40.5: a judgment is the act's actor and role, never a payload claim about who judged. */
export const recordWarrantJudgment: ActionEffect = async (tx, request, objects, ctx) => {
  const warrant = warrantId(objects);
  const ref = str(request.payload, 'judgment_ref');
  await insertOnce(
    tx,
    'judgment',
    ref,
    `insert into work.warrant_judgment
       (warrant_id, judgment_ref, kind, statement, meaning, basis_refs, authority, limitations, actor, acting_role, recorded_by_action)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      warrant,
      ref,
      str(request.payload, 'kind'),
      str(request.payload, 'statement'),
      str(request.payload, 'meaning'),
      strings(request.payload, 'basis_refs', 1),
      str(request.payload, 'authority'),
      strings(request.payload, 'limitations'),
      request.actorId,
      request.actingRoleId,
      ctx.actionId,
    ],
  );
};

/** A request that the warrant be resolved with a stated outcome on stated basis. */
export const requestWarrantResolution: ActionEffect = async (tx, request, objects, ctx) => {
  const warrant = warrantId(objects);
  await tx.query(
    `insert into work.warrant_resolution_request (warrant_id, requested_outcome, basis_refs, recorded_by, recorded_by_action)
     values ($1,$2,$3,$4,$5)`,
    [
      warrant,
      oneOf(request.payload, 'requested_outcome', [
        'satisfied',
        'not_satisfied',
        'falsified',
        'rejected',
        'withdrawn',
        'cancelled',
        'inconclusive',
      ] as const),
      strings(request.payload, 'basis_refs', 1),
      request.actorId,
      ctx.actionId,
    ],
  );
};

export const WARRANT_PROJECTION_EFFECTS: Readonly<Record<string, ActionEffect>> = {
  record_warrant_preflight: recordWarrantPreflight,
  authorize_warrant_dispatch: authorizeWarrantDispatch,
  attach_warrant_runtime_receipt: attachWarrantRuntimeReceipt,
  register_warrant_submission: registerWarrantSubmission,
  propose_warrant_deviation: proposeWarrantDeviation,
  approve_warrant_deviation: approveWarrantDeviation,
  reject_warrant_deviation: rejectWarrantDeviation,
  record_warrant_discovered_gap: recordWarrantDiscoveredGap,
  register_warrant_artifact: registerWarrantArtifact,
  register_warrant_evidence: registerWarrantEvidence,
  attach_warrant_gate_run: attachWarrantGateRun,
  record_warrant_inference: recordWarrantInference,
  record_warrant_judgment: recordWarrantJudgment,
  request_warrant_resolution: requestWarrantResolution,
};
