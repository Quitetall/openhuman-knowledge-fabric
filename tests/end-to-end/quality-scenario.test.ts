/**
 * The quality scenario: a design, a verified control, a nonconformity, and a recall question.
 *
 * Same rule as the work-control scenario — every record here is created by a named action,
 * and there is not one fixture INSERT into product, quality or engineering. If a step cannot
 * be reached through an action, the slice has a hole in it.
 *
 * The story is the one a device organisation actually has to answer: a hazard has a control,
 * the control is verified by a test on a specific build, the equipment that ran the test is
 * later found out of tolerance, and somebody has to say which results are affected.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActionRejected, createDispatcher, type ActionRequest } from '@kf/actions';
import { withTransaction } from '@kf/database';
import { WORK_CONTROL_PRECONDITIONS } from '@kf/work-control';
import {
  PRODUCT_QUALITY_EFFECTS,
  PRODUCT_QUALITY_MATERIALIZERS,
  PRODUCT_QUALITY_PRECONDITIONS,
  resultsSuspectedOfBadCalibration,
} from '@kf/product-quality';
import { seedFixtures, startHarness, type Fixtures, type Harness } from '../database/harness.js';

let h: Harness;
let f: Fixtures;
let execute: ReturnType<typeof createDispatcher>;

let productSystem: string;
let enclosure: string;
let interfaceContract: string;
let risk: string;
let control: string;
let testDefinition: string;
let execution: string;
let equipment: string;
let nonconformity: string;
let capa: string;

let counter = 0;
function key(label: string): string {
  counter += 1;
  return `${label}-${String(counter).padStart(4, '0')}-qs`;
}

type Call = Omit<ActionRequest, 'organizationId' | 'maxClassification' | 'idempotencyKey'> & {
  idempotencyKey?: string;
};

async function act(call: Call) {
  return execute({
    organizationId: f.organizationId,
    maxClassification: 'restricted',
    idempotencyKey: call.idempotencyKey ?? key(call.actionType),
    ...call,
  });
}

/** Everything here is done by the technical authority unless a test says otherwise. */
function authority(): { actorId: string; actingRoleId: string } {
  return { actorId: f.reviewerId, actingRoleId: f.reviewerRoleId };
}

async function stateOf(id: string): Promise<string> {
  return withTransaction(h.adminPool, async (tx) => {
    const row = await tx.one<{ lifecycle_state: string }>(
      'select lifecycle_state from core.object where id = $1',
      [id],
    );
    return row.lifecycle_state;
  });
}

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  execute = createDispatcher(h.pool, {
    materializers: PRODUCT_QUALITY_MATERIALIZERS,
    effects: PRODUCT_QUALITY_EFFECTS,
    preconditions: { ...WORK_CONTROL_PRECONDITIONS, ...PRODUCT_QUALITY_PRECONDITIONS },
  });

  // The product and the hazard are bootstrap facts: the product exists, and the hazard is
  // owned by the QMS. Everything after this is an action.
  await withTransaction(h.adminPool, async (tx) => {
    await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
    await tx.query('select core.set_transaction_context($1, $1, $2, $3)', [
      f.reviewerId,
      '01930000-0000-7000-8000-00000000ac10',
      'quality-scenario-bootstrap',
    ]);
    const { version } = await tx.one<{ version: string }>(
      'select version from registry.schema_release where is_current',
    );
    const mk = async (type: string, domain: string, state: string, title: string) => {
      const row = await tx.one<{ id: string }>(
        `insert into core.object
           (object_type, authority_domain, lifecycle_state, classification, retention_class,
            schema_version, organization_id, title, created_by, updated_by)
         values ($1,$2,$3,'internal','project_record',$4,$5,$6,$7,$7) returning id`,
        [type, domain, state, version, f.organizationId, title, f.reviewerId],
      );
      return row.id;
    };
    productSystem = await mk('product_system', 'configuration', 'development', 'OH-EEG-1');
    risk = await mk('risk', 'engineering', 'identified', 'Excess electrode leakage current');
  });
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

describe('1. configuration', () => {
  it('defines and promotes a configuration item in one action', async () => {
    const r = await act({
      actionType: 'promote_configuration_item',
      ...authority(),
      targetIds: [],
      payload: {
        title: 'Electrode front-end board',
        item_kind: 'hardware',
        part_number: 'CNB-2201',
        revision_label: 'B',
        parent_system: productSystem,
      },
    });
    enclosure = r.objectIds[0]!;
    // Born in `proposed`, moved to `active` by the same action — the shape every creating
    // action in this system uses.
    expect(await stateOf(enclosure)).toBe('active');
  });

  it('publishes an interface contract scoped to a GENERATION', async () => {
    const r = await act({
      actionType: 'publish_interface_contract',
      ...authority(),
      targetIds: [],
      payload: {
        title: 'Electrode connector, gen 2',
        interface_kind: 'electrical',
        generation: 'gen2',
        provider: productSystem,
        specification: '8-pin DIN 42802, 1.5 mm touchproof, per IEC 60601-1.',
      },
    });
    interfaceContract = r.objectIds[0]!;
    expect(await stateOf(interfaceContract)).toBe('published');

    const row = await withTransaction(h.adminPool, async (tx) =>
      tx.one<{ generation: string }>(
        'select generation from product.interface_contract where id = $1',
        [interfaceContract],
      ),
    );
    // A generation, not a revision. Conformance scoped to a revision would expire on every
    // rework, which is the whole reason R4 scopes OH-IFC- this way.
    expect(row.generation).toBe('gen2');
  });

  it('refuses a second contract for the same provider, kind and generation', async () => {
    await expect(
      act({
        actionType: 'publish_interface_contract',
        ...authority(),
        targetIds: [],
        payload: {
          title: 'Electrode connector, gen 2 (duplicate)',
          interface_kind: 'electrical',
          generation: 'gen2',
          provider: productSystem,
          specification: 'A second, contradictory definition of the same interface.',
        },
      }),
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});

describe('2. a risk control, verified', () => {
  it('proposes a control against the hazard', async () => {
    const r = await act({
      actionType: 'propose_risk_control',
      ...authority(),
      targetIds: [],
      payload: {
        title: 'Series current-limiting resistor',
        control_kind: 'protective_measure',
        mitigates: risk,
        description: '10 kΩ series resistor on every electrode path.',
      },
    });
    control = r.objectIds[0]!;
    expect(await stateOf(control)).toBe('proposed');

    await act({ actionType: 'implement_risk_control', ...authority(), targetIds: [control] });
    expect(await stateOf(control)).toBe('implemented');
  });

  it('registers the equipment the test will use', async () => {
    const r = await act({
      actionType: 'register_equipment',
      ...authority(),
      targetIds: [],
      payload: {
        title: 'Leakage current tester',
        asset_number: 'EQP-0042',
        equipment_kind: 'measurement',
      },
    });
    equipment = r.objectIds[0]!;
    expect(await stateOf(equipment)).toBe('in_service');
  });

  it('defines and approves a test for the control', async () => {
    const r = await act({
      actionType: 'define_test',
      ...authority(),
      targetIds: [],
      payload: {
        title: 'Leakage current, single fault',
        method_kind: 'test',
        acceptance_criterion: 'Patient leakage below 10 µA under single-fault condition.',
        verifies: control,
      },
    });
    testDefinition = r.objectIds[0]!;
    await act({
      actionType: 'approve_test_definition',
      ...authority(),
      targetIds: [testDefinition],
    });
    expect(await stateOf(testDefinition)).toBe('approved');
  });

  it('refuses to record a result for a run that never happened', async () => {
    const planned = await act({
      actionType: 'plan_test_execution',
      ...authority(),
      targetIds: [],
      payload: { title: 'Leakage run (unplanned report)', test_definition: testDefinition },
    });
    const id = planned.objectIds[0]!;

    // `planned` has no exit to a result without executing first, so the transition guard
    // catches it before the precondition — which is the correct order of defences.
    await expect(
      act({
        actionType: 'record_test_result',
        ...authority(),
        targetIds: [id],
        payload: { result_summary: 'It was fine, trust me.', to_state: 'passed' },
      }),
    ).rejects.toThrow(ActionRejected);
  });

  it('runs the test, records the result, and verifies the control', async () => {
    const planned = await act({
      actionType: 'plan_test_execution',
      ...authority(),
      targetIds: [],
      payload: {
        title: 'Leakage run on CNB-2201 rev B',
        test_definition: testDefinition,
        configuration_item: enclosure,
      },
    });
    execution = planned.objectIds[0]!;

    await act({
      actionType: 'execute_test',
      ...authority(),
      targetIds: [execution],
      payload: { equipment: [equipment] },
    });
    expect(await stateOf(execution)).toBe('executed');

    await act({
      actionType: 'record_test_result',
      ...authority(),
      targetIds: [execution],
      payload: {
        result_summary: 'Patient leakage 4.2 µA at 250 Vac single fault.',
        verifies: control,
        to_state: 'passed',
      },
    });
    expect(await stateOf(execution)).toBe('passed');

    await act({ actionType: 'verify_risk_control', ...authority(), targetIds: [control] });
    expect(await stateOf(control)).toBe('verified');

    const status = await withTransaction(h.adminPool, async (tx) =>
      tx.one<{ verified: boolean; approved_definitions: string; definitions_passed: string }>(
        'select * from engineering.verification_status where subject_id = $1',
        [control],
      ),
    );
    // Verified because EVERY approved definition has a passing run that actually executed —
    // not because one of them does.
    expect(status.verified).toBe(true);
    expect(status.approved_definitions).toBe(status.definitions_passed);
  });
});

describe('3. a nonconformity and its CAPA', () => {
  it('raises a nonconformity against the board', async () => {
    const r = await act({
      actionType: 'raise_nonconformity',
      ...authority(),
      targetIds: [],
      payload: {
        title: 'Resistor tolerance out of specification',
        severity: 'major',
        description: 'Batch fitted with 5% resistors where the design calls for 1%.',
        subject_id: enclosure,
      },
    });
    nonconformity = r.objectIds[0]!;
    expect(await stateOf(nonconformity)).toBe('open');
  });

  it('refuses to close it while the material is undecided', async () => {
    await act({
      actionType: 'contain_nonconformity',
      ...authority(),
      targetIds: [nonconformity],
      payload: { containment: 'Batch quarantined; no units released.' },
    });
    await act({
      actionType: 'investigate_nonconformity',
      ...authority(),
      targetIds: [nonconformity],
    });

    // `dispositioned` is reachable, so the lifecycle allows the move — what refuses is the
    // precondition, because a closed nonconformity with a blank disposition never said what
    // happened to the material.
    const err = await act({
      actionType: 'disposition_nonconformity',
      ...authority(),
      targetIds: [nonconformity],
      payload: {},
    }).catch((e: unknown) => e as Error);
    expect(String((err as Error).message)).toMatch(/disposition is required/);
  });

  it('dispositions and closes it', async () => {
    await act({
      actionType: 'disposition_nonconformity',
      ...authority(),
      targetIds: [nonconformity],
      payload: { disposition: 'rework' },
    });
    await act({
      actionType: 'close_nonconformity',
      ...authority(),
      targetIds: [nonconformity],
    });
    expect(await stateOf(nonconformity)).toBe('closed');
  });

  it('KF-QMS-002: refuses to close a CAPA with no effectiveness evidence', async () => {
    const opened = await act({
      actionType: 'open_capa',
      ...authority(),
      targetIds: [],
      payload: {
        title: 'Incoming inspection missed resistor tolerance',
        capa_kind: 'corrective',
        problem_statement: 'Tolerance is not checked on incoming passives.',
        effectiveness_criterion: 'Three consecutive batches inspected with zero escapes.',
        nonconformities: [nonconformity],
      },
    });
    capa = opened.objectIds[0]!;

    await act({
      actionType: 'approve_capa_plan',
      ...authority(),
      targetIds: [capa],
    });
    await act({
      actionType: 'implement_capa',
      ...authority(),
      targetIds: [capa],
      payload: { root_cause: 'Inspection instruction omits passive tolerance.' },
    });

    // Straight to close, skipping the effectiveness check. The lifecycle would not allow it
    // either — but the precondition is what names the reason, and the reason is the point.
    const err = await act({
      actionType: 'close_capa',
      ...authority(),
      targetIds: [capa],
    }).catch((e: unknown) => e as ActionRejected);
    expect(err).toBeInstanceOf(ActionRejected);
  });

  it('closes the CAPA once effectiveness is shown against the criterion', async () => {
    await act({
      actionType: 'check_capa_effectiveness',
      ...authority(),
      targetIds: [capa],
      payload: {
        effectiveness_evidence: 'Batches 14, 15 and 16 inspected; zero tolerance escapes.',
      },
    });
    // Recording the evidence is its own step: from `implementing` the only destination is
    // `effectiveness_check`. Closure is a separate decision, which is the point — a CAPA
    // that closed in the same breath as its evidence was filed would never have been read.
    expect(await stateOf(capa)).toBe('effectiveness_check');

    await act({ actionType: 'close_capa', ...authority(), targetIds: [capa] });
    // Now the precondition passes, because the evidence exists.
    expect(await stateOf(capa)).toBe('closed');
  });
});

describe('4. a complaint that cannot close undecided', () => {
  it('refuses closure with no explicit reportability decision', async () => {
    const received = await act({
      actionType: 'receive_complaint',
      ...authority(),
      targetIds: [],
      payload: {
        title: 'Device stopped recording mid-session',
        summary: 'Recording ended without warning after 40 minutes.',
        reporter_reference: 'FIVERR-2291',
      },
    });
    const complaint = received.objectIds[0]!;
    await act({ actionType: 'triage_complaint', ...authority(), targetIds: [complaint] });

    // A missing decision is not a "no". The old code coerced it to false, which was both the
    // worst available default and the thing that made the database CHECK unreachable.
    const err = await act({
      actionType: 'close_complaint',
      ...authority(),
      targetIds: [complaint],
      payload: { reportability_rationale: 'Not serious.', to_state: 'closed' },
    }).catch((e: unknown) => e as ActionRejected);
    expect(err).toBeInstanceOf(ActionRejected);
    expect((err as ActionRejected).message).toMatch(/KF-QMS-004/);

    await act({
      actionType: 'close_complaint',
      ...authority(),
      targetIds: [complaint],
      payload: {
        reportable: false,
        reportability_rationale:
          'No injury, no malfunction meeting the reporting threshold; data recoverable.',
        to_state: 'closed',
      },
    });
    expect(await stateOf(complaint)).toBe('closed');
  });
});

describe('5. the recall question', () => {
  it('names every result the bad equipment produced, not "some may be affected"', async () => {
    // The question that makes the execution-to-equipment join worth having. Without it the
    // answer is "some results may be affected", which nobody can act on.
    const suspect = await withTransaction(h.adminPool, async (tx) =>
      resultsSuspectedOfBadCalibration(tx, equipment),
    );
    expect(suspect.map((s) => s.executionId)).toContain(execution);
    // And it names what that result was claimed to verify, so the consequence is traceable
    // rather than merely detected.
    expect(suspect.find((s) => s.executionId === execution)?.subjectId).toBe(control);

    // And the verification link names the ACTION that made the claim, not just the person.
    const linked = await withTransaction(h.adminPool, async (tx) =>
      tx.one<{ authorizing_action: string | null }>(
        'select authorizing_action from engineering.verification_link where execution_id = $1',
        [execution],
      ),
    );
    expect(linked.authorizing_action).not.toBeNull();
  });

  it('invalidating the result withdraws the verification it supported', async () => {
    await act({
      actionType: 'invalidate_test_execution',
      ...authority(),
      targetIds: [execution],
      reason: 'Leakage tester EQP-0042 found out of tolerance at its next calibration.',
    });
    expect(await stateOf(execution)).toBe('invalidated');

    const status = await withTransaction(h.adminPool, async (tx) =>
      tx.one<{ verified: boolean; invalidated: string }>(
        'select * from engineering.verification_status where subject_id = $1',
        [control],
      ),
    );
    // The control is no longer verified, and nobody had to remember to clear a flag: the
    // view reads the executions, so withdrawing the result withdraws the claim.
    expect(Number(status.invalidated)).toBe(1);
    expect(status.verified).toBe(false);
  });
});
