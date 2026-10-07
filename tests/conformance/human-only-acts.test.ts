/**
 * The human-only acts of SAS §22, and the action types that perform them.
 *
 * KF-SAS-RQ-019: the acts §22 lists SHALL be performable only by a human actor, and the system
 * SHALL refuse them to a service actor by name. The mechanism is `requires: act` — an action
 * type that declares it is institutional, needs a live act grant, and is refused to a service
 * actor both by the dispatcher (`assertActCovered`) and by the database
 * (`core.action_requires_act_authority`, 20260924000100).
 *
 * So the requirement reduces to one checkable property: every §22 act that the dispatcher CAN
 * perform declares `requires: act`. Until draft.8 one did not — `change_document_source_holder`,
 * §22 item 3's "transferring a Source Holder" — and a service actor with a role reaching the
 * fragment could have moved its Holder.
 *
 * The map below is the link between the prose list and the action vocabulary, declared once
 * and asserted exhaustive against the specification's own list, so a new §22 item cannot land
 * without somebody saying which action performs it or why none does.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOntology } from '@kf/ontology-compiler';

const ROOT = join(import.meta.dirname, '..', '..');

interface HumanOnlyAct {
  /** The words §22 uses, so a reader can find the item. */
  readonly act: string;
  /** Action types that perform it through the dispatcher. Empty means none does. */
  readonly actions: readonly string[];
  /** Why no action type performs it, when `actions` is empty. */
  readonly notDispatchable?: string;
}

/** §22, item by item. EXHAUSTIVE: the count is checked against the specification below. */
const SECTION_22: readonly (readonly HumanOnlyAct[])[] = [
  [
    {
      act: 'Approving and signing a schema pack',
      actions: [],
      notDispatchable:
        '`pnpm ontology:approve` writes a signed approval file under release/; no action type ' +
        'exists, and the pack-drift conformance test states signing cannot be automated.',
    },
  ],
  [{ act: 'Allocating an identifier', actions: ['allocate_enterprise_identifier'] }],
  [
    {
      act: 'Accepting a document',
      actions: ['accept_document_compilation', 'approve_controlled_document'],
    },
    { act: 'transferring a Source Holder', actions: ['change_document_source_holder'] },
    { act: 'releasing a regulated model', actions: ['authorize_ml_promotion'] },
  ],
  [
    {
      act: 'Accepting cutover',
      actions: [],
      notDispatchable: 'Cutover is an operational acceptance recorded outside the act model.',
    },
  ],
  [{ act: 'Accepting an architecture decision record', actions: ['accept_decision'] }],
  [
    {
      act: 'Resolving a schema-pack defect',
      actions: [],
      notDispatchable: 'A defect is resolved by an owner decision record and a re-signed pack.',
    },
  ],
  [{ act: 'Approving restricted-data use', actions: ['issue_secure_object_capability'] }],
  [
    {
      act: 'Changing key custody',
      actions: ['register_secure_object_authority_key', 'revoke_secure_object_authority_key'],
    },
    {
      act: 'a provider allowlist',
      actions: [],
      notDispatchable: 'Provider allowlists are deployment configuration, not records.',
    },
  ],
  [
    {
      act: 'Authorizing PHI admission',
      actions: [],
      notDispatchable: '§8.5 makes that decision a refusal; no act admits PHI.',
    },
  ],
  [
    {
      act: 'Accepting a revision of this specification',
      actions: [],
      notDispatchable: '§94.2: acceptance is an owner signature on the SAS, outside the system.',
    },
  ],
];

function section22Items(): readonly string[] {
  const sas = readFileSync(
    join(ROOT, 'docs', 'sas', 'KF_Software_Architecture_Specification.md'),
    'utf8',
  );
  const start = sas.indexOf('## 22. Human-only acts');
  const end = sas.indexOf('## 23.', start);
  expect(start, 'SAS §22 not found').toBeGreaterThan(0);
  return [...sas.slice(start, end).matchAll(/^\d+\.\s+(.+)$/gm)].map((m) => m[1]!);
}

describe('SAS §22 human-only acts (KF-SAS-RQ-019)', () => {
  const ontology = loadOntology(join(ROOT, 'ontology'));
  const byId = new Map(ontology.actionTypes.map((a) => [a.id, a]));

  it('maps every item §22 lists, and no more', () => {
    const items = section22Items();
    expect(items.length, '§22 parsed to nothing').toBeGreaterThan(5);
    expect(SECTION_22).toHaveLength(items.length);
    SECTION_22.forEach((acts, index) => {
      for (const act of acts) {
        expect(items[index], `§22 item ${String(index + 1)} does not name '${act.act}'`).toContain(
          act.act,
        );
      }
    });
  });

  it('names only action types the ontology declares, and says why when it names none', () => {
    for (const act of SECTION_22.flat()) {
      for (const id of act.actions) expect(byId.has(id), `${id} is not declared`).toBe(true);
      if (act.actions.length === 0) {
        expect(act.notDispatchable ?? '', `${act.act} needs a reason`).not.toBe('');
      }
    }
  });

  it('declares requires: act on every dispatchable human-only act', () => {
    const roleOnly = SECTION_22.flat()
      .flatMap((act) => act.actions)
      .filter((id) => byId.get(id)?.requires !== 'act');
    expect(
      roleOnly,
      'these §22 acts are role-only, so a service actor holding the role could perform them',
    ).toEqual([]);
  });

  it('carries the declaration into the registry seed the database refuses from', () => {
    // The database trigger reads registry.action_type.requires_capability, which the seed
    // writes. A YAML declaration that never reached the seed would be enforced by the
    // dispatcher and not by the database, which is half of RQ-019.
    const seed = readFileSync(
      join(ROOT, 'generated', 'sql-registry', '001-ontology-seed.sql'),
      'utf8',
    );
    for (const id of SECTION_22.flat().flatMap((act) => act.actions)) {
      // The fifth column, requires_qualification (ADR 0038), is either way.
      expect(seed, `${id} is not seeded as requiring act`).toMatch(
        new RegExp(`\\('${id}', true, true, 'act', (true|false)\\)`),
      );
    }
  });
});
