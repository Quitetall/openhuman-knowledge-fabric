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
 * THE ORDER MATTERS AND IS THE POINT. Every digest here was REPORTED from both hosts first and
 * frozen only after they agreed — eleven of them, all identical across the two versions. Freezing
 * from one machine records that machine's output and calls it a contract, which is the same
 * failure as a check that cannot fail, wearing different clothes.
 *
 * Digests are still printed on every run even though they are now asserted: when one moves, the
 * first question is always what the other host produces, and having the line already in the log
 * saves a re-run to find out. Resolved as task #151 — no pandoc pin required.
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
 *
 * FROZEN 2026-08-24. All ten digests are byte-identical on pandoc 3.1.3 (CI, ubuntu-24.04 apt)
 * and 3.10.2 (workstation) — compared by diffing the two lists rather than by reading hex, which
 * is not a thing anyone should check by eye. Roughly two years of pandoc releases separate them,
 * and nothing here moved, so "no version pin required" (#151) now rests on the constructs that
 * could actually have broken it rather than on a heading and a paragraph.
 *
 * A failure here is a FINDING, not a chore. Re-measure on a second pandoc before touching any
 * constant: if both hosts moved together the projection changed, and if only one moved pandoc
 * did.
 */
const DRIFT_CASES: ReadonlyArray<{
  readonly name: string;
  readonly source: string;
  readonly digest: string;
}> = [
  {
    name: 'table',
    source: '| a | b |\n| - | - |\n| 1 | 2 |\n',
    digest: '04c6f04199dcf997c1d9c13da98e1da37efee19dcd91a0e5f15edcdb0089a79a',
  },
  {
    name: 'footnote',
    source: 'Text with a note.[^1]\n\n[^1]: The note body.\n',
    digest: '839879b61af4229f110ef55a45072b48f3192c51a118c0c7ddc56463f5bd0b82',
  },
  {
    name: 'raw-html',
    source: '<div class="x">\n\nInside.\n\n</div>\n',
    digest: 'af41a99ea78570ef81b0e6b185700810715d07108e78385370ab2cc417f3fdb6',
  },
  {
    name: 'typography',
    source: 'He said "quoted" -- and then... an em---dash.\n',
    digest: '4bdf2414ac8b47d6d24bb263a48ebfb5ab51826629d84030e9fe89a07fd20c89',
  },
  {
    name: 'task-list',
    source: '- [x] done\n- [ ] not done\n',
    digest: '0193c8baecb646ab9be8fd9a7845aae0206dc4ef432f05e3f6183ba36429c37f',
  },
  {
    name: 'strikethrough-autolink',
    source: '~~gone~~ and https://example.invalid/x\n',
    digest: '9957a975c2ef27047a899ec614bfdb246fb17a58dfe2f7fdad7872a9a42fffdf',
  },
  {
    name: 'fenced-code-attrs',
    source: '``` {.sql #q1}\nselect 1;\n```\n',
    digest: '826341687a7e0136557914d00e5ea6945f474f1c249f9d782b8673fd3fa11898',
  },
  {
    name: 'nested-list',
    source: '1. one\n   - inner\n     - deeper\n2. two\n',
    digest: '016e59fc5a6a13851decd6484a161c5e49bb2e7553ac51d254d20af5693e250f',
  },
  {
    name: 'blockquote-nested',
    source: '> outer\n>\n> > inner\n',
    digest: '810e62a530d5919a500b24f23c38bc47d648c3d3ebaafb900adbaedbea8b4456',
  },
  {
    name: 'entity-and-escape',
    source: 'A &amp; B, 5 \\* 3, café, 中文.\n',
    digest: 'e800952dc48f05b859c0b6e4a51c0eb137551218996df0e99fcedadd288095b5',
  },
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

  it('holds the frozen digest for every drift-prone construct', async () => {
    const parser = new PandocDocumentParser();
    const lines: string[] = [];
    const drifted: string[] = [];
    const empty: string[] = [];

    for (const { name, source, digest } of DRIFT_CASES) {
      const parsed = await parser.parse(Buffer.from(source), 'text/markdown');
      expect(parsed, `pandoc produced no parse for ${name}`).toBeDefined();
      lines.push(
        `[pandoc-drift] ${name.padEnd(24)} atoms=${String(parsed!.atoms.length).padStart(2)} ` +
          `loss=${String(parsed!.conversionLoss.length)} ${parsed!.contentDigest}`,
      );
      // Zero atoms would be an empty projection, whose digest is identical everywhere —
      // agreement that measures nothing. Checked apart from the digest so a failure says which
      // of the two went wrong.
      if (parsed!.atoms.length === 0) empty.push(name);
      if (parsed!.contentDigest !== digest) {
        drifted.push(
          `${name}: frozen ${digest.slice(0, 12)} got ${parsed!.contentDigest.slice(0, 12)}`,
        );
      }
    }
    // Printed on every run, not only on failure: when one of these moves the next question is
    // always what the OTHER host produces, and the full line in the log saves a re-run.
    process.stdout.write(`\n${lines.join('\n')}\n`);

    expect(empty, 'these constructs parsed to no atoms at all').toEqual([]);
    expect(
      drifted,
      'the parse moved — re-measure on a second pandoc BEFORE updating any constant: both hosts ' +
        'moving means the projection changed, one host moving means pandoc did',
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
