import type { ActionMaterializer } from '@kf/actions';
import {
  createControlledObject,
  optionalString,
  requireCurrency,
  requireMinor,
  requireString,
} from '../objects.js';
import { refuse } from './errors.js';

export const submitInvoice: ActionMaterializer = async (tx, request) => {
  const id = await createControlledObject(tx, {
    objectType: 'invoice',
    authorityDomain: 'finance',
    lifecycleState: 'draft',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
    classification: 'restricted',
  });
  await tx.query(
    `insert into finance.invoice (id, engagement_id, invoice_number, issuer_id, currency, issued_on)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      id,
      requireString(request.payload, 'engagement_id'),
      requireString(request.payload, 'invoice_number'),
      requireString(request.payload, 'issuer_id'),
      requireCurrency(request.payload),
      requireString(request.payload, 'issued_on'),
    ],
  );

  const lines = request.payload?.['lines'];
  if (!Array.isArray(lines) || lines.length === 0) {
    refuse('KF-FIN-002', 'an invoice with no lines bills for nothing');
  }
  let lineNo = 1;
  for (const raw of lines) {
    const line = raw as Record<string, unknown>;
    await tx.query(
      `insert into finance.invoice_line
         (invoice_id, line_no, work_order_id, acceptance_id, description, amount_minor)
       values ($1,$2,$3,$4,$5,$6)`,
      [
        id,
        lineNo++,
        requireString(line, 'work_order_id'),
        optionalString(line, 'acceptance_id'),
        requireString(line, 'description'),
        requireMinor(line, 'amount_minor'),
      ],
    );
  }
  return [id];
};

export const authorizePayment: ActionMaterializer = async (tx, request) => {
  if (request.targetIds.length > 0) return [];

  const id = await createControlledObject(tx, {
    objectType: 'payment',
    authorityDomain: 'finance',
    lifecycleState: 'planned',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
    classification: 'restricted',
  });
  await tx.query(
    `insert into finance.payment
       (id, payer_id, payee_id, amount_minor, currency, method, external_reference, value_date)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      requireString(request.payload, 'payer_id'),
      requireString(request.payload, 'payee_id'),
      requireMinor(request.payload, 'amount_minor'),
      requireCurrency(request.payload),
      requireString(request.payload, 'method'),
      optionalString(request.payload, 'external_reference'),
      requireString(request.payload, 'value_date'),
    ],
  );

  const allocations = request.payload?.['allocations'];
  if (Array.isArray(allocations)) {
    for (const raw of allocations) {
      const a = raw as Record<string, unknown>;
      await tx.query(
        'insert into finance.payment_allocation (payment_id, invoice_id, amount_minor) values ($1,$2,$3)',
        [id, requireString(a, 'invoice_id'), requireMinor(a, 'amount_minor')],
      );
    }
  }
  return [id];
};
