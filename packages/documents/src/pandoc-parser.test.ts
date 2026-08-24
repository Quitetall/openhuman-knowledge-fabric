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

/**
 * The constructs that actually drift, which the dull one above says nothing about.
 *
 * A heading and a paragraph agreeing across two pandocs is weak evidence — those are the parts
 * of Markdown nobody changes. Tables, footnotes, raw HTML and typography are where pandoc
 * releases move, and where a content digest would change under a document that had not.
 *
 * Same discipline as the golden above: REPORTED from both hosts first, frozen only once two
 * versions have agreed. A constant frozen from one machine is that machine's output, not the
 * parser's behaviour.
 */
const DRIFT_CASES: ReadonlyArray<{ readonly name: string; readonly source: string }> = [
  { name: 'table', source: '| a | b |\n| - | - |\n| 1 | 2 |\n' },
  { name: 'footnote', source: 'Text with a note.[^1]\n\n[^1]: The note body.\n' },
  { name: 'raw-html', source: '<div class="x">\n\nInside.\n\n</div>\n' },
  { name: 'typography', source: 'He said "quoted" -- and then... an em---dash.\n' },
  { name: 'task-list', source: '- [x] done\n- [ ] not done\n' },
  { name: 'strikethrough-autolink', source: '~~gone~~ and https://example.invalid/x\n' },
  { name: 'fenced-code-attrs', source: '``` {.sql #q1}\nselect 1;\n```\n' },
  { name: 'nested-list', source: '1. one\n   - inner\n     - deeper\n2. two\n' },
  { name: 'blockquote-nested', source: '> outer\n>\n> > inner\n' },
  { name: 'entity-and-escape', source: 'A &amp; B, 5 \\* 3, café, 中文.\n' },
];

describe('the real pandoc parser', () => {
  it('records the pandoc BINARY version, not only the AST schema version', async () => {
    // The defect this was written for: `parserVersion` carried `pandoc-api-version`, the
    // pandoc-types AST SCHEMA version, which tracks pandoc-types rather than pandoc and so can
    // stay put across releases that parse differently.
    //
    // This comment previously offered 3.1.3 and 3.10.2 as a pair that "both stamp 1.23.1.2".
    // Measured, they do not — 1.23.1 and 1.23.1.2 — so for that pair the schema version happens
    // to distinguish the binaries. Wrong example, intact principle. The column
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

  it('produces the frozen content digest, which two pandoc versions agreed on', async () => {
    const parsed = await new PandocDocumentParser().parse(SOURCE, 'text/markdown');
    expect(parsed).toBeDefined();

    // FROZEN after measuring, not before. The digest was reported from both hosts first:
    //
    //   pandoc 3.1.3  (CI, ubuntu-24.04 apt)   api 1.23.1     69d199ac...
    //   pandoc 3.10.2 (workstation)            api 1.23.1.2   69d199ac...
    //
    // Same digest across roughly two years of pandoc releases, so freezing it pins real
    // behaviour rather than one machine's. `contentDigest` is a content ADDRESS in the compiler
    // runtime (`compiled-views/sha256/<digest>`), so a silent change here means one document
    // acquiring two addresses — this is the check that would notice.
    //
    // If a future pandoc breaks this, that is the finding, not a nuisance: re-measure both hosts
    // before touching the constant, and see #151 for why the version alone will not tell you.
    process.stdout.write(
      `\n[pandoc-parse] version=${parsed!.parserVersion} contentDigest=${parsed!.contentDigest}\n`,
    );

    expect(parsed!.contentDigest, 'digest is not a sha256').toMatch(/^[0-9a-f]{64}$/);
    expect(
      parsed!.contentDigest,
      'the parse changed — re-measure on a second pandoc before updating this constant',
    ).toBe('69d199ac5ab1f209effe9642b606f18518c17265d3132baac0de983799b5599f');
    expect(parsed!.parser).toBe('pandoc');
    expect(parsed!.atoms.length, 'a heading and a paragraph should be two atoms').toBe(2);
    // `text`, not `textContent` — the latter is the COLUMN name on content.document_atom, and
    // guessing it here produced two `undefined`s that compared unequal for the right reason.
    expect(parsed!.atoms.map((atom) => atom.text)).toEqual(['Heading', 'One fact, one owner.']);
    expect(parsed!.atoms.map((atom) => atom.kind)).toEqual(['heading', 'paragraph']);
  });

  it('reports a digest per drift-prone construct, for freezing once two hosts agree', async () => {
    // Not yet asserted against constants, on purpose. Freezing these from this machine would
    // record what pandoc 3.10.2 does and call it the contract; the whole point of the exercise
    // above was that a golden is only worth having once a second version has agreed with it.
    const parser = new PandocDocumentParser();
    const lines: string[] = [];
    for (const { name, source } of DRIFT_CASES) {
      const parsed = await parser.parse(Buffer.from(source), 'text/markdown');
      expect(parsed, `pandoc produced no parse for ${name}`).toBeDefined();
      expect(parsed!.contentDigest, `${name} digest is not a sha256`).toMatch(/^[0-9a-f]{64}$/);
      lines.push(
        `[pandoc-drift] ${name.padEnd(24)} atoms=${String(parsed!.atoms.length).padStart(2)} ` +
          `loss=${String(parsed!.conversionLoss.length)} ${parsed!.contentDigest}`,
      );
    }
    process.stdout.write(`\n${lines.join('\n')}\n`);

    // The one thing worth asserting before the comparison: every case produced SOMETHING. A
    // construct that silently yielded zero atoms would print a digest of an empty projection and
    // look like agreement between hosts while measuring nothing.
    const empty = DRIFT_CASES.filter((_, index) => lines[index]!.includes('atoms= 0'));
    expect(
      empty.map((c) => c.name),
      'these constructs parsed to no atoms at all',
    ).toEqual([]);
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
