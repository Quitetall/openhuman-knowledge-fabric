/**
 * Every table preservation export carries, in deterministic wire order.
 *
 * SQL owns bounded database ordering; canonical encoding later removes host collation from
 * final row-set bytes.
 */
import { BUSINESS_SECTIONS } from './sections/business.js';
import { CORE_SECTIONS } from './sections/core.js';
import { DOCUMENT_SECTIONS } from './sections/documents.js';
import { ENGINEERING_QUALITY_SECTIONS } from './sections/engineering-quality.js';
import { ML_SECTIONS } from './sections/ml.js';
import { SECURE_RUNTIME_SECTIONS } from './sections/secure-runtime.js';

export const SECTIONS = [
  ...CORE_SECTIONS,
  ...DOCUMENT_SECTIONS,
  ...ML_SECTIONS,
  ...SECURE_RUNTIME_SECTIONS,
  ...BUSINESS_SECTIONS,
  ...ENGINEERING_QUALITY_SECTIONS,
] as const;
