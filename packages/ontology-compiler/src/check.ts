/**
 * Ontology consistency checker.
 *
 * Every finding here is a defect that the type system cannot catch: a state nothing can
 * reach, an action that drives no transition, a rule claiming an enforcement point that
 * does not exist.
 */

import type { Ontology } from './model.js';
import { checkActions } from './check/actions.js';
import { createCheckContext } from './check/context.js';
import { checkObjectTypes, checkRelationTypes } from './check/object-relations.js';
import { checkRulesAndEnvelope } from './check/rules-envelope.js';
import { checkStateMachines } from './check/state-machines.js';
import { checkTokenUniqueness } from './check/tokens.js';
import type { Finding } from './check/types.js';

export type { Finding } from './check/types.js';
export { formatFindings } from './check/format.js';

export function checkOntology(o: Ontology): Finding[] {
  const context = createCheckContext(o);
  checkTokenUniqueness(context);
  checkObjectTypes(context);
  checkRelationTypes(context);
  checkStateMachines(context);
  checkActions(context);
  checkRulesAndEnvelope(context);
  return context.findings;
}
