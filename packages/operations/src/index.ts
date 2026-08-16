/**
 * Operational readiness.
 *
 * One function that answers "is this system in the state it is supposed to be in", and fails
 * closed on every question it cannot answer.
 */

export {
  loadSecret,
  readSecretFile,
  redact,
  SecretRejected,
  type SecretOptions,
} from './secrets.js';
export { assessReadiness } from './internal/assess.js';
export { formatReadiness } from './internal/format.js';
export type {
  Check,
  CheckStatus,
  ReadinessPartition,
  ReadinessReport,
  ReadinessScope,
  ReadinessThresholds,
} from './internal/contracts.js';

export const PACKAGE = {
  name: '@kf/operations',
  role: 'Operational readiness and deployment secrets, fail-closed',
  owns: [],
} as const;
