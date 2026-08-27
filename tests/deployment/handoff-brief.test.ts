import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `docs-references.test.ts` proves the paths a document cites exist. It says nothing about the
 * SYMBOLS and VALUES inside those files, and `docs/handoff-ingest-cli.md` is almost entirely
 * symbols and values — the payload fields and enum members a successor will type into an action
 * dispatch. A wrong member there does not fail to compile; it fails at runtime, inside a
 * transaction, with a message about an unknown source system, and the person reading it has no
 * reason to suspect the brief rather than their own code.
 *
 * So the two lists a caller cannot guess are checked in both directions. A value removed from the
 * code and left in the brief is a lie; a value added to the code and not the brief is a silently
 * incomplete instruction, which is the failure mode that actually recurs here.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const BRIEF = join(ROOT, 'docs', 'handoff-ingest-cli.md');
const ACTIONS = join(
  ROOT,
  'packages',
  'documents',
  'src',
  'internal',
  'external-artifact-actions.ts',
);

/** Reads `new Set([...])` members for a named const out of the action module's source. */
function setMembersInCode(constName: string): readonly string[] {
  const source = readFileSync(ACTIONS, 'utf8');
  const match = new RegExp(`const ${constName} = new Set\\(\\[([^\\]]*)\\]`).exec(source);
  if (match === null) throw new Error(`no ${constName} in ${ACTIONS}`);
  return [...(match[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] as string).sort();
}

/**
 * Reads the backticked members of the brief's single-line enumeration for a list. Scoped to ONE
 * LINE on purpose: the surrounding prose also names payload fields and `object_store`, so a
 * paragraph-wide match would sweep them in and the comparison would be meaningless.
 */
function documentedMembers(linePrefix: string): readonly string[] {
  const brief = readFileSync(BRIEF, 'utf8');
  const line = brief.split('\n').find((candidate) => candidate.startsWith(linePrefix));
  if (line === undefined)
    throw new Error(`brief has no line starting ${JSON.stringify(linePrefix)}`);
  return [...line.matchAll(/`([a-z_]+)`/g)].map((m) => m[1] as string).sort();
}

const SOURCE_SYSTEM_LINE = '- accepted source_system:';
const AUTHORITY_LINE = '- accepted authority:';

describe('the ingest handoff brief states the contracts a caller cannot guess', () => {
  it('lists exactly the source systems register_external_artifact accepts', () => {
    // `object_store` is deliberately absent from both: the action refuses it by name, and the
    // brief says so on a separate line rather than listing it as an option.
    expect(documentedMembers(SOURCE_SYSTEM_LINE)).toStrictEqual(
      setMembersInCode('EXTERNAL_SOURCE_SYSTEMS'),
    );
  });

  it('lists exactly the locator authorities the effect accepts', () => {
    expect(documentedMembers(AUTHORITY_LINE)).toStrictEqual(
      setMembersInCode('LOCATOR_AUTHORITIES'),
    );
  });

  it('reads a non-empty list from each side, so an empty match cannot pass as agreement', () => {
    // Guards the guard: two failed regexes both yield [], and [] === [] would report the brief
    // as correct at exactly the moment it stopped being checked.
    expect(setMembersInCode('EXTERNAL_SOURCE_SYSTEMS').length).toBeGreaterThan(0);
    expect(setMembersInCode('LOCATOR_AUTHORITIES').length).toBeGreaterThan(0);
    expect(documentedMembers(SOURCE_SYSTEM_LINE).length).toBeGreaterThan(0);
    expect(documentedMembers(AUTHORITY_LINE).length).toBeGreaterThan(0);
  });
});
