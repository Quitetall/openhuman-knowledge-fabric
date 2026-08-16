import type { ActionEffect } from '@kf/actions';
import { optionalString, requireString } from '@kf/record-atoms';
import { refuse } from './errors.js';

/** Running the test: what was used, when, and on which build. */
export const executeTest: ActionEffect = async (tx, request, objects) => {
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
      await tx.query(
        'insert into engineering.test_execution_equipment (execution_id, equipment_id) values ($1,$2)',
        [execution.id, equipmentId],
      );
    }
  }
};

export const recordTestResult: ActionEffect = async (tx, request, objects, ctx) => {
  const execution = objects.find((o) => o.object_type === 'test_execution');
  if (execution === undefined)
    refuse('KF-VER-001', 'record_test_result must name a test execution');
  await tx.query('update engineering.test_execution set result_summary = $2 where id = $1', [
    execution.id,
    requireString(request.payload, 'result_summary'),
  ]);

  const subject = optionalString(request.payload, 'verifies');
  if (subject !== null) {
    await tx.query(
      `insert into engineering.verification_link (subject_id, execution_id, created_by, authorizing_action)
       values ($1,$2,$3,$4)
       on conflict (subject_id, execution_id) do nothing`,
      [subject, execution.id, request.actorId, ctx.actionId],
    );
  }
};

export const invalidateTestExecution: ActionEffect = async (tx, request, objects) => {
  const execution = objects.find((o) => o.object_type === 'test_execution');
  if (execution === undefined) return;
  await tx.query('update engineering.test_execution set invalidated_because = $2 where id = $1', [
    execution.id,
    request.reason ?? 'invalidated',
  ]);
};

/** An amendment-free record of conformance: which item, which contract, which generation. */
export const recordConformance: ActionEffect = async (tx, request, objects) => {
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
