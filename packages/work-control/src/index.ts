/**
 * Work control: the path from a captured initiative to a closed project, as typed actions.
 *
 * This package is where the R01 pack's ten invariants stop being prose. Each one here is
 * either a database constraint, an action precondition, or both.
 */

export {
  createControlledObject,
  optionalString,
  requireCurrency,
  requireMinor,
  requireString,
} from './objects.js';
export { WORK_CONTROL_ACTION_IDS } from './internal/action-ids.js';
export { WORK_CONTROL_MATERIALIZERS } from './internal/materializers.js';
export { WORK_CONTROL_EFFECTS } from './internal/effects.js';
export { WORK_CONTROL_PRECONDITIONS } from './internal/preconditions.js';
export { projectProgress, type ProjectProgress } from './internal/progress.js';

export const PACKAGE = {
  name: '@kf/work-control',
  role: 'Work control: projects, orders, execution, acceptance, invoicing, closure',
  owns: ['work', 'finance'],
} as const;
