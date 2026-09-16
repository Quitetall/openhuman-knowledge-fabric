import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SAS = join(ROOT, 'docs/sas/KF_Software_Architecture_Specification.md');
const PROJECTION = join(ROOT, 'docs/sas/generated/NORMATIVE.json');

/**
 * A projection agents are told to read INSTEAD of the document must contain the document.
 *
 * `war check --generated` drift-checks the projection, and drift proves a compilation is
 * REPRODUCIBLE rather than COMPLETE: a deterministic extractor drops the same sentences every
 * time, so a fresh compile matches the committed one and the check passes. On 2026-09-16 that gap
 * was real — the projection held 134 of 162 requirements, missing every one in a lettered section
 * (§8A, §8B, §48A, §64A, §64B), including KF-SAS-RQ-021, the rule forbidding container
 * synchronisation that this program had just spent two rounds of design reasoning on.
 *
 * Fixed upstream the same day, and `war check` now reports a heading it cannot label rather than
 * dropping it silently. This test is the other half: the tool checks that no section was lost,
 * this checks that every identifier this document declares actually arrived. Both are needed,
 * because they fail for different reasons — a parser that loses a heading, and a document that
 * states a requirement somewhere the extractor does not look.
 */
describe('the normative projection contains the document', () => {
  it('carries every requirement identifier the specification declares', () => {
    if (!existsSync(PROJECTION)) {
      // Not compiled is a different state from compiled-and-incomplete, and only the second is a
      // defect. `war compile` is deliberately outside `pnpm gate` — openwarrant.toml keeps KF free
      // of a Rust dependency — so an uncompiled tree is ordinary rather than wrong.
      return;
    }

    const document = readFileSync(SAS, 'utf8');
    const declared = [...document.matchAll(/^\*\*(KF-SAS-RQ-\d+)\.\*\*/gm)].map(
      (match) => match[1] as string,
    );
    expect(
      declared.length,
      'the document states requirements inline; if none parse, this test is vacuous',
    ).toBeGreaterThan(100);

    const projection: { sentences: { sentence: string }[] } = JSON.parse(
      readFileSync(PROJECTION, 'utf8'),
    );
    const present = new Set(
      projection.sentences
        .map((entry) => /^(KF-SAS-RQ-\d+)/.exec(entry.sentence)?.[1])
        .filter((id): id is string => id !== undefined),
    );

    const missing = declared
      .filter((id) => !present.has(id))
      .sort((left, right) => Number(left.slice(-3)) - Number(right.slice(-3)));

    expect(
      missing,
      'the normative projection omits requirements the specification states. An agent told to ' +
        'read it instead of the document would not know these rules exist. Recompile; if they ' +
        'are still absent, stop shipping the projection until the extractor sees them.',
    ).toEqual([]);
  });

  it('leaves no emphasis markers inside a normative sentence', () => {
    if (!existsSync(PROJECTION)) return;
    const projection: { sentences: { sentence: string }[] } = JSON.parse(
      readFileSync(PROJECTION, 'utf8'),
    );
    // The first fix left `RQ-001.** The Fabric SHALL …` — the opening marker trimmed and the
    // interior close surviving. Cosmetic in a file nobody reads; misleading in one an agent reads
    // instead of the document, because it makes the identifier look like part of the rule.
    const marked = projection.sentences
      .map((entry) => entry.sentence)
      .filter((sentence) => sentence.includes('**'));
    expect(marked.slice(0, 3), 'markdown emphasis leaked into an extracted sentence').toEqual([]);
  });
});
