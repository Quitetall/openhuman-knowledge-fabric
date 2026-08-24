/**
 * The first test in this repository that runs the real pandoc binary.
 *
 * Everything else parses with a hand-written stub — the dogfood test defines one inline — so the
 * production parser path had no coverage at all, despite CI installing pandoc specifically so it
 * would work. `spawn('pandoc')` failing, or pandoc parsing differently, would first have been
 * noticed by a person looking at a document.
 *
 * WHY IT MATTERS MORE THAN COVERAGE. `contentDigest` is derived from the atoms and used as a
 * content address (`compiled-views/sha256/<digest>` in the compiler runtime). Two hosts that parse
 * one document differently produce two addresses for one document. This box runs pandoc 3.10.2 and
 * CI runs 3.1.3, so that is not hypothetical here.
 *
 * The digest is REPORTED rather than asserted against a frozen golden, deliberately and for now.
 * Freezing it before knowing whether 3.1.3 and 3.10.2 agree would either pin a value that is
 * already host-dependent, or turn a discovery into a red build on a guess. Print it on both, read
 * both, then freeze — task #151.
 */

import { describe, expect, it } from 'vitest';
import { PandocDocumentParser } from './internal/pandoc-parser.js';

/** Deliberately dull constructs: a heading and a paragraph, whose parse should be stable. */
const SOURCE = Buffer.from('# Heading\n\nOne fact, one owner.\n');

describe('the real pandoc parser', () => {
  it('records the pandoc BINARY version, not only the AST schema version', async () => {
    // The defect this was written for: `parserVersion` carried `pandoc-api-version`, the
    // pandoc-types AST SCHEMA version. That moves only when the AST shape changes, so a long run
    // of pandoc releases share one value — 3.1.3 and 3.10.2 both stamp `1.23.1.2`. The column
    // comment on content.document_parse already claimed the field "identifies only upstream
    // Pandoc"; it did not, and three rows on the dev database say `1.23.1.2` with nothing to say
    // which pandoc wrote them.
    const parsed = await new PandocDocumentParser().parse(SOURCE, 'text/markdown');
    expect(parsed, 'pandoc produced no parse for text/markdown').toBeDefined();

    // Shape: <binary>+api.<ast schema>. Asserting the SHAPE and that the two halves differ,
    // rather than a literal, because the point is that both are present and distinct.
    const [binary, api] = parsed!.parserVersion.split('+api.');
    expect(parsed!.parserVersion, 'parserVersion lost its +api. suffix').toContain('+api.');
    expect(binary, 'binary half is not a version').toMatch(/^\d+\.\d+/);
    expect(api, 'api half is not a version').toMatch(/^\d+\.\d+/);
    expect(
      binary,
      'binary and api version are identical, so one of them is not what it claims to be',
    ).not.toBe(api);
  });

  it('reports the content digest so two hosts can be compared before one is frozen', async () => {
    const parsed = await new PandocDocumentParser().parse(SOURCE, 'text/markdown');
    expect(parsed).toBeDefined();

    // Read this off CI and off a workstation. Equal means the parse is version-stable across the
    // range we actually run and the digest can be frozen here; unequal is the answer to #151 and
    // means a pinned pandoc is a correctness requirement, not housekeeping.
    process.stdout.write(
      `\n[pandoc-parse] version=${parsed!.parserVersion} contentDigest=${parsed!.contentDigest}\n`,
    );

    expect(parsed!.contentDigest, 'digest is not a sha256').toMatch(/^[0-9a-f]{64}$/);
    expect(parsed!.parser).toBe('pandoc');
    expect(parsed!.atoms.length, 'a heading and a paragraph should be two atoms').toBe(2);
    // `text`, not `textContent` — the latter is the COLUMN name on content.document_atom, and
    // guessing it here produced two `undefined`s that compared unequal for the right reason.
    expect(parsed!.atoms.map((atom) => atom.text)).toEqual(['Heading', 'One fact, one owner.']);
    expect(parsed!.atoms.map((atom) => atom.kind)).toEqual(['heading', 'paragraph']);
  });

  it('is deterministic within one host, which the cross-host question presumes', async () => {
    // If the same binary on the same bytes were not stable, comparing two hosts would be
    // meaningless. Cheap to check and it makes the comparison above worth making.
    const parser = new PandocDocumentParser();
    const first = await parser.parse(SOURCE, 'text/markdown');
    const second = await parser.parse(SOURCE, 'text/markdown');
    expect(second!.contentDigest).toBe(first!.contentDigest);
    expect(second!.parserVersion).toBe(first!.parserVersion);
  });
});
