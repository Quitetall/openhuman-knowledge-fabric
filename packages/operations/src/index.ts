/**
 * Operational readiness, and host commissioning.
 *
 * Two questions that are constantly confused and must not be. `assessReadiness` answers "is
 * this system in the state it is supposed to be in" and runs continuously.
 * `assessCommissioning` answers "was this host ever installed the way the deployment says it
 * must be" and runs at install, at upgrade, and whenever somebody has to state it in writing.
 *
 * A perfectly healthy service can be running on a host nobody commissioned. Both fail closed
 * on every question they cannot answer.
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
export {
  assessCommissioning,
  COMMISSIONING_CHECKS,
  formatCommissioning,
} from './internal/commissioning/assess.js';
export { parseUnit, type UnitFacts } from './internal/commissioning/units.js';
export {
  COMMISSIONING_DEFAULTS,
  type CommissioningCheck,
  type CommissioningInputs,
  type CommissioningReport,
  type CommissioningStatus,
} from './internal/commissioning/contracts.js';

export const PACKAGE = {
  name: '@kf/operations',
  role: 'Operational readiness, host commissioning and deployment secrets, fail-closed',
  owns: [],
} as const;
