/**
 * Every action whose application semantics are owned by work control.
 *
 * Handler-free entries are deliberate ontology-only lifecycle transitions. They remain
 * explicit so a missing handler cannot make an unrelated registry action appear available
 * through the application composition root.
 */
export const WORK_CONTROL_ACTION_IDS = [
  'create_initiative',
  'triage_initiative',
  'authorize_project',
  'activate_project',
  'create_work_package',
  'start_work_package',
  'accept_work_package',
  'issue_work_order',
  'accept_work_order',
  'amend_work_order',
  'submit_work_execution',
  'review_work_execution',
  'issue_acceptance',
  'propose_decision',
  'accept_decision',
  'reject_decision',
  'supersede_decision',
  'open_change',
  'approve_change',
  'verify_change',
  'make_change_effective',
  'submit_invoice',
  'approve_invoice',
  'authorize_payment',
  'record_payment_settlement',
  'reconcile_payment',
  'complete_project_technical',
  'close_project_administrative',
  'correct_record',
  // KF-SAS-RQ-142: the work-control records that had no create act.
  'record_engagement',
  'plan_milestone',
  'define_deliverable',
  // The engagement lifecycle R01 declared the states of and left without transitions.
  'activate_engagement',
  'suspend_engagement',
  'resume_engagement',
  'close_engagement',
  'terminate_engagement',
] as const;
