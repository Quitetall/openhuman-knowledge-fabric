import type { StateMachine } from '../model.js';
import type { CheckContext } from './types.js';

export function checkStateMachines(context: CheckContext): void {
  for (const m of context.ontology.stateMachines) {
    checkStateMachine(context, m);
  }
}

function checkStateMachine(context: CheckContext, m: StateMachine): void {
  const owner = context.ontology.objectTypes.find((t) => t.state_machine === m.id);
  const declared = new Set(owner?.states ?? []);
  const reachable = reachableStates(m);

  if (owner === undefined) {
    context.err(
      'ONT-005',
      `state_machines.${m.id}`,
      'no object type uses this state machine',
      'Attach it with state_machine: <id>, or remove it.',
    );
  } else if (!declared.has(m.initial)) {
    context.err(
      'ONT-005',
      `state_machines.${m.id}.initial`,
      `initial state '${m.initial}' is not in ${owner.id}.states`,
      'Add it to the object type, or correct the initial state.',
    );
  }

  for (const t of m.terminal) {
    if (owner !== undefined && !declared.has(t)) {
      context.err(
        'ONT-005',
        `state_machines.${m.id}.terminal`,
        `terminal state '${t}' is not in ${owner.id}.states`,
        'Add it to the object type, or correct the terminal list.',
      );
    }
    if (!reachable.has(t)) {
      context.err(
        'ONT-005',
        `state_machines.${m.id}.terminal`,
        `terminal state '${t}' is unreachable from '${m.initial}'`,
        'Add the missing transition. A record can never arrive at this state.',
      );
    }
  }

  checkTransitions(context, m, owner, declared);
  checkReachability(context, m, owner?.id, declared, reachable);
}

function reachableStates(m: StateMachine): Set<string> {
  const reachable = new Set([m.initial]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const tr of m.transitions) {
      if (reachable.has(tr.from) && !reachable.has(tr.to)) {
        reachable.add(tr.to);
        grew = true;
      }
    }
  }
  return reachable;
}

function checkTransitions(
  context: CheckContext,
  m: StateMachine,
  owner: { readonly id: string } | undefined,
  declared: ReadonlySet<string>,
): void {
  for (const [i, tr] of m.transitions.entries()) {
    const at = `state_machines.${m.id}.transitions[${i}]`;
    if (owner !== undefined && !declared.has(tr.from)) {
      context.err(
        'ONT-005',
        at,
        `from-state '${tr.from}' is not in ${owner.id}.states`,
        'Declare it.',
      );
    }
    if (owner !== undefined && !declared.has(tr.to)) {
      context.err('ONT-005', at, `to-state '${tr.to}' is not in ${owner.id}.states`, 'Declare it.');
    }
    if (!context.actionIds.has(tr.action)) {
      context.err(
        'ONT-005',
        at,
        `driven by undefined action '${tr.action}'`,
        'Define it in action-types.yaml. A transition nothing can trigger is dead.',
      );
    }
    if (m.terminal.includes(tr.from)) {
      context.err(
        'ONT-006',
        at,
        `leaves terminal state '${tr.from}'`,
        'Terminal means terminal. Remove the transition or the terminal designation.',
      );
    }
  }
}

function checkReachability(
  context: CheckContext,
  m: StateMachine,
  ownerId: string | undefined,
  declared: ReadonlySet<string>,
  reachable: ReadonlySet<string>,
): void {
  for (const s of reachable) {
    if (m.terminal.includes(s)) continue;
    if (!m.transitions.some((tr) => tr.from === s)) {
      context.err(
        'ONT-006',
        `state_machines.${m.id}`,
        `state '${s}' is neither terminal nor has any outgoing transition`,
        'Add a transition out, or declare the state terminal deliberately.',
      );
    }
  }
  for (const s of declared) {
    if (!reachable.has(s)) {
      context.err(
        'ONT-005',
        `object_types.${ownerId ?? '?'}.states`,
        `state '${s}' is declared but unreachable in machine '${m.id}'`,
        'Add a transition that reaches it, or remove the state.',
      );
    }
  }
}
