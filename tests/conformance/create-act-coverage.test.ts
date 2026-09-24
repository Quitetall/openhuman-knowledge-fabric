/**
 * Every object type is created by a declared act — or the reason it is not is written down.
 *
 * KF-SAS-RQ-143: product configuration, quality and engineering records SHALL be governed by the
 * same object, act and audit model as every other record, with no privileged path. A type with
 * no create act has exactly one way to come into existence — an owner-credential insert, with no
 * actor, no authority and no audit event — and until draft.8 six R01 types were in that position:
 * product_system, requirement, risk, test, baseline and release. The quality end-to-end scenario
 * created its product and its hazard that way and said so in a comment.
 *
 * CREATED_BY maps each type to the act(s) that create it; NO_CREATE_ACT lists the types that
 * have none, each with the reason. Together they are asserted EXHAUSTIVE over the ontology, so a
 * new type cannot land without somebody saying how one is made. Each named act must be declared
 * and owned by a dispatcher group, and — where its group can be composed without configuration —
 * must carry a materializer or effect, because an owned act with no handler creates nothing.
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_ACTION_IDS } from '@kf/documents';
import { loadOntology } from '@kf/ontology-compiler';
import { fabricDispatcherOptions } from '@kf/orchestrator';

const ROOT = join(import.meta.dirname, '..', '..');

const CREATED_BY: Readonly<Record<string, readonly string[]>> = {
  initiative_project: ['create_initiative'],
  work_package: ['create_work_package'],
  work_order: ['issue_work_order'],
  work_execution: ['submit_work_execution'],
  work_order_amendment: ['amend_work_order'],
  acceptance_record: ['issue_acceptance'],
  invoice: ['submit_invoice'],
  payment: ['authorize_payment'],
  decision_record: ['propose_decision'],
  change_record: ['open_change'],
  artifact: ['attach_evidence', 'register_external_artifact'],
  controlled_document: ['submit_document_for_review', 'add_controlled_document'],
  authored_fragment: ['add_authored_fragment'],
  document_composition: ['add_document_composition'],
  configuration_item: ['promote_configuration_item'],
  interface_contract: ['publish_interface_contract'],
  physical_binding: ['record_physical_binding'],
  nonconformity: ['raise_nonconformity'],
  capa: ['open_capa'],
  supplier: ['register_supplier'],
  equipment: ['register_equipment'],
  complaint: ['receive_complaint'],
  risk_control: ['propose_risk_control'],
  test_definition: ['define_test'],
  test_execution: ['plan_test_execution'],
  ml_promotion_decision: ['authorize_ml_promotion'],
  warrant: ['create_warrant_draft'],
  // KF-SAS-RQ-143, draft.8: the R01 product and quality records.
  product_system: ['register_product_system'],
  requirement: ['define_requirement'],
  risk: ['identify_risk'],
  test: ['register_test'],
  baseline: ['define_baseline'],
  release: ['define_release'],
  // ADR 0034 (proposed).
  observation: ['record_observation'],
};

/** Types with no create act, and why. A reason is a recorded gap, not an exemption from one. */
const NO_CREATE_ACT: Readonly<Record<string, string>> = {
  organization:
    'bootstrap tier (SAS §33): the first organization is created by bootstrap_organization, ' +
    'recorded but never dispatched, because no principal exists yet to dispatch it.',
  person:
    'created by the owner-credential admin tools (bootstrap-organization, declare-service-actor); ' +
    'a person-creating act is org.person work owned elsewhere in draft.8.',
  role_assignment:
    'created by the owner-credential admin tool grant-authority; the same draft.8 work item.',
  engagement:
    'RECORDED GAP (KF-SAS-RQ-142, work control): no act creates one; the reference scenario ' +
    'seeds its engagement with an owner insert. Not a product/quality type, so outside RQ-143.',
  deliverable: 'RECORDED GAP (KF-SAS-RQ-142): no act creates one; work.deliverable is unreached.',
  milestone: 'RECORDED GAP (KF-SAS-RQ-142): no act creates one; work.milestone is unreached.',
};

describe('every object type has a create act, or a recorded reason it has none', () => {
  const ontology = loadOntology(join(ROOT, 'ontology'));
  const declaredActions = new Set(ontology.actionTypes.map((a) => a.id));
  const options = fabricDispatcherOptions();
  const owned = new Set([...options.allowedActions, ...DOCUMENT_ACTION_IDS]);

  it('accounts for every object type exactly once', () => {
    const types = ontology.objectTypes.map((t) => t.id).sort();
    const accounted = [...Object.keys(CREATED_BY), ...Object.keys(NO_CREATE_ACT)].sort();
    expect(accounted, 'a type is in both maps, or in neither').toEqual(types);
  });

  it('names only declared acts that a dispatcher group owns', () => {
    for (const [type, actions] of Object.entries(CREATED_BY)) {
      expect(actions.length, `${type} names no act`).toBeGreaterThan(0);
      for (const action of actions) {
        expect(declaredActions.has(action), `${type}: ${action} is not declared`).toBe(true);
        expect(owned.has(action), `${type}: ${action} is declared and owned by no group`).toBe(
          true,
        );
      }
    }
  });

  it('gives every create act a handler that can create something', () => {
    // Document acts are composed only with an object store configured, so their handlers are
    // not present here; ownership above is what can be asserted without one.
    const documentActs = new Set<string>(DOCUMENT_ACTION_IDS);
    const handlerless = Object.values(CREATED_BY)
      .flat()
      .filter((action) => !documentActs.has(action))
      .filter(
        (action) =>
          options.materializers[action] === undefined && options.effects[action] === undefined,
      );
    expect(handlerless, 'owned, and with no materializer or effect to create the record').toEqual(
      [],
    );
  });

  it('gives every type without one a reason', () => {
    for (const [type, reason] of Object.entries(NO_CREATE_ACT)) {
      expect(reason.length, `${type} needs a reason`).toBeGreaterThan(40);
    }
  });
});
