/**
 * @kf/qualification — qualification is evidence against a versioned pack (ADR 0038; SAS §24A,
 * KF-SAS-RQ-254 to RQ-261), and joining is its first use (ADR 0040 decision 12; RQ-275).
 *
 * One protocol, five stages, the same for every person; a role differs only in its pack. Nothing
 * in this package names a role or a title (tests/conformance/no-role-branch.test.ts).
 */

export * from './pack.js';
export * from './evaluate.js';
export * from './start-here.js';
export * from './agent-guide.js';
export * from './repository.js';
export * from './invitation.js';
export {
  QUALIFICATION_ACTION_IDS,
  QUALIFICATION_EFFECTS,
  QUALIFICATION_MATERIALIZERS,
  QUALIFICATION_PRECONDITIONS,
  QUALIFICATION_RECEIPTS,
  checkPackReferences,
  validatePackInRecord,
} from './acts.js';

export const PACKAGE = {
  name: '@kf/qualification',
  role: 'Qualification packs, records, the evaluator, Start Here and the agent-guide context',
  owns: [],
} as const;
