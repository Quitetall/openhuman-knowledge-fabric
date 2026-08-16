import type { ActionEffect } from '@kf/actions';
import { optionalString, requireString } from '@kf/record-atoms';
import { refuse } from './errors.js';

export const dispositionNonconformity: ActionEffect = async (tx, request, objects) => {
  const nc = objects.find((o) => o.object_type === 'nonconformity');
  if (nc === undefined) return;
  await tx.query('update quality.nonconformity set disposition = $2 where id = $1', [
    nc.id,
    requireString(request.payload, 'disposition'),
  ]);
};

export const containNonconformity: ActionEffect = async (tx, request, objects) => {
  const nc = objects.find((o) => o.object_type === 'nonconformity');
  if (nc === undefined) return;
  await tx.query('update quality.nonconformity set containment = $2 where id = $1', [
    nc.id,
    requireString(request.payload, 'containment'),
  ]);
};

export const qualifySupplier: ActionEffect = async (tx, request, objects) => {
  const supplier = objects.find((o) => o.object_type === 'supplier');
  if (supplier === undefined) return;
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

export const closeCapa: ActionEffect = async (tx, _request, objects) => {
  const capa = objects.find((o) => o.object_type === 'capa');
  if (capa === undefined) return;
  await tx.query('update quality.capa set closed_at = now() where id = $1', [capa.id]);
};

export const closeComplaint: ActionEffect = async (tx, request, objects) => {
  const complaint = objects.find((o) => o.object_type === 'complaint');
  if (complaint === undefined) return;

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

export const checkCapaEffectiveness: ActionEffect = async (tx, request, objects) => {
  const capa = objects.find((o) => o.object_type === 'capa');
  if (capa === undefined) return;
  await tx.query('update quality.capa set effectiveness_evidence = $2 where id = $1', [
    capa.id,
    requireString(request.payload, 'effectiveness_evidence'),
  ]);
};

export const implementCapa: ActionEffect = async (tx, request, objects) => {
  const capa = objects.find((o) => o.object_type === 'capa');
  if (capa === undefined) return;
  await tx.query('update quality.capa set root_cause = $2 where id = $1', [
    capa.id,
    requireString(request.payload, 'root_cause'),
  ]);
};

export const makeDocumentEffective: ActionEffect = async (tx, _request, objects) => {
  const doc = objects.find((o) => o.object_type === 'controlled_document');
  if (doc === undefined) return;
  await tx.query('update quality.controlled_document set effective_from = now() where id = $1', [
    doc.id,
  ]);
};
