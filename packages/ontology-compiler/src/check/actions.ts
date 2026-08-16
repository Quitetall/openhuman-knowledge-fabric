import type { CheckContext } from './types.js';

export function checkActions(context: CheckContext): void {
  const drivingActions = new Set(
    context.ontology.stateMachines.flatMap((m) => m.transitions.map((t) => t.action)),
  );
  for (const a of context.ontology.actionTypes) {
    for (const d of a.drives) {
      if (!context.machineIds.has(d)) {
        context.err(
          'ONT-007',
          `action_types.${a.id}.drives`,
          `references undefined state machine '${d}'`,
          'Define the machine or correct the reference.',
        );
      } else if (
        !context.ontology.stateMachines
          .find((m) => m.id === d)
          ?.transitions.some((t) => t.action === a.id)
      ) {
        context.err(
          'ONT-007',
          `action_types.${a.id}.drives`,
          `claims to drive '${d}' but no transition in that machine names it`,
          'Add the transition, or remove the claim.',
        );
      }
    }
    for (const m of context.ontology.stateMachines) {
      if (m.transitions.some((t) => t.action === a.id) && !a.drives.includes(m.id)) {
        context.err(
          'ONT-007',
          `action_types.${a.id}.drives`,
          `drives transitions in '${m.id}' but does not list it`,
          `Add '${m.id}' to drives.`,
        );
      }
    }
    if (!a.audited) {
      context.err(
        'ONT-008',
        `action_types.${a.id}.audited`,
        'action is not audited',
        'Every controlled write is audited. An unaudited action has no place in this system.',
      );
    }
    if (!drivingActions.has(a.id) && a.drives.length === 0) {
      context.findings.push({
        rule: 'ONT-009',
        severity: 'warning',
        path: `action_types.${a.id}`,
        message: 'action drives no state transition',
        remediation:
          'Expected for actions that only attach data (attach_evidence). Otherwise it may be dead.',
      });
    }
  }
}
