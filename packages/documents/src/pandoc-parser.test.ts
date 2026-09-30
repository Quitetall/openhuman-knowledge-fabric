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

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PandocDocumentParser } from './internal/pandoc-parser.js';
import { DocumentParseRefused } from './internal/parse-contract.js';
import { digestOf } from '@kf/artifacts';

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
 *
 * RE-FROZEN 2026-09-24 for a FORMAT change, not a parse change: every receipt digest now carries
 * its format tag (kf-document-parse-v2, KF-SAS-RQ-016), which moves every content digest. What
 * keeps the two-host agreement intact is how the new constants were derived: from the atoms and
 * losses pandoc 3.10.2 produced, an independent Python recomputation reproduced all eleven v1
 * constants above byte for byte (so the projection did not move) and computed the v2 values now
 * frozen. A second pandoc has not been re-run since; CI's 3.1.3 is that measurement.
 */
const DRIFT_CASES: ReadonlyArray<{
  readonly name: string;
  readonly source: string;
  readonly digest: string;
}> = [
  {
    name: 'table',
    source: '| a | b |\n| - | - |\n| 1 | 2 |\n',
    digest: 'd4394d1e16eb01bdb453986231e39238991359df593bf74c9412e10e676beae2',
  },
  {
    name: 'footnote',
    source: 'Text with a note.[^1]\n\n[^1]: The note body.\n',
    digest: '0b5b3482b823ba20490a9d77bfa8a9021b5d6eb9a731de51be07dc97d6be397e',
  },
  {
    name: 'raw-html',
    source: '<div class="x">\n\nInside.\n\n</div>\n',
    digest: 'ddccd037dc321f8a3187071959b7a86526c74ea40cd84b5673d28716c78006b5',
  },
  {
    name: 'typography',
    source: 'He said "quoted" -- and then... an em---dash.\n',
    digest: '2c2f0eb759c34ac7d21a43aef14c06440d305df3306a09e22d5c761d8abfe5d3',
  },
  {
    name: 'task-list',
    source: '- [x] done\n- [ ] not done\n',
    digest: '7e7194df9007046381af29e640c63d18519db00ac6c8c17d4f4383354afe9064',
  },
  {
    name: 'strikethrough-autolink',
    source: '~~gone~~ and https://example.invalid/x\n',
    digest: '5cee6a279848b92b7e567e7510b0974a013c7fdf8823c1032b729ed1c170bfef',
  },
  {
    name: 'fenced-code-attrs',
    source: '``` {.sql #q1}\nselect 1;\n```\n',
    digest: '0102001d7b7eb99bc5ef2b88d931d1a379f9f1cfc61c1d7975c35290754b8e55',
  },
  {
    name: 'nested-list',
    source: '1. one\n   - inner\n     - deeper\n2. two\n',
    digest: 'da7586dda18af07b8a26bc00ff0e47a9ac58a9a0ecd26961c60e64b4296bcb84',
  },
  {
    name: 'blockquote-nested',
    source: '> outer\n>\n> > inner\n',
    digest: 'a100ebeb36af6681d9b81a1cd8f338076db2721355e7680e0ac90aabbca6ccb4',
  },
  {
    name: 'entity-and-escape',
    source: 'A &amp; B, 5 \\* 3, café, 中文.\n',
    digest: '28cdd6f2bdeb195e670d04e5548a96a8826cc7ec67e25b75b20612373244133c',
  },
];

describe('the real pandoc parser', () => {
  it.each(['text/markdown', 'text/plain'])(
    'records source NUL replacements before the %s reader can erase their provenance',
    async (mediaType) => {
      const source = Buffer.from('é�x\u0000\u0000y😀\u0000z');
      const parsed = await new PandocDocumentParser().parse(source, mediaType);
      expect(parsed!.sourceDigest).toBe(digestOf(source));
      expect(parsed!.atoms.map((atom) => atom.text)).toEqual(['é�x��y😀�z']);
      expect(parsed!.conversionLoss).toEqual([
        expect.objectContaining({
          code: 'nul_character_replaced',
          path: '/source',
          source: {
            replacement: 'U+FFFD',
            encoding: 'utf-8',
            offsetUnit: 'byte',
            ranges: [
              [6, 2],
              [13, 1],
            ],
          },
        }),
      ]);
    },
  );

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
    //   pandoc 3.1.3  (CI, ubuntu-24.04 apt)   api 1.23.1     69d199ac...  (kf-document-parse-v1)
    //   pandoc 3.10.2 (workstation)            api 1.23.1.2   69d199ac...  (kf-document-parse-v1)
    //
    // Re-frozen as b0c1ddd4... when the digest took its format tag (kf-document-parse-v2); see
    // DRIFT_CASES for how the new value was derived without trusting the code under test.
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
    ).toBe('b0c1ddd431e1e4fbe7ab73ed355bcb3e09e8250462fcb0399c946026aaeca3f2');
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

/**
 * The limits on the pandoc child. Each case is sized so that WITHOUT the limit under test it
 * still finishes on a shared box (a few hundred MiB, a few seconds of a stub), and WITH it the
 * refusal fires fast: the production pathologies (8.5 GB, >120 s) are never run here.
 */
describe('pandoc runs under limits a hostile source cannot choose', () => {
  let stubDirectory: string;

  beforeAll(async () => {
    stubDirectory = await mkdtemp(join(tmpdir(), 'kf-pandoc-stub-'));
  });
  afterAll(async () => {
    await rm(stubDirectory, { recursive: true, force: true });
  });

  async function stub(name: string, body: string): Promise<string> {
    const path = join(stubDirectory, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  }

  it('refuses a source that exhausts the heap ceiling, typed as memory', async () => {
    // The source has to need more heap than the ceiling on EVERY pandoc a host may carry, so
    // its size, not a parser pathology, is what exhausts it. The production case (5 000 nested
    // blockquotes, 8.5 GB) is a regression of recent readers: 1 000 of them peak near 28 MiB
    // resident under pandoc 3.10.2 and at 59 KB under 3.1.3, the version Ubuntu 24.04 ships
    // and hosted CI runs, where this test parsed happily and failed. 2 MiB of plain paragraphs
    // is ~138 MB resident on both (measured 2026-09-26: 3.1.3 138.4 MB, 3.10.2 139.0 MB, each
    // finishing unbounded in under 2 s), four times the 32 MiB ceiling, and well under the
    // 20 MiB source cap — so the refusal can only come from the heap ceiling.
    const paragraph = `${'word '.repeat(20)}\n\n`;
    const source = Buffer.from(paragraph.repeat(Math.ceil((2 * 1024 * 1024) / paragraph.length)));
    const parser = new PandocDocumentParser({ maxHeapMiB: 32 });
    const outcome = await parser.parse(source, 'text/markdown').then(
      () => 'parsed',
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(DocumentParseRefused);
    expect((outcome as DocumentParseRefused).reason).toBe('memory');
  });

  it('SIGKILLs a parse that outlives the deadline, typed as timeout', async () => {
    const sleeper = await stub('sleeper', 'exec sleep 30');
    const started = Date.now();
    const outcome = await new PandocDocumentParser({ pandocPath: sleeper, timeoutMs: 300 })
      .parse(SOURCE, 'text/markdown')
      .then(
        () => 'parsed',
        (error: unknown) => error,
      );
    expect(outcome).toBeInstanceOf(DocumentParseRefused);
    expect((outcome as DocumentParseRefused).reason).toBe('timeout');
    expect(Date.now() - started, 'the deadline did not bound the wait').toBeLessThan(5_000);
  }, 10_000);

  it('keeps only a bounded prefix of stderr', async () => {
    // 4 MiB of diagnostics; the error message must carry at most the configured slice.
    const noisy = await stub('noisy', 'head -c 4194304 /dev/zero | tr "\\0" e >&2; exit 3');
    const outcome = await new PandocDocumentParser({ pandocPath: noisy, maxStderrBytes: 1024 })
      .parse(SOURCE, 'text/markdown')
      .then(
        () => 'parsed',
        (error: unknown) => error,
      );
    expect(outcome).toBeInstanceOf(DocumentParseRefused);
    expect((outcome as DocumentParseRefused).reason).toBe('parser_failed');
    expect((outcome as Error).message.length).toBeLessThan(2048);
  });

  it('passes --sandbox and an RTS heap ceiling to the binary', async () => {
    const echo = await stub('echo-args', 'echo "$@" >&2; exit 2');
    const outcome = await new PandocDocumentParser({ pandocPath: echo, maxHeapMiB: 77 })
      .parse(SOURCE, 'text/markdown')
      .then(
        () => 'parsed',
        (error: unknown) => error,
      );
    expect((outcome as Error).message).toContain('--sandbox');
    expect((outcome as Error).message).toContain('+RTS -M77m -RTS');
  });

  it('refuses a relative pandoc path rather than searching PATH for it', async () => {
    await expect(
      new PandocDocumentParser({ pandocPath: 'pandoc' }).parse(SOURCE, 'text/markdown'),
    ).rejects.toThrow(/absolute/);
  });
});
