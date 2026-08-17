/**
 * Planted violations against the ontology consistency checker.
 *
 * The real ontology passes, so on its own the checker is only ever observed succeeding — and
 * a gate observed only passing is not known to work. Each case below breaks the ontology in
 * one specific way and asserts the checker catches THAT rule, not merely that something
 * failed.
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkOntology, loadOntology, type Ontology } from '@kf/ontology-compiler';

/**
 * Strip `readonly` so a defect can be planted, without losing the type.
 *
 * The ontology is readonly by design; planting a violation is the one legitimate reason to
 * write to it. The obvious way — `as { id: string }[]` — also erases every other field, so a
 * planted defect on a misspelled property would compile and the test would then assert that
 * the checker catches a rule it was never actually shown. Keeping the real element type means
 * the compiler still checks what is being corrupted.
 */
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

const ROOT = join(import.meta.dirname, '..', '..');
const base = loadOntology(join(ROOT, 'ontology'));

/** Rule ids raised at error severity by a mutated ontology. */
function errorsFor(mutate: (o: Ontology) => Ontology): string[] {
  return [
    ...new Set(
      checkOntology(mutate(structuredClone(base)))
        .filter((f) => f.severity === 'error')
        .map((f) => f.rule),
    ),
  ];
}

const objectType = (o: Ontology, id: string): number => o.objectTypes.findIndex((t) => t.id === id);
const machine = (o: Ontology, id: string): number => o.stateMachines.findIndex((m) => m.id === id);

describe('the real ontology is clean', () => {
  it('raises no errors', () => {
    const errs = checkOntology(base).filter((f) => f.severity === 'error');
    expect(errs.map((e) => `${e.rule} ${e.path}: ${e.message}`)).toEqual([]);
  });

  it('raises only the expected KIND of warning', () => {
    // ONT-012 counts relations still missing edge typing; ONT-009 flags actions that drive
    // no lifecycle. Any other warning means something new appeared unreviewed.
    const kinds = [...new Set(checkOntology(base).map((f) => f.rule))].sort();
    expect(kinds).toEqual(['ONT-009', 'ONT-012']);
  });
});

describe('planted violations are detected', () => {
  it('ONT-001 a token used as two different kinds', () => {
    expect(
      errorsFor((o) => {
        (o.relationTypes as Mutable<Ontology['relationTypes'][number]>[])[0]!.id =
          o.objectTypes[0]!.id;
        return o;
      }),
    ).toContain('ONT-001');
  });

  it('ONT-001 a duplicated object type', () => {
    expect(
      errorsFor((o) => {
        (o.objectTypes as unknown[]).push(structuredClone(o.objectTypes[0]));
        return o;
      }),
    ).toContain('ONT-001');
  });

  it('ONT-002 an unknown authority domain', () => {
    expect(
      errorsFor((o) => {
        (o.objectTypes as Mutable<Ontology['objectTypes'][number]>[])[0]!.authority_domain =
          'marketing';
        return o;
      }),
    ).toContain('ONT-002');
  });

  it('ONT-002 a reference to a state machine that does not exist', () => {
    expect(
      errorsFor((o) => {
        (o.objectTypes as Mutable<Ontology['objectTypes'][number]>[])[0]!.state_machine =
          'nonexistent';
        return o;
      }),
    ).toContain('ONT-002');
  });

  it('ONT-003 an unknown field type', () => {
    expect(
      errorsFor((o) => {
        (
          o.objectTypes[0]!.fields as Mutable<Ontology['objectTypes'][number]['fields'][number]>[]
        )[0]!.type = 'quaternion';
        return o;
      }),
    ).toContain('ONT-003');
  });

  it('ONT-003 an enum with no values, which can never validate', () => {
    expect(
      errorsFor((o) => {
        const i = objectType(o, 'change_record');
        const f = o.objectTypes[i]!.fields.find((x) => x.name === 'impact_domains')!;
        delete (f as { values?: unknown }).values;
        return o;
      }),
    ).toContain('ONT-003');
  });

  it('ONT-004 a symmetric relation that is not its own inverse', () => {
    expect(
      errorsFor((o) => {
        const r = o.relationTypes.find((x) => x.symmetric)!;
        (r as Mutable<Ontology['relationTypes'][number]>).inverse = 'something_else';
        return o;
      }),
    ).toContain('ONT-004');
  });

  it('ONT-004 an inverse label colliding with a forward relation id', () => {
    expect(
      errorsFor((o) => {
        (o.relationTypes as Mutable<Ontology['relationTypes'][number]>[])[0]!.inverse =
          o.relationTypes[1]!.id;
        return o;
      }),
    ).toContain('ONT-004');
  });

  it('ONT-005 a transition driven by an action that does not exist', () => {
    expect(
      errorsFor((o) => {
        const m = o.stateMachines[0]!;
        (
          m.transitions as Mutable<Ontology['stateMachines'][number]['transitions'][number]>[]
        )[0]!.action = 'teleport_project';
        return o;
      }),
    ).toContain('ONT-005');
  });

  it('ONT-005 an unreachable terminal state', () => {
    expect(
      errorsFor((o) => {
        const i = machine(o, 'work_order');
        (o.stateMachines[i] as Mutable<Ontology['stateMachines'][number]>).terminal = [
          ...o.stateMachines[i]!.terminal,
          'draft',
        ];
        (o.stateMachines[i] as Mutable<Ontology['stateMachines'][number]>).transitions =
          o.stateMachines[i]!.transitions.filter((t) => t.to !== 'closed');
        return o;
      }),
    ).toContain('ONT-005');
  });

  it('ONT-006 a transition that leaves a terminal state', () => {
    expect(
      errorsFor((o) => {
        const i = machine(o, 'work_package');
        (o.stateMachines[i]!.transitions as { from: string; to: string; action: string }[]).push({
          from: 'accepted',
          to: 'active',
          action: 'correct_record',
        });
        return o;
      }),
    ).toContain('ONT-006');
  });

  it('ONT-006 a reachable state with no exit and no terminal designation', () => {
    // This is R01-DEFECT-002 and -004 reintroduced: a record that parks forever.
    expect(
      errorsFor((o) => {
        const i = machine(o, 'initiative_project');
        (o.stateMachines[i] as Mutable<Ontology['stateMachines'][number]>).transitions =
          o.stateMachines[i]!.transitions.filter((t) => t.from !== 'parked');
        return o;
      }),
    ).toContain('ONT-006');
  });

  it('ONT-007 an action claiming to drive a machine it does not', () => {
    expect(
      errorsFor((o) => {
        const a = o.actionTypes.find((x) => x.id === 'attach_evidence')!;
        (a as Mutable<Ontology['actionTypes'][number]>).drives = ['payment'];
        return o;
      }),
    ).toContain('ONT-007');
  });

  it('ONT-007 an action that drives a machine but does not declare it', () => {
    expect(
      errorsFor((o) => {
        const a = o.actionTypes.find((x) => x.id === 'authorize_payment')!;
        (a as Mutable<Ontology['actionTypes'][number]>).drives = [];
        return o;
      }),
    ).toContain('ONT-007');
  });

  it('ONT-008 an unaudited action', () => {
    expect(
      errorsFor((o) => {
        (o.actionTypes as Mutable<Ontology['actionTypes'][number]>[])[0]!.audited = false;
        return o;
      }),
    ).toContain('ONT-008');
  });

  it('ONT-010 a rule with no enforcement point — prose-only, spec §27.1', () => {
    expect(
      errorsFor((o) => {
        (o.rules as Mutable<Ontology['rules'][number]>[])[0]!.implementation = [];
        return o;
      }),
    ).toContain('ONT-010');
  });

  it('ONT-010 a malformed rule id', () => {
    expect(
      errorsFor((o) => {
        (o.rules as Mutable<Ontology['rules'][number]>[])[0]!.id = 'finance-rule-1';
        return o;
      }),
    ).toContain('ONT-010');
  });

  it('ONT-011 a required envelope field that is not defined', () => {
    expect(
      errorsFor((o) => {
        (o as Mutable<Ontology>).envelopeRequired = [...o.envelopeRequired, 'retention_class'];
        return o;
      }),
    ).toContain('ONT-011');
  });

  it('ONT-011 an attribute shadowing an envelope field', () => {
    expect(
      errorsFor((o) => {
        (o.objectTypes[0]!.fields as { name: string; type: string; required: boolean }[]).push({
          name: 'title',
          type: 'string',
          required: false,
        });
        return o;
      }),
    ).toContain('ONT-011');
  });

  it('ONT-012 edge typing that references an object type that does not exist', () => {
    expect(
      errorsFor((o) => {
        (o.relationTypes as Mutable<Ontology['relationTypes'][number]>[])[0]!.sourceTypes = [
          'spacecraft',
        ];
        return o;
      }),
    ).toContain('ONT-012');
  });

  it('ONT-012 an empty edge-type list, which permits nothing', () => {
    expect(
      errorsFor((o) => {
        (o.relationTypes as Mutable<Ontology['relationTypes'][number]>[])[0]!.targetTypes = [];
        return o;
      }),
    ).toContain('ONT-012');
  });
});

describe('the loader rejects malformed input', () => {
  it('refuses an ontology directory containing a file no emitter reads', () => {
    // A definition nobody compiles is a rule that exists in the repository but not in the
    // system — worse than a missing one, because it looks present.
    expect(() => loadOntology(join(ROOT, 'tests', 'ontology', 'fixtures', 'stray-file'))).toThrow(
      /does not read/,
    );
  });

  it('refuses an ontology directory that is missing a required file', () => {
    expect(() => loadOntology(join(ROOT, 'tests', 'ontology', 'fixtures', 'incomplete'))).toThrow(
      /missing/,
    );
  });
});
