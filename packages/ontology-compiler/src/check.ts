/**
 * Ontology consistency checker.
 *
 * Every finding here is a defect that the type system cannot catch: a state nothing can
 * reach, an action that drives no transition, a rule claiming an enforcement point that
 * does not exist. These are the failures that make a machine-readable ontology quietly
 * wrong rather than loudly broken.
 */

import type { Ontology } from './model.js';

export interface Finding {
  readonly rule: string;
  readonly severity: 'error' | 'warning';
  readonly path: string;
  readonly message: string;
  readonly remediation: string;
}

const SCALAR_KINDS = new Set([
  'string',
  'uuid',
  'timestamp',
  'date',
  'uri',
  'email',
  'integer',
  'number',
  'boolean',
  'enum',
  'json',
  'object',
]);

/** Strip one `array<...>` wrapper, if present. */
function unwrap(type: string): string {
  const m = /^array<(.+)>$/.exec(type);
  return m ? m[1]! : type;
}

export function checkOntology(o: Ontology): Finding[] {
  const findings: Finding[] = [];
  const err = (rule: string, path: string, message: string, remediation: string): void => {
    findings.push({ rule, severity: 'error', path, message, remediation });
  };

  const objectIds = new Set(o.objectTypes.map((t) => t.id));
  const relationIds = new Set(o.relationTypes.map((r) => r.id));
  const actionIds = new Set(o.actionTypes.map((a) => a.id));
  const machineIds = new Set(o.stateMachines.map((m) => m.id));
  const sharedNames = new Set(o.sharedTypes.map((s) => s.name));

  // ── ONT-001 token uniqueness, across the WHOLE vocabulary ─────────────────────────────
  // Uniqueness per-kind is not enough: a reader who encounters a bare token out of context
  // must be able to resolve it to exactly one thing.
  const seen = new Map<string, string>();
  const claim = (token: string, kind: string, path: string): void => {
    const prior = seen.get(token);
    if (prior !== undefined && prior !== kind) {
      err(
        'ONT-001',
        path,
        `token '${token}' is used as both ${prior} and ${kind}`,
        'Rename one of them. A token must resolve to one meaning across the whole vocabulary.',
      );
    }
    seen.set(token, kind);
  };
  for (const t of o.objectTypes) claim(t.id, 'object type', `object_types.${t.id}`);
  for (const r of o.relationTypes) claim(r.id, 'relation type', `relation_types.${r.id}`);
  for (const a of o.actionTypes) claim(a.id, 'action type', `action_types.${a.id}`);

  const dupes = (ids: string[], kind: string): void => {
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [id, n] of counts) {
      if (n > 1) {
        err(
          'ONT-001',
          `${kind}.${id}`,
          `${kind} '${id}' is declared ${n} times`,
          'Remove the duplicate. Later declarations silently win otherwise.',
        );
      }
    }
  };
  dupes(
    o.objectTypes.map((t) => t.id),
    'object_types',
  );
  dupes(
    o.relationTypes.map((r) => r.id),
    'relation_types',
  );
  dupes(
    o.actionTypes.map((a) => a.id),
    'action_types',
  );
  dupes(
    o.stateMachines.map((m) => m.id),
    'state_machines',
  );
  dupes(
    o.rules.map((r) => r.id),
    'rules',
  );

  // ── ONT-002 object types resolve ──────────────────────────────────────────────────────
  for (const t of o.objectTypes) {
    if (!o.authorityDomains.includes(t.authority_domain)) {
      err(
        'ONT-002',
        `object_types.${t.id}.authority_domain`,
        `unknown authority domain '${t.authority_domain}'`,
        `Use one of: ${o.authorityDomains.join(', ')}`,
      );
    }
    if (t.state_machine !== null && !machineIds.has(t.state_machine)) {
      err(
        'ONT-002',
        `object_types.${t.id}.state_machine`,
        `references undefined state machine '${t.state_machine}'`,
        'Define it in state-machines.yaml or set state_machine: null.',
      );
    }
    if (t.states.length === 0) {
      err(
        'ONT-002',
        `object_types.${t.id}.states`,
        'declares no states',
        'Every object type needs at least one state, even if it has no transitions.',
      );
    }
    for (const f of t.fields) {
      const base = unwrap(f.type);
      if (!SCALAR_KINDS.has(base) && !sharedNames.has(base)) {
        err(
          'ONT-003',
          `object_types.${t.id}.fields.${f.name}`,
          `unknown field type '${f.type}'`,
          `Use a scalar kind or a shared type (${[...sharedNames].join(', ')}).`,
        );
      }
      if (base === 'enum' && (f.values === undefined || f.values.length === 0)) {
        err(
          'ONT-003',
          `object_types.${t.id}.fields.${f.name}`,
          'enum field declares no values',
          'An enum with no values can never validate. Add values, or use type: string.',
        );
      }
    }
  }

  // ── ONT-004 relation inverses ─────────────────────────────────────────────────────────
  for (const r of o.relationTypes) {
    if (r.symmetric && r.inverse !== r.id) {
      err(
        'ONT-004',
        `relation_types.${r.id}`,
        `symmetric relation must be its own inverse, got '${r.inverse}'`,
        'Set inverse to the relation id, or drop symmetric.',
      );
    }
    if (r.symmetric && r.acyclic) {
      err(
        'ONT-004',
        `relation_types.${r.id}`,
        'a symmetric relation cannot be acyclic',
        'Any symmetric edge is a two-node cycle by definition. Drop one of the flags.',
      );
    }
    // An inverse label that collides with a forward relation id would make traversal
    // ambiguous in either direction.
    if (!r.symmetric && relationIds.has(r.inverse)) {
      err(
        'ONT-004',
        `relation_types.${r.id}.inverse`,
        `inverse label '${r.inverse}' is also a forward relation id`,
        'Rename the inverse. Traversal must be unambiguous in both directions.',
      );
    }

    // ── ONT-012 edge typing ─────────────────────────────────────────────────────────────
    // An untyped relation lets an edge connect two objects that have no business being
    // connected, and nothing downstream can catch it. The R01 pack carries no edge typing,
    // so this is a WARNING that counts the remaining work rather than an error that would
    // block every build until all 34 are done.
    for (const [side, types] of [
      ['source_types', r.sourceTypes],
      ['target_types', r.targetTypes],
    ] as const) {
      if (types === undefined) {
        findings.push({
          rule: 'ONT-012',
          severity: 'warning',
          path: `relation_types.${r.id}.${side}`,
          message: `relation '${r.id}' does not declare ${side}`,
          remediation: `Declare which object types may sit at this end of '${r.id}'.`,
        });
        continue;
      }
      if (types.length === 0) {
        err(
          'ONT-012',
          `relation_types.${r.id}.${side}`,
          `${side} is empty`,
          'An empty list permits nothing. Name the types, or omit the key entirely.',
        );
      }
      for (const t of types) {
        if (!objectIds.has(t)) {
          err(
            'ONT-012',
            `relation_types.${r.id}.${side}`,
            `references undefined object type '${t}'`,
            'Define the object type or correct the reference.',
          );
        }
      }
    }
  }

  // ── ONT-005 state machines ────────────────────────────────────────────────────────────
  for (const m of o.stateMachines) {
    const owner = o.objectTypes.find((t) => t.state_machine === m.id);
    const declared = new Set(owner?.states ?? []);
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

    if (owner === undefined) {
      err(
        'ONT-005',
        `state_machines.${m.id}`,
        'no object type uses this state machine',
        'Attach it with state_machine: <id>, or remove it.',
      );
    } else if (!declared.has(m.initial)) {
      err(
        'ONT-005',
        `state_machines.${m.id}.initial`,
        `initial state '${m.initial}' is not in ${owner.id}.states`,
        'Add it to the object type, or correct the initial state.',
      );
    }

    for (const t of m.terminal) {
      if (owner !== undefined && !declared.has(t)) {
        err(
          'ONT-005',
          `state_machines.${m.id}.terminal`,
          `terminal state '${t}' is not in ${owner.id}.states`,
          'Add it to the object type, or correct the terminal list.',
        );
      }
      if (!reachable.has(t)) {
        err(
          'ONT-005',
          `state_machines.${m.id}.terminal`,
          `terminal state '${t}' is unreachable from '${m.initial}'`,
          'Add the missing transition. A record can never arrive at this state.',
        );
      }
    }

    for (const [i, tr] of m.transitions.entries()) {
      const at = `state_machines.${m.id}.transitions[${i}]`;
      if (owner !== undefined && !declared.has(tr.from)) {
        err('ONT-005', at, `from-state '${tr.from}' is not in ${owner.id}.states`, 'Declare it.');
      }
      if (owner !== undefined && !declared.has(tr.to)) {
        err('ONT-005', at, `to-state '${tr.to}' is not in ${owner.id}.states`, 'Declare it.');
      }
      if (!actionIds.has(tr.action)) {
        err(
          'ONT-005',
          at,
          `driven by undefined action '${tr.action}'`,
          'Define it in action-types.yaml. A transition nothing can trigger is dead.',
        );
      }
      if (m.terminal.includes(tr.from)) {
        err(
          'ONT-006',
          at,
          `leaves terminal state '${tr.from}'`,
          'Terminal means terminal. Remove the transition or the terminal designation.',
        );
      }
    }

    // Every non-terminal reachable state must have a way out, or a record parks there
    // forever with no terminal disposition — invisible until someone asks why.
    for (const s of reachable) {
      if (m.terminal.includes(s)) continue;
      if (!m.transitions.some((tr) => tr.from === s)) {
        err(
          'ONT-006',
          `state_machines.${m.id}`,
          `state '${s}' is neither terminal nor has any outgoing transition`,
          'Add a transition out, or declare the state terminal deliberately.',
        );
      }
    }

    for (const s of declared) {
      if (!reachable.has(s)) {
        err(
          'ONT-005',
          `object_types.${owner?.id ?? '?'}.states`,
          `state '${s}' is declared but unreachable in machine '${m.id}'`,
          'Add a transition that reaches it, or remove the state.',
        );
      }
    }
  }

  // ── ONT-007 actions ───────────────────────────────────────────────────────────────────
  const drivingActions = new Set(
    o.stateMachines.flatMap((m) => m.transitions.map((t) => t.action)),
  );
  for (const a of o.actionTypes) {
    for (const d of a.drives) {
      if (!machineIds.has(d)) {
        err(
          'ONT-007',
          `action_types.${a.id}.drives`,
          `references undefined state machine '${d}'`,
          'Define the machine or correct the reference.',
        );
      } else if (
        !o.stateMachines.find((m) => m.id === d)?.transitions.some((t) => t.action === a.id)
      ) {
        err(
          'ONT-007',
          `action_types.${a.id}.drives`,
          `claims to drive '${d}' but no transition in that machine names it`,
          'Add the transition, or remove the claim.',
        );
      }
    }
    // The reverse: an action that drives a transition must say so, or the generated
    // documentation and permission tables will under-report what it can do.
    for (const m of o.stateMachines) {
      if (m.transitions.some((t) => t.action === a.id) && !a.drives.includes(m.id)) {
        err(
          'ONT-007',
          `action_types.${a.id}.drives`,
          `drives transitions in '${m.id}' but does not list it`,
          `Add '${m.id}' to drives.`,
        );
      }
    }
    if (!a.audited) {
      err(
        'ONT-008',
        `action_types.${a.id}.audited`,
        'action is not audited',
        'Every controlled write is audited. An unaudited action has no place in this system.',
      );
    }
    if (!drivingActions.has(a.id) && a.drives.length === 0) {
      findings.push({
        rule: 'ONT-009',
        severity: 'warning',
        path: `action_types.${a.id}`,
        message: 'action drives no state transition',
        remediation:
          'Expected for actions that only attach data (attach_evidence). Otherwise it may be dead.',
      });
    }
  }

  // ── ONT-010 rules ─────────────────────────────────────────────────────────────────────
  for (const r of o.rules) {
    if (!/^KF-[A-Z]+-\d{3}$/.test(r.id)) {
      err(
        'ONT-010',
        `rules.${r.id}`,
        `rule id does not match KF-<AREA>-<nnn>`,
        'Rule ids are cited from code and tests; they must be stable and uniform.',
      );
    }
    if (r.implementation.length === 0) {
      err(
        'ONT-010',
        `rules.${r.id}.implementation`,
        'rule names no enforcement point',
        'Spec §27.1: a rule that exists only in prose is nonconforming. Name where it is enforced.',
      );
    }
    if (r.description.trim().length === 0) {
      err('ONT-010', `rules.${r.id}.description`, 'empty description', 'Describe the invariant.');
    }
  }

  // ── ONT-011 envelope ──────────────────────────────────────────────────────────────────
  const envelopeNames = new Set(o.envelopeFields.map((f) => f.name));
  for (const req of o.envelopeRequired) {
    // node_type and state are per-type and therefore not in the shared field map.
    if (req === 'node_type' || req === 'state') continue;
    if (!envelopeNames.has(req)) {
      err(
        'ONT-011',
        'meta.envelope.required',
        `required envelope field '${req}' is not defined in envelope.fields`,
        'Define it, or remove it from required.',
      );
    }
  }
  for (const t of o.objectTypes) {
    for (const f of t.fields) {
      if (envelopeNames.has(f.name)) {
        err(
          'ONT-011',
          `object_types.${t.id}.fields.${f.name}`,
          `shadows envelope field '${f.name}'`,
          'Rename the attribute. Two fields with one name make the record ambiguous.',
        );
      }
    }
  }

  return findings;
}

/** Above this many findings of one warning rule, print a count instead of every instance. */
const SUMMARISE_WARNINGS_ABOVE = 3;

/**
 * Render findings for a human.
 *
 * Errors always print in full — you cannot fix one without its exact path. Warnings that
 * repeat across the whole ontology collapse to a single counted line: a rule that fires 34
 * times says one thing, not 34 things, and printing it 34 times buries every other finding
 * and teaches the reader to skip the output entirely. The returned `Finding[]` is always
 * complete; only this presentation summarises.
 */
export function formatFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return 'ontology: OK';

  const detail = (f: Finding): string =>
    `${f.severity.toUpperCase()} ${f.rule} ${f.path}\n    ${f.message}\n    → ${f.remediation}`;

  const warnings = findings.filter((f) => f.severity === 'warning');
  const lines = findings.filter((f) => f.severity === 'error').map(detail);

  const byRule = new Map<string, Finding[]>();
  for (const w of warnings) byRule.set(w.rule, [...(byRule.get(w.rule) ?? []), w]);

  for (const [rule, group] of [...byRule].sort(([a], [b]) => a.localeCompare(b))) {
    if (group.length <= SUMMARISE_WARNINGS_ABOVE) {
      lines.push(...group.map(detail));
      continue;
    }
    const first = group[0]!;
    const sample = group
      .slice(0, 3)
      .map((f) => f.path)
      .join(', ');
    lines.push(
      `WARNING ${rule} ×${group.length}\n    ${first.message}\n    → ${first.remediation}\n` +
        `    (e.g. ${sample}, +${group.length - 3} more)`,
    );
  }

  lines.push(`\n${findings.length - warnings.length} error(s), ${warnings.length} warning(s)`);
  return lines.join('\n');
}
