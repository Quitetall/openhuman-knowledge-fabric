/**
 * Configuration control, quality records and verification, as typed actions.
 *
 * The same shape as work control, for the same reason: a record created by a direct insert
 * has no actor, no authority and no audit event, and a quality system whose records can
 * appear that way is a quality system in name.
 */

export { PRODUCT_QUALITY_ACTION_IDS } from './internal/action-ids.js';
export { PRODUCT_QUALITY_MATERIALIZERS } from './internal/materializers.js';
export { PRODUCT_QUALITY_EFFECTS } from './internal/effects.js';
export { PRODUCT_QUALITY_PRECONDITIONS } from './internal/preconditions.js';
export { resultsSuspectedOfBadCalibration, type SuspectResult } from './internal/readers.js';

export const PACKAGE = {
  name: '@kf/product-quality',
  role: 'Configuration control, quality records and verification',
  owns: ['product', 'quality', 'engineering'],
} as const;
