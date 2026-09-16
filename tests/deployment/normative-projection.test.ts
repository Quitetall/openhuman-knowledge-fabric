import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SAS = join(ROOT, 'docs/sas/KF_Software_Architecture_Specification.md');
const PROJECTION = join(ROOT, 'docs/sas/generated/NORMATIVE.json');

/**
 * A projection agents are told to read INSTEAD of the document must contain the document.
 *
 * `war compile` emits NORMATIVE.{md,json} and its own header says "Read this instead of the
 * document". `war check --generated` then drift-checks it — but drift proves the compilation is
 * REPRODUCIBLE, not that it is COMPLETE. A deterministic extractor that drops sentences drops the
 * same ones every time, so a fresh compile matches the committed one and the check passes.
 *
 * Measured on 2026-09-16: the projection held 134 of the document's 162 requirements. The 28
 * missing ones were every requirement in a lettered section — §8A, §8B, §48A, §64A, §64B — and
 * RQ-021, the rule forbidding container synchronisation, was among them. Two rounds of design
 * reasoning had just been spent on that requirement; an agent reading the projection would have
 * concluded it did not exist.
 *
 * This test is the completeness check the drift check cannot be. It stays after the extractor is
 * fixed, because the next extractor change needs catching too.
 */
/**
 * The 28 requirements the current `war` drops, recorded exactly.
 *
 * This is a defect record, not an expectation. Every one lives in a lettered section — §8A, §8B,
 * §48A, §64A, §64B — which the extractor's heading parser does not match. It is pinned rather
 * than tolerated: the test fails if the set grows (a new section shape stops parsing) AND if it
 * shrinks (upstream fixed it, and this list plus `docs/normative-projection.md` should go).
 *
 * Deleting the projection instead was tried and is not available: `openwarrant.toml` sets
 * `[generated] commit = true`, so `war check --generated` errors on its absence. Keeping a file
 * that is known-wrong is the lesser fault only while the wrongness is written down this precisely.
 */
const KNOWN_ABSENT = [
  'KF-SAS-RQ-020',
  'KF-SAS-RQ-021',
  'KF-SAS-RQ-200',
  'KF-SAS-RQ-201',
  'KF-SAS-RQ-202',
  'KF-SAS-RQ-203',
  'KF-SAS-RQ-204',
  'KF-SAS-RQ-210',
  'KF-SAS-RQ-211',
  'KF-SAS-RQ-212',
  'KF-SAS-RQ-213',
  'KF-SAS-RQ-214',
  'KF-SAS-RQ-215',
  'KF-SAS-RQ-216',
  'KF-SAS-RQ-217',
  'KF-SAS-RQ-218',
  'KF-SAS-RQ-219',
  'KF-SAS-RQ-220',
  'KF-SAS-RQ-221',
  'KF-SAS-RQ-222',
  'KF-SAS-RQ-223',
  'KF-SAS-RQ-224',
  'KF-SAS-RQ-225',
  'KF-SAS-RQ-227',
  'KF-SAS-RQ-228',
  'KF-SAS-RQ-229',
  'KF-SAS-RQ-230',
  'KF-SAS-RQ-231',
] as const;

describe('the normative projection contains the document', () => {
  function missingFromProjection(): string[] {
    const document = readFileSync(SAS, 'utf8');
    const declared = [...document.matchAll(/^\*\*(KF-SAS-RQ-\d+)\.\*\*/gm)].map(
      (match) => match[1] as string,
    );
    const projection: { sentences: { sentence: string }[] } = JSON.parse(
      readFileSync(PROJECTION, 'utf8'),
    );
    const present = new Set(
      projection.sentences
        .map((entry) => /^(KF-SAS-RQ-\d+)/.exec(entry.sentence)?.[1])
        .filter((id): id is string => id !== undefined),
    );
    return declared
      .filter((id) => !present.has(id))
      .sort((a, b) => Number(a.slice(-3)) - Number(b.slice(-3)));
  }

  it('omits exactly the requirements a known extractor defect drops, and no others', () => {
    if (!existsSync(PROJECTION)) return; // `war compile` is not part of `pnpm gate`, by design.
    expect(
      missingFromProjection(),
      'the set of requirements absent from the normative projection has changed. If it GREW, a ' +
        'section shape stopped parsing and agents are now missing more rules than recorded. If ' +
        'it SHRANK, the extractor was fixed — delete KNOWN_ABSENT, delete ' +
        'docs/normative-projection.md, and let this test assert completeness outright.',
    ).toEqual([...KNOWN_ABSENT]);
  });

  it('is not relied upon while it is incomplete', () => {
    // The note exists so that a reader who finds the projection knows not to trust it. It goes
    // when KNOWN_ABSENT goes.
    expect(existsSync(join(ROOT, 'docs/normative-projection.md'))).toBe(
      !existsSync(PROJECTION) || KNOWN_ABSENT.length > 0,
    );
  });
});
