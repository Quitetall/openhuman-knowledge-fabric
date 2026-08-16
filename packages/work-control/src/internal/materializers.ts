import type { ActionMaterializer } from '@kf/actions';
import { openChange, proposeDecision } from './decision-materializers.js';
import { authorizePayment, submitInvoice } from './finance-materializers.js';
import {
  createInitiative,
  createWorkPackage,
  issueWorkOrder,
  submitWorkExecution,
} from './project-materializers.js';

export const WORK_CONTROL_MATERIALIZERS: Readonly<Record<string, ActionMaterializer>> = {
  create_initiative: createInitiative,
  create_work_package: createWorkPackage,
  issue_work_order: issueWorkOrder,
  submit_work_execution: submitWorkExecution,
  submit_invoice: submitInvoice,
  authorize_payment: authorizePayment,
  propose_decision: proposeDecision,
  open_change: openChange,
};
