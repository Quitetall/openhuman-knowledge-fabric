import type { ActionEffect } from '@kf/actions';
import {
  checkCapaEffectiveness,
  closeCapa,
  closeComplaint,
  containNonconformity,
  dispositionNonconformity,
  implementCapa,
  makeDocumentEffective,
  qualifySupplier,
} from './quality-effects.js';
import {
  executeTest,
  invalidateTestExecution,
  recordConformance,
  recordTestResult,
} from './verification-effects.js';

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
