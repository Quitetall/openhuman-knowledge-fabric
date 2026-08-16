import type { PreservationSection } from './types.js';

export const BUSINESS_SECTIONS = [
  {
    name: 'initiative-projects',
    sql: `select id, project_code, objective, sponsor_id, started_on, target_completion
            from work.initiative_project order by id`,
  },
  {
    name: 'milestones',
    sql: `select id, project_id, planned_on, achieved_on, criterion
            from work.milestone order by project_id, planned_on, id`,
  },
  {
    name: 'project-events',
    sql: `select id, project_id, occurred_at, event_kind, summary, recorded_at, recorded_by,
                 recorded_by_action
            from work.project_event order by project_id, occurred_at, id`,
  },
  {
    name: 'work-packages',
    sql: `select id, project_id, sequence_no, scope_statement, acceptance_criterion,
                 planned_value_minor, currency
            from work.work_package order by project_id, sequence_no, id`,
  },
  {
    name: 'work-orders',
    sql: `select id, project_id, engagement_id, order_number, scope_summary, ceiling_minor,
                 currency, issued_on, performance_starts_on, performance_ends_on
            from work.work_order order by id`,
  },
  {
    name: 'work-order-scopes',
    sql: `select work_order_id, work_package_id
            from work.work_order_scope order by work_order_id, work_package_id`,
  },
  {
    name: 'work-order-amendments',
    sql: `select id, work_order_id, amendment_no, ceiling_delta_minor, currency, rationale,
                 approved_at, approved_by
            from work.work_order_amendment order by work_order_id, amendment_no, id`,
  },
  {
    name: 'deliverables',
    sql: `select id, work_package_id, deliverable_kind, definition_of_done
            from work.deliverable order by work_package_id, id`,
  },
  {
    name: 'work-executions',
    sql: `select id, work_order_id, performed_by, submitted_by, recorded_by, period_start,
                 period_end, effort_hours, summary, claimed_value_minor, currency
            from work.work_execution order by work_order_id, period_start, id`,
  },
  {
    name: 'deliverable-submissions',
    sql: `select id, work_execution_id, deliverable_id, artifact_version_id, note
            from work.deliverable_submission order by work_execution_id, deliverable_id, id`,
  },
  {
    name: 'acceptance-records',
    sql: `select id, work_execution_id, accepted_by, disposition, accepted_value_minor,
                 currency, rationale, accepted_at
            from work.acceptance_record order by work_execution_id, id`,
  },
  {
    name: 'acceptance-items',
    sql: `select id, acceptance_id, deliverable_id, disposition, comment
            from work.acceptance_item order by acceptance_id, deliverable_id, id`,
  },
  {
    name: 'invoices',
    sql: `select id, engagement_id, invoice_number, issuer_id, currency, issued_on, due_on
            from finance.invoice order by id`,
  },
  {
    name: 'invoice-lines',
    sql: `select id, invoice_id, line_no, work_order_id, acceptance_id, description, amount_minor
            from finance.invoice_line order by invoice_id, line_no, id`,
  },
  {
    name: 'payments',
    sql: `select id, payer_id, payee_id, amount_minor, currency, method, external_reference,
                 value_date
            from finance.payment order by id`,
  },
  {
    name: 'payment-allocations',
    sql: `select id, payment_id, invoice_id, amount_minor
            from finance.payment_allocation order by payment_id, invoice_id, id`,
  },
] as const satisfies readonly PreservationSection[];
