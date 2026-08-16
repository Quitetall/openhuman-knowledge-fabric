/**
 * Every action the ontology declares has an owner, and every owner's action is declared.
 *
 * The dispatcher already refuses both halves at RUNTIME: an action type nobody owns is not in
 * `allowedActions`, and one the ontology does not define is refused by the kernel. Both are
 * fail-closed, and both are discovered by a caller getting a refusal for something that was
 * supposed to work.
 *
 * That is late. Adding an action type to `ontology/action-types.yaml` and forgetting to
 * register a handler produces a declared, documented, schema-validated action that can never
 * be performed, and nothing says so until somebody tries it. The reverse — a handler for an
 * action the ontology does not know — is caught by `composeActionAtoms` throwing at startup,
 * which is better but still not at review time.
 *
 * Measured 104 = 104 exactly, in both directions, at the time this was written.
 *
 * The document group is included explicitly because `fabricDispatcherOptions()` takes its
 * atoms as an argument: they exist only when an object store and parser are configured, so
 * calling the composer with no arguments reports the 13 document actions as unowned. That is
 * correct behaviour and a trap for anyone measuring coverage — the first run of this check
 * "found" 13 orphans that were nothing of the kind.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_ACTION_IDS } from '@kf/documents';
import { fabricDispatcherOptions } from '@kf/orchestrator';

const ROOT = join(import.meta.dirname, '..', '..');

/** Action ids as the ontology declares them, read from source rather than from a build. */
function declaredActionIds(): readonly string[] {
  const yaml = readFileSync(join(ROOT, 'ontology', 'action-types.yaml'), 'utf8');
  const ids = [...yaml.matchAll(/^\s*-\s*id:\s*([a-z0-9_]+)/gm)].map((match) => match[1]!);
  // A parse that silently found nothing would make every assertion below vacuously true.
  expect(ids.length, 'no action ids parsed out of ontology/action-types.yaml').toBeGreaterThan(50);
  return ids;
}

/** Everything a fully-configured deployment can dispatch. */
function ownedActionIds(): ReadonlySet<string> {
  return new Set([...fabricDispatcherOptions().allowedActions, ...DOCUMENT_ACTION_IDS]);
}

describe('the ontology and the dispatcher agree on what an action is', () => {
  it('declares no action that nothing can perform', () => {
    const owned = ownedActionIds();
    const orphaned = declaredActionIds().filter((id) => !owned.has(id));
    expect(
      orphaned,
      'these action types are declared, documented and schema-valid, and no group owns them, ' +
        'so a caller asking for one gets refused for a reason that reads like their mistake',
    ).toEqual([]);
  });

  it('owns no action the ontology has never heard of', () => {
    const declared = new Set(declaredActionIds());
    const undeclared = [...ownedActionIds()].filter((id) => !declared.has(id));
    expect(
      undeclared,
      'these handlers are registered for action types the ontology does not define, so the ' +
        'kernel refuses them and the registration is dead weight that reads as coverage',
    ).toEqual([]);
  });

  it('refuses with a declared invariant id only where that invariant claims to be a precondition', () => {
    // `ontology/rules.yaml` gives each invariant an `implementation:` list. An id that claims
    // only `[database_constraint, validator]` is enforced by the schema and by the release
    // pack's validator — NOT by a refusal a caller sees, so raising it from an action effect
    // tells that caller the record is structurally malformed when it may be nothing of the
    // kind.
    //
    // KF-WORK-001 — "a work_execution references exactly one work_order" — was raised for
    // "issue_acceptance must name the work execution being judged", which is a caller who
    // named no target. KF-FIN-001 — the work-order ceiling rule, whose remedy is to raise an
    // amendment — was raised for "amend_work_order must name a work order", where that advice
    // is actively wrong. Both now use `KF-*-TARGET-*` codes, following the convention the
    // documents package already uses for local conditions.
    const rules = readFileSync(join(ROOT, 'ontology', 'rules.yaml'), 'utf8');
    const declared = new Map<string, string>(
      [
        ...rules.matchAll(
          /- id:\s*(KF-[A-Z0-9-]+)[\s\S]*?implementation:\s*\[([^\]]*)\]/g,
        ),
      ].map((match) => [match[1]!, match[2]!]),
    );
    expect(declared.size, 'no invariants parsed out of ontology/rules.yaml').toBeGreaterThan(5);

    const sources = execFileSync(
      'grep',
      ['-rho', '--include=*.ts', "refuse[A-Za-z]*(\\s*'KF-[A-Z0-9-]*'", 'packages', 'apps'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    const used = new Set(
      [...sources.matchAll(/'(KF-[A-Z0-9-]+)'/g)].map((match) => match[1]!),
    );

    const misapplied = [...used]
      .filter((id) => declared.has(id))
      .filter((id) => !declared.get(id)!.includes('action_precondition'));
    expect(
      misapplied,
      'these declared invariants are raised as refusals while their own implementation list ' +
        'says they are enforced elsewhere',
    ).toEqual([]);
  });

  it('gives every action exactly one owner', () => {
    // `composeActionAtoms` throws on a duplicate rather than letting the last registration
    // win, which is what makes "who owns this action" answerable at all. Asserted here so the
    // property is stated where somebody looks for it, not only where it is enforced.
    const owned = ownedActionIds();
    const all = [...fabricDispatcherOptions().allowedActions, ...DOCUMENT_ACTION_IDS];
    expect(all.length, 'an action id is claimed by more than one group').toBe(owned.size);
  });
});
