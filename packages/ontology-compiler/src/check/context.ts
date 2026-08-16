import type { Ontology } from '../model.js';
import type { CheckContext, Finding } from './types.js';

export function createCheckContext(ontology: Ontology): CheckContext {
  const findings: Finding[] = [];
  return {
    ontology,
    findings,
    objectIds: new Set(ontology.objectTypes.map((t) => t.id)),
    relationIds: new Set(ontology.relationTypes.map((r) => r.id)),
    actionIds: new Set(ontology.actionTypes.map((a) => a.id)),
    machineIds: new Set(ontology.stateMachines.map((m) => m.id)),
    sharedNames: new Set(ontology.sharedTypes.map((s) => s.name)),
    err(rule: string, path: string, message: string, remediation: string): void {
      findings.push({ rule, severity: 'error', path, message, remediation });
    },
  };
}
