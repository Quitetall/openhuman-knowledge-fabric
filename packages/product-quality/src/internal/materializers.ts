import type { ActionMaterializer } from '@kf/actions';
import {
  promoteConfigurationItem,
  publishInterfaceContract,
  recordPhysicalBinding,
} from './configuration-materializers.js';
import {
  openCapa,
  raiseNonconformity,
  receiveComplaint,
  registerEquipment,
  registerSupplier,
  submitDocumentForReview,
} from './quality-materializers.js';
import { defineTest, planTestExecution, proposeRiskControl } from './verification-materializers.js';

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
