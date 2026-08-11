/**
 * Configuration control, quality records and verification, as typed actions.
 *
 * The same shape as work control, for the same reason: a record created by a direct insert
 * has no actor, no authority and no audit event, and a quality system whose records can
 * appear that way is a quality system in name.
 *
 * The preconditions here are the ones a regulator asks about. Not "did you fill in the
 * field" — the database handles that — but "did you decide before you closed it", which is
 * the question a closed record with a blank disposition cannot answer.
 */

import {
  ActionRejected,
  type ActionEffect,
  type ActionMaterializer,
  type PreconditionCheck,
} from '@kf/actions';
import type { Tx } from '@kf/database';
import { createControlledObject, optionalString, requireString } from '@kf/work-control';

function refuse(rule: string, message: string, detail: Record<string, unknown> = {}): never {
  throw new ActionRejected('precondition_failed', `${rule}: ${message}`, { rule, ...detail });
}

// ── configuration ───────────────────────────────────────────────────────────────────────

/**
 * A configuration item is DEFINED and PROMOTED by the same action.
 *
 * The same shape as `create_work_package`: the record is born in `proposed` and the action
 * that created it moves it to `active`. Splitting the two would leave a proposed item that
 * no action can advance, because nothing else drives that transition.
 */
const promoteConfigurationItem: ActionMaterializer = async (tx, request) => {
  if (request.targetIds.length > 0) return [];
  const id = await createControlledObject(tx, {
    objectType: 'configuration_item',
    authorityDomain: 'configuration',
    lifecycleState: 'proposed',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into product.configuration_item
       (id, item_kind, part_number, revision_label, parent_system)
     values ($1,$2,$3,$4,$5)`,
    [
      id,
      requireString(request.payload, 'item_kind'),
      requireString(request.payload, 'part_number'),
      requireString(request.payload, 'revision_label'),
      requireString(request.payload, 'parent_system'),
    ],
  );
  return [id];
};

const publishInterfaceContract: ActionMaterializer = async (tx, request) => {
  if (request.targetIds.length > 0) return [];
  const id = await createControlledObject(tx, {
    objectType: 'interface_contract',
    authorityDomain: 'configuration',
    lifecycleState: 'draft',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into product.interface_contract
       (id, interface_kind, generation, provider, consumer, specification)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      id,
      requireString(request.payload, 'interface_kind'),
      // The GENERATION, which is what conformance is scoped to. A revision changes without
      // renegotiating the interface; naming one here would expire every conformance claim on
      // the next rework.
      requireString(request.payload, 'generation'),
      requireString(request.payload, 'provider'),
      optionalString(request.payload, 'consumer'),
      requireString(request.payload, 'specification'),
    ],
  );
  return [id];
};

const recordPhysicalBinding: ActionMaterializer = async (tx, request) => {
  if (request.targetIds.length > 0) return [];
  const id = await createControlledObject(tx, {
    objectType: 'physical_binding',
    authorityDomain: 'configuration',
    lifecycleState: 'planned',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into product.physical_binding
       (id, configuration_item, serial_number, installed_on, location)
     values ($1,$2,$3, now(), $4)`,
    [
      id,
      requireString(request.payload, 'configuration_item'),
      requireString(request.payload, 'serial_number'),
      optionalString(request.payload, 'location'),
    ],
  );
  return [id];
};

// ── quality records ─────────────────────────────────────────────────────────────────────

const submitDocumentForReview: ActionMaterializer = async (tx, request) => {
  if (request.targetIds.length > 0) return [];
  const id = await createControlledObject(tx, {
    objectType: 'controlled_document',
    authorityDomain: 'qms',
    lifecycleState: 'draft',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into quality.controlled_document
       (id, document_class, document_number, revision, owning_role, content_version)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      id,
      requireString(request.payload, 'document_class'),
      requireString(request.payload, 'document_number'),
      requireString(request.payload, 'revision'),
      requireString(request.payload, 'owning_role'),
      optionalString(request.payload, 'content_version'),
    ],
  );
  return [id];
};

const raiseNonconformity: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'nonconformity',
    authorityDomain: 'qms',
    lifecycleState: 'open',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into quality.nonconformity (id, severity, detected_on, description, subject_id)
     values ($1,$2, now(), $3, $4)`,
    [
      id,
      requireString(request.payload, 'severity'),
      requireString(request.payload, 'description'),
      optionalString(request.payload, 'subject_id'),
    ],
  );
  return [id];
};

const openCapa: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'capa',
    authorityDomain: 'qms',
    lifecycleState: 'open',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into quality.capa
       (id, capa_kind, problem_statement, effectiveness_criterion)
     values ($1,$2,$3,$4)`,
    [
      id,
      requireString(request.payload, 'capa_kind'),
      requireString(request.payload, 'problem_statement'),
      // Agreed BEFORE the work starts. A CAPA whose effectiveness criterion is written at
      // the end is a CAPA that always succeeds.
      requireString(request.payload, 'effectiveness_criterion'),
    ],
  );

  const answers = request.payload?.['nonconformities'];
  if (Array.isArray(answers)) {
    for (const ncId of answers) {
      await tx.query(
        'insert into quality.capa_nonconformity (capa_id, nonconformity_id) values ($1,$2)',
        [id, ncId],
      );
    }
  }
  return [id];
};

const registerSupplier: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'supplier',
    authorityDomain: 'qms',
    lifecycleState: 'prospective',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into quality.supplier (id, organization, criticality, scope_of_supply)
     values ($1,$2,$3,$4)`,
    [
      id,
      requireString(request.payload, 'organization'),
      requireString(request.payload, 'criticality'),
      requireString(request.payload, 'scope_of_supply'),
    ],
  );
  return [id];
};

const registerEquipment: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'equipment',
    authorityDomain: 'qms',
    lifecycleState: 'in_service',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into quality.equipment (id, asset_number, equipment_kind, calibration_due, location)
     values ($1,$2,$3,$4,$5)`,
    [
      id,
      requireString(request.payload, 'asset_number'),
      requireString(request.payload, 'equipment_kind'),
      optionalString(request.payload, 'calibration_due'),
      optionalString(request.payload, 'location'),
    ],
  );
  return [id];
};

const receiveComplaint: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'complaint',
    authorityDomain: 'qms',
    lifecycleState: 'received',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
    classification: 'restricted',
  });
  await tx.query(
    `insert into quality.complaint (id, received_on, summary, reporter_reference, affected_binding)
     values ($1, now(), $2, $3, $4)`,
    [
      id,
      requireString(request.payload, 'summary'),
      // A reference, never a name or contact details: identifying a person here would put
      // personal data into a system with no lawful basis to hold it.
      optionalString(request.payload, 'reporter_reference'),
      optionalString(request.payload, 'affected_binding'),
    ],
  );
  return [id];
};

// ── verification ────────────────────────────────────────────────────────────────────────

const proposeRiskControl: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'risk_control',
    authorityDomain: 'engineering',
    lifecycleState: 'proposed',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into engineering.risk_control (id, control_kind, mitigates, description)
     values ($1,$2,$3,$4)`,
    [
      id,
      requireString(request.payload, 'control_kind'),
      requireString(request.payload, 'mitigates'),
      requireString(request.payload, 'description'),
    ],
  );
  return [id];
};

const defineTest: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'test_definition',
    authorityDomain: 'engineering',
    lifecycleState: 'draft',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into engineering.test_definition
       (id, method_kind, acceptance_criterion, verifies, procedure_version)
     values ($1,$2,$3,$4,$5)`,
    [
      id,
      requireString(request.payload, 'method_kind'),
      requireString(request.payload, 'acceptance_criterion'),
      requireString(request.payload, 'verifies'),
      optionalString(request.payload, 'procedure_version'),
    ],
  );
  return [id];
};

const planTestExecution: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'test_execution',
    authorityDomain: 'engineering',
    lifecycleState: 'planned',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into engineering.test_execution (id, test_definition, configuration_item)
     values ($1,$2,$3)`,
    [
      id,
      requireString(request.payload, 'test_definition'),
      optionalString(request.payload, 'configuration_item'),
    ],
  );
  return [id];
};

export const PRODUCT_QUALITY_MATERIALIZERS: Readonly<Record<string, ActionMaterializer>> = {
  promote_configuration_item: promoteConfigurationItem,
  publish_interface_contract: publishInterfaceContract,
  record_physical_binding: recordPhysicalBinding,
  submit_document_for_review: submitDocumentForReview,
  raise_nonconformity: raiseNonconformity,
  open_capa: openCapa,
  register_supplier: registerSupplier,
  register_equipment: registerEquipment,
  receive_complaint: receiveComplaint,
  propose_risk_control: proposeRiskControl,
  define_test: defineTest,
  plan_test_execution: planTestExecution,
};

// ── effects ─────────────────────────────────────────────────────────────────────────────

/** Running the test: what was used, when, and on which build. */
const executeTest: ActionEffect = async (tx, request, objects) => {
  const execution = objects.find((o) => o.object_type === 'test_execution');
  if (execution === undefined) refuse('KF-VER-001', 'execute_test must name a test execution');

  await tx.query(
    `update engineering.test_execution
        set executed_on = now(), executed_by = $2, configuration_item = coalesce($3, configuration_item)
      where id = $1`,
    [execution.id, request.actorId, optionalString(request.payload, 'configuration_item')],
  );

  const equipment = request.payload?.['equipment'];
  if (Array.isArray(equipment)) {
    for (const equipmentId of equipment) {
      // Recorded so an expired calibration is actionable later: given equipment found out of
      // tolerance, this is how you find every result it produced.
      await tx.query(
        'insert into engineering.test_execution_equipment (execution_id, equipment_id) values ($1,$2)',
        [execution.id, equipmentId],
      );
    }
  }
};

const recordTestResult: ActionEffect = async (tx, request, objects, ctx) => {
  const execution = objects.find((o) => o.object_type === 'test_execution');
  if (execution === undefined)
    refuse('KF-VER-001', 'record_test_result must name a test execution');
  await tx.query('update engineering.test_execution set result_summary = $2 where id = $1', [
    execution.id,
    requireString(request.payload, 'result_summary'),
  ]);

  // The claim that this result verifies something. Recorded here rather than inferred,
  // because an execution nobody attached to a subject verifies nothing.
  const subject = optionalString(request.payload, 'verifies');
  if (subject !== null) {
    await tx.query(
      `insert into engineering.verification_link (subject_id, execution_id, created_by, authorizing_action)
       values ($1,$2,$3,$4)
       on conflict (subject_id, execution_id) do nothing`,
      // The action that made the claim. It was a ternary with null on both branches, which
      // left a verification link traceable to a person but not to the authority they acted
      // under — in a module whose whole argument is that records carry both.
      [subject, execution.id, request.actorId, ctx.actionId],
    );
  }
};

const invalidateTestExecution: ActionEffect = async (tx, request, objects) => {
  const execution = objects.find((o) => o.object_type === 'test_execution');
  if (execution === undefined) return;
  // A result invalidated afterwards is a new fact about the execution, not a deletion of it,
  // so the reason is recorded alongside the result it withdraws.
  await tx.query('update engineering.test_execution set invalidated_because = $2 where id = $1', [
    execution.id,
    request.reason ?? 'invalidated',
  ]);
};

const dispositionNonconformity: ActionEffect = async (tx, request, objects) => {
  const nc = objects.find((o) => o.object_type === 'nonconformity');
  if (nc === undefined) return;
  await tx.query('update quality.nonconformity set disposition = $2 where id = $1', [
    nc.id,
    requireString(request.payload, 'disposition'),
  ]);
};

const containNonconformity: ActionEffect = async (tx, request, objects) => {
  const nc = objects.find((o) => o.object_type === 'nonconformity');
  if (nc === undefined) return;
  await tx.query('update quality.nonconformity set containment = $2 where id = $1', [
    nc.id,
    requireString(request.payload, 'containment'),
  ]);
};

const qualifySupplier: ActionEffect = async (tx, request, objects) => {
  const supplier = objects.find((o) => o.object_type === 'supplier');
  if (supplier === undefined) return;
  // A qualification is a RECORD of how it was assessed, not a status change alone. A
  // supplier marked qualified with nothing behind it is an opinion.
  await tx.query(
    `insert into quality.supplier_qualification
       (supplier_id, method, performed_on, outcome, evidence_version, recorded_by)
     values ($1,$2,current_date,$3,$4,$5)`,
    [
      supplier.id,
      requireString(request.payload, 'method'),
      requireString(request.payload, 'outcome'),
      optionalString(request.payload, 'evidence_version'),
      request.actorId,
    ],
  );
  const until = optionalString(request.payload, 'qualified_until');
  if (until !== null) {
    await tx.query('update quality.supplier set qualified_until = $2 where id = $1', [
      supplier.id,
      until,
    ]);
  }
};

// No payload: everything a closure rests on — the root cause, the evidence, the criterion —
// was recorded by the steps before it. Asking for it again here would invite a second,
// different answer.
const closeCapa: ActionEffect = async (tx, _request, objects) => {
  const capa = objects.find((o) => o.object_type === 'capa');
  if (capa === undefined) return;
  await tx.query('update quality.capa set closed_at = now() where id = $1', [capa.id]);
};

const closeComplaint: ActionEffect = async (tx, request, objects) => {
  const complaint = objects.find((o) => o.object_type === 'complaint');
  if (complaint === undefined) return;

  // An EXPLICIT boolean. `=== true` quietly turned a missing decision into "not reportable",
  // which is the single worst default available here — and it also made the database CHECK
  // that requires a decision at closure unreachable, because the value was never null.
  const reportable = request.payload?.['reportable'];
  if (typeof reportable !== 'boolean') {
    refuse(
      'KF-QMS-004',
      'closing a complaint requires an explicit reportable decision, true or false — ' +
        'a missing one is not a "no"',
      { objectId: complaint.id },
    );
  }

  await tx.query(
    `update quality.complaint
        set reportable = $2, reportability_rationale = $3, closed_at = now()
      where id = $1`,
    [complaint.id, reportable, requireString(request.payload, 'reportability_rationale')],
  );
};

const checkCapaEffectiveness: ActionEffect = async (tx, request, objects) => {
  const capa = objects.find((o) => o.object_type === 'capa');
  if (capa === undefined) return;
  await tx.query('update quality.capa set effectiveness_evidence = $2 where id = $1', [
    capa.id,
    requireString(request.payload, 'effectiveness_evidence'),
  ]);
};

const implementCapa: ActionEffect = async (tx, request, objects) => {
  const capa = objects.find((o) => o.object_type === 'capa');
  if (capa === undefined) return;
  await tx.query('update quality.capa set root_cause = $2 where id = $1', [
    capa.id,
    requireString(request.payload, 'root_cause'),
  ]);
};

const makeDocumentEffective: ActionEffect = async (tx, _request, objects) => {
  const doc = objects.find((o) => o.object_type === 'controlled_document');
  if (doc === undefined) return;
  await tx.query('update quality.controlled_document set effective_from = now() where id = $1', [
    doc.id,
  ]);
};

/** An amendment-free record of conformance: which item, which contract, which generation. */
const recordConformance: ActionEffect = async (tx, request, objects) => {
  const item = objects.find((o) => o.object_type === 'configuration_item');
  if (item === undefined) return;
  const contract = optionalString(request.payload, 'conforms_to');
  if (contract === null) return;
  await tx.query(
    `insert into product.interface_conformance
       (configuration_item, interface_contract, generation, verified_by, recorded_by)
     values ($1,$2,$3,$4,$5)
     on conflict (configuration_item, interface_contract, generation) do nothing`,
    [
      item.id,
      contract,
      requireString(request.payload, 'generation'),
      optionalString(request.payload, 'verified_by'),
      request.actorId,
    ],
  );
};

export const PRODUCT_QUALITY_EFFECTS: Readonly<Record<string, ActionEffect>> = {
  execute_test: executeTest,
  record_test_result: recordTestResult,
  invalidate_test_execution: invalidateTestExecution,
  contain_nonconformity: containNonconformity,
  disposition_nonconformity: dispositionNonconformity,
  qualify_supplier: qualifySupplier,
  implement_capa: implementCapa,
  check_capa_effectiveness: checkCapaEffectiveness,
  close_capa: closeCapa,
  close_complaint: closeComplaint,
  make_document_effective: makeDocumentEffective,
  promote_configuration_item: recordConformance,
};

// ── preconditions: the questions a regulator asks ───────────────────────────────────────

/** A nonconformity closed with no disposition never decided what to do with the material. */
const assertDispositioned: PreconditionCheck = async (tx, _request, objects) => {
  for (const o of objects) {
    if (o.object_type !== 'nonconformity') continue;
    const row = await tx.one<{ disposition: string | null }>(
      'select disposition from quality.nonconformity where id = $1',
      [o.id],
    );
    if (row.disposition === null) {
      refuse(
        'KF-QMS-001',
        'this nonconformity has no disposition — closing it would leave the affected material undecided',
        { objectId: o.id },
      );
    }
  }
};

/**
 * A CAPA closed without effectiveness evidence records a fix nobody showed worked.
 *
 * The criterion was agreed when the CAPA opened; this is the check that it was answered
 * rather than quietly dropped at the end.
 */
const assertEffectivenessShown: PreconditionCheck = async (tx, _request, objects) => {
  for (const o of objects) {
    if (o.object_type !== 'capa') continue;
    const row = await tx.one<{
      effectiveness_evidence: string | null;
      effectiveness_criterion: string;
    }>('select effectiveness_evidence, effectiveness_criterion from quality.capa where id = $1', [
      o.id,
    ]);
    if (row.effectiveness_evidence === null || row.effectiveness_evidence.trim() === '') {
      refuse(
        'KF-QMS-002',
        'this CAPA has no effectiveness evidence against the criterion it was opened with',
        // The criterion goes in the structured detail rather than the message: a caller can
        // render it, and it cannot smuggle formatting into a log line.
        { objectId: o.id, criterion: row.effectiveness_criterion },
      );
    }
  }
};

/** A document made effective with no content is a title with a date on it. */
const assertDocumentHasContent: PreconditionCheck = async (tx, _request, objects) => {
  for (const o of objects) {
    if (o.object_type !== 'controlled_document') continue;
    const row = await tx.one<{ content_version: string | null }>(
      'select content_version from quality.controlled_document where id = $1',
      [o.id],
    );
    if (row.content_version === null) {
      refuse(
        'KF-QMS-003',
        'this document has no content version — there is nothing to make effective',
        {
          objectId: o.id,
        },
      );
    }
  }
};

/** A result cannot be recorded for a run that never happened. */
const assertExecuted: PreconditionCheck = async (tx, _request, objects) => {
  for (const o of objects) {
    if (o.object_type !== 'test_execution') continue;
    const row = await tx.one<{ executed_on: Date | null }>(
      'select executed_on from engineering.test_execution where id = $1',
      [o.id],
    );
    if (row.executed_on === null) {
      refuse('KF-VER-002', 'this execution has no execution time — there is no run to report on', {
        objectId: o.id,
      });
    }
  }
};

export const PRODUCT_QUALITY_PRECONDITIONS: Readonly<Record<string, PreconditionCheck>> = {
  close_nonconformity: assertDispositioned,
  close_capa: assertEffectivenessShown,
  make_document_effective: assertDocumentHasContent,
  record_test_result: assertExecuted,
};

// ── reading the consequences ────────────────────────────────────────────────────────────

export interface SuspectResult {
  readonly executionId: string;
  readonly title: string;
  /** Null when the execution never recorded one — still suspect, and visibly so. */
  readonly executedOn: string | null;
  readonly subjectId: string | null;
}

/**
 * Every test result produced by a piece of equipment since its last good calibration.
 *
 * This is what makes an out-of-tolerance finding actionable rather than alarming. Without the
 * execution-to-equipment join it answers "some results may be affected", which is not an
 * answer anybody can act on.
 */
export async function resultsSuspectedOfBadCalibration(
  tx: Tx,
  equipmentId: string,
): Promise<SuspectResult[]> {
  const rows = await tx.query<{
    execution_id: string;
    title: string;
    executed_on: Date | null;
    subject_id: string | null;
  }>(
    `with last_good as (
       select max(performed_on) as at
         from quality.calibration
        where equipment_id = $1 and outcome = 'in_tolerance'
     )
     select e.id as execution_id, o.title, e.executed_on, v.subject_id
       from engineering.test_execution_equipment x
       join engineering.test_execution e on e.id = x.execution_id
       join core.object o on o.id = e.id
       left join engineering.verification_link v on v.execution_id = e.id
      where x.equipment_id = $1
        -- Every clause here leans the same way, because a recall answer that misses a unit is
        -- worse than one that includes an extra.
        --
        -- No good calibration on record: every result is suspect, not none of them.
        -- Executed exactly AT the calibration: suspect, because "since" at a boundary is not
        -- worth guessing about.
        -- No execution time at all: still suspect — a row here means the equipment WAS used,
        -- and filtering on the missing timestamp would drop it from the answer entirely.
        and (
          (select at from last_good) is null
          or e.executed_on is null
          or e.executed_on >= (select at from last_good)
        )
      order by e.executed_on nulls first`,
    [equipmentId],
  );
  return rows.map((r) => ({
    executionId: r.execution_id,
    title: r.title,
    executedOn: r.executed_on === null ? null : r.executed_on.toISOString(),
    subjectId: r.subject_id,
  }));
}

export const PACKAGE = {
  name: '@kf/product-quality',
  role: 'Configuration control, quality records and verification',
  owns: ['product', 'quality', 'engineering'],
} as const;
