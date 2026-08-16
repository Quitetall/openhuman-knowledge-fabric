import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createNodeLamQuantCommandRunner,
  nodeLamQuantCommandRunner,
  nodeLamQuantCompatibilityFileSystem,
  runLamQuantCompatibilityOracle,
  type LamQuantCommandRequest,
} from './lamquant-compat.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function sourceFixture(): Promise<string> {
  const source = await mkdtemp(join(tmpdir(), 'kf-lamquant-source-'));
  temporaryPaths.push(source);
  await mkdir(join(source, 'docs', 'atoms', 'core', 'deprecated'), { recursive: true });
  await mkdir(join(source, 'docs', 'decisions'), { recursive: true });
  await mkdir(join(source, 'docs', 'topics'), { recursive: true });
  await mkdir(join(source, 'docs', '_dist'), { recursive: true });
  await mkdir(join(source, 'tools'), { recursive: true });
  await mkdir(join(source, 'tools', 'scripts'), { recursive: true });
  await mkdir(join(source, 'tests', 'contracts', 'architecture'), { recursive: true });
  await mkdir(join(source, '.github', 'workflows'), { recursive: true });
  await mkdir(join(source, 'codec-neural', 'lamquant_neural', 'models'), { recursive: true });
  await writeFile(join(source, 'docs', 'MASTER.md'), '# Master\n\n- [Parent](PARENT.md)\n');
  await writeFile(
    join(source, 'docs', 'compose.toml'),
    [
      '[[parent]]',
      'file = "docs/PARENT.md"',
      'node = "parent"',
      'title = "Parent"',
      'parent = "MASTER.md"',
      'diataxis = "reference"',
      'topics = ["codec"]',
      'atoms = [',
      '  "docs/atoms/core/a.md",',
      '  "docs/atoms/core/deprecated/old.md",',
      '  "docs/atoms/core/b.md",',
      ']',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(source, 'docs', 'topics.toml'),
    ['[[topic]]', 'slug = "codec"', 'desc = "Codec"', ''].join('\n'),
  );
  await writeFile(
    join(source, 'docs', 'TRUTH_LEDGER.md'),
    [
      '## §2 — Current verified fullband numbers',
      '',
      '| # | What | Value |',
      '|---|---|---|',
      '| 2.2 | Sample | **42 Hz** |',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(source, 'docs', 'atoms', 'core', 'a.md'),
    [
      '---',
      'kind: atom',
      'title: A',
      'topics: [codec]',
      'supersedes: ["docs/atoms/core/deprecated/old.md"]',
      'links:',
      '  code: [codec-neural/lamquant_neural/models/encoder.py]',
      '  adr: [0001]',
      '---',
      '## A',
      '',
      'Bound: {{ledger:2.2}}.',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(source, 'docs', 'atoms', 'core', 'deprecated', 'old.md'),
    [
      '---',
      'kind: atom',
      'title: Old',
      'status: deprecated',
      'deprecated_on: "2026-08-15"',
      'superseded_by: ["docs/atoms/core/a.md"]',
      'topics: [codec]',
      '---',
      '## Old',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(source, 'docs', 'atoms', 'core', 'b.md'),
    [
      '---',
      'kind: atom',
      'title: B',
      'topics: [codec]',
      '---',
      '## B',
      '',
      'Second atom.',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(source, 'docs', 'decisions', '0001-test.md'),
    [
      '---',
      'status: accepted',
      'topics: [codec]',
      'supersedes: ["0000"]',
      '---',
      '# ADR 0001: Test',
      '',
      '## Decision',
      '',
      'Use the test decision.',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(source, 'codec-neural', 'lamquant_neural', 'models', 'encoder.py'),
    '# encoder\n',
  );
  await writeGeneratedCompatibilityOutputs(source);
  await Promise.all(
    [
      'doc_tree_lint.py',
      'doc_tree_lint.allow',
      'scripts/check_identifier_collisions.py',
      'adr_lint.py',
      'doc_compose.py',
      'doc_views.py',
      'doc_book.py',
      'doc_fm.py',
      'adr_model.py',
      'adr_closure_debt.toml',
    ].map((name) =>
      writeFile(
        join(source, 'tools', name),
        name === 'adr_closure_debt.toml' ? 'missing_gate = ["0001"]\n' : `${name}\n`,
      ),
    ),
  );
  await writeFile(
    join(source, 'tests', 'contracts', 'architecture', 'test_adr_governance.py'),
    'test_adr_governance.py\n',
  );
  await writeFile(join(source, '.github', 'workflows', 'audit.yml'), 'audit.yml\n');
  return source;
}

async function writeGeneratedCompatibilityOutputs(
  root: string,
  mismatch?: 'parent' | 'topic' | 'book' | 'missingAtom' | 'reorderedAtom',
) {
  const a = [
    '## A',
    '',
    `Bound: ${mismatch === 'parent' ? 'wrong' : '42 Hz'}.`,
    '',
    '> _Supersedes (deprecated, sequestered): [Old](atoms/core/deprecated/old.md)._',
  ].join('\n');
  const b = ['## B', '', 'Second atom.'].join('\n');
  const bodies = mismatch === 'missingAtom' ? [a] : mismatch === 'reorderedAtom' ? [b, a] : [a, b];
  await writeFile(
    join(root, 'docs', 'PARENT.md'),
    [
      '---',
      'kind: composite',
      '---',
      '<!-- GENERATED by test fixture -->',
      '# Parent',
      '',
      bodies.join('\n\n'),
      '',
    ].join('\n'),
  );
  await writeFile(
    join(root, 'docs', 'topics', 'codec.md'),
    [
      '# Topic codec',
      '',
      '## Docs',
      '',
      '### [Parent](../PARENT.md)',
      mismatch === 'topic' ? '' : '- A',
      '- B',
      '',
      '## Decisions (ADRs)',
      '',
      '- [ADR 0001 — Test](../../docs/decisions/0001-test.md)',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(root, 'docs', 'ADR_OVERVIEW.md'),
    [
      '# ADR Overview',
      '',
      '| [0001](decisions/0001-test.md) | Test | `codec` | debt | supersedes 0000 |',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(root, 'docs', 'topics', 'adr-index.md'),
    ['# ADR index', '', '| [0001](../../docs/decisions/0001-test.md) | Test | `codec` |', ''].join(
      '\n',
    ),
  );
  await writeFile(
    join(root, 'docs', 'topics', 'adr-digest.md'),
    '# ADR digest\n\n### ADR 0001 — Test\n',
  );
  await writeFile(
    join(root, 'docs', 'TRACEABILITY_MATRIX.md'),
    [
      '# Traceability Matrix',
      '',
      '| Component | Subsystem | Code | ADR | Hazard | Test |',
      '|---|---|---|---|---|---|',
      '| A | parent | codec-neural/lamquant_neural/models/encoder.py | 0001 | — | — |',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(root, 'docs', '_dist', 'BOOK.md'),
    ['# Book', mismatch === 'book' ? '- `docs/OTHER.md`' : '- `docs/PARENT.md`', ''].join('\n'),
  );
}

async function docsManifest(root: string) {
  const files: string[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path, relative);
      if (entry.isFile()) files.push(relative);
    }
  }
  await walk(join(root, 'docs'), '');
  return Promise.all(
    files.sort().map(async (path) => ({
      path: `docs/${path}`,
      sha256: createHash('sha256')
        .update(await readFile(join(root, 'docs', path)))
        .digest('hex'),
    })),
  );
}

describe('LamQuant compatibility oracle preconditions', () => {
  it('rejects a moving git ref before touching the checkout', async () => {
    const run = vi.fn();

    await expect(
      runLamQuantCompatibilityOracle(
        {
          checkoutPath: '/source/lamquant',
          commitSha: 'main',
          expectedManifest: [{ path: 'docs/MASTER.md', sha256: '0'.repeat(64) }],
        },
        {
          commandRunner: { run } as never,
          fileSystem: {} as never,
        },
      ),
    ).rejects.toMatchObject({ reason: 'unpinned' });
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects a missing checkout before invoking git', async () => {
    const run = vi.fn();
    const kind = vi.fn().mockResolvedValue('missing');

    await expect(
      runLamQuantCompatibilityOracle(
        {
          checkoutPath: '/source/lamquant',
          commitSha: 'a'.repeat(40),
          expectedManifest: [{ path: 'docs/MASTER.md', sha256: '0'.repeat(64) }],
        },
        {
          commandRunner: { run } as never,
          fileSystem: { kind } as never,
        },
      ),
    ).rejects.toMatchObject({ reason: 'missing_input' });
    expect(kind).toHaveBeenCalledWith('/source/lamquant');
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects a checkout whose HEAD is not the requested pin', async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: `${'b'.repeat(40)}\n`,
      stderr: '',
    });

    await expect(
      runLamQuantCompatibilityOracle(
        {
          checkoutPath: '/source/lamquant',
          commitSha: 'a'.repeat(40),
          expectedManifest: [{ path: 'docs/MASTER.md', sha256: '0'.repeat(64) }],
        },
        {
          commandRunner: { run },
          fileSystem: { kind: async () => 'directory' },
        },
      ),
    ).rejects.toMatchObject({ reason: 'unpinned' });
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith({
      executable: 'git',
      args: ['rev-parse', '--verify', 'HEAD'],
      cwd: '/source/lamquant',
    });
  });

  it('rejects tracked, untracked, or submodule dirt before creating scratch space', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        stdout: `${'a'.repeat(40)}\n`,
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        stdout: ' M docs/MASTER.md\n?? docs/untracked.md\n',
        stderr: '',
      });
    const makeScratchDirectory = vi.fn();

    await expect(
      runLamQuantCompatibilityOracle(
        {
          checkoutPath: '/source/lamquant',
          commitSha: 'a'.repeat(40),
          expectedManifest: [{ path: 'docs/MASTER.md', sha256: '0'.repeat(64) }],
        },
        {
          commandRunner: { run },
          fileSystem: {
            kind: async () => 'directory',
            makeScratchDirectory,
          } as never,
        },
      ),
    ).rejects.toMatchObject({ reason: 'dirty' });
    expect(run).toHaveBeenLastCalledWith({
      executable: 'git',
      args: ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'],
      cwd: '/source/lamquant',
    });
    expect(makeScratchDirectory).not.toHaveBeenCalled();
  });
});

describe('LamQuant compatibility oracle execution', () => {
  it('captures exact output and exit status from the real process runner', async () => {
    const result = await nodeLamQuantCommandRunner.run({
      executable: 'python3',
      args: [
        '-c',
        "import sys; sys.stdout.write('out\\n'); sys.stderr.write('err\\n'); raise SystemExit(7)",
      ],
      cwd: process.cwd(),
    });

    expect(result).toEqual({
      exitCode: 7,
      signal: null,
      stdout: 'out\n',
      stderr: 'err\n',
    });
  });

  it('returns bounded deterministic evidence when a real process times out', async () => {
    const runner = createNodeLamQuantCommandRunner({
      timeoutMs: 2_000,
      cleanupTimeoutMs: 200,
    });
    const startedAt = Date.now();

    const result = await runner.run({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('started\\n'); setInterval(() => {}, 1_000)"],
      cwd: process.cwd(),
    });

    expect(result).toMatchObject({
      stdout: 'started\n',
      stderr: '',
      runnerFailure: { kind: 'timeout', timeoutMs: 2_000 },
    });
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });

  it('hard-bounds cleanup when a real descendant retains inherited pipes', async () => {
    const runner = createNodeLamQuantCommandRunner({
      timeoutMs: 2_000,
      cleanupTimeoutMs: 200,
    });
    const descendant =
      "const { spawn } = require('node:child_process'); " +
      "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], " +
      "{ stdio: ['ignore', 'inherit', 'inherit'] }); " +
      "process.stdout.write('parent-exit\\n');";
    const startedAt = Date.now();

    const result = await runner.run({
      executable: process.execPath,
      args: ['-e', descendant],
      cwd: process.cwd(),
    });

    expect(result).toMatchObject({
      stdout: 'parent-exit\n',
      stderr: '',
      runnerFailure: { kind: 'timeout', timeoutMs: 2_000 },
    });
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });

  it.each([
    {
      name: 'stdout',
      script: "process.stdout.write('o'.repeat(2_048)); setInterval(() => {}, 1_000)",
      options: { maxStdoutBytes: 1_024, maxStderrBytes: 4_096, maxOutputBytes: 4_096 },
      failure: { kind: 'stdout_limit', limitBytes: 1_024 },
      stdoutBytes: 1_024,
      stderrBytes: 0,
    },
    {
      name: 'stderr',
      script: "process.stderr.write('e'.repeat(2_048)); setInterval(() => {}, 1_000)",
      options: { maxStdoutBytes: 4_096, maxStderrBytes: 1_024, maxOutputBytes: 4_096 },
      failure: { kind: 'stderr_limit', limitBytes: 1_024 },
      stdoutBytes: 0,
      stderrBytes: 1_024,
    },
    {
      name: 'aggregate',
      script:
        "process.stdout.write('o'.repeat(700), () => " +
        "process.stderr.write('e'.repeat(700))); setInterval(() => {}, 1_000)",
      options: { maxStdoutBytes: 1_024, maxStderrBytes: 1_024, maxOutputBytes: 1_000 },
      failure: { kind: 'aggregate_output_limit', limitBytes: 1_000 },
      stdoutBytes: undefined,
      stderrBytes: undefined,
    },
  ])('caps real $name output and returns exact failure kind', async (testCase) => {
    const runner = createNodeLamQuantCommandRunner({
      timeoutMs: 5_000,
      cleanupTimeoutMs: 200,
      ...testCase.options,
    });

    const result = await runner.run({
      executable: process.execPath,
      args: ['-e', testCase.script],
      cwd: process.cwd(),
    });

    expect(result.runnerFailure).toEqual(testCase.failure);
    if (testCase.stdoutBytes === undefined) {
      expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(1_000);
    } else {
      expect(Buffer.byteLength(result.stdout)).toBe(testCase.stdoutBytes);
      expect(Buffer.byteLength(result.stderr)).toBe(testCase.stderrBytes);
    }
  });

  it('builds in scratch, preserves exact tool evidence, compares the manifest, and cleans up', async () => {
    const source = await sourceFixture();
    let scratchPath: string | undefined;
    const removeTree = vi.fn(nodeLamQuantCompatibilityFileSystem.removeTree);
    const fileSystem = {
      ...nodeLamQuantCompatibilityFileSystem,
      makeScratchDirectory: async (): Promise<string> => {
        scratchPath = await nodeLamQuantCompatibilityFileSystem.makeScratchDirectory();
        return scratchPath;
      },
      removeTree,
    };
    const run = vi.fn(async (request: LamQuantCommandRequest) => {
      if (request.executable === 'git' && request.args[0] === 'rev-parse') {
        return {
          exitCode: 0,
          signal: null,
          stdout: `${'a'.repeat(40)}\n`,
          stderr: '',
        };
      }
      if (request.executable === 'git') {
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      }
      if (request.args[0] === 'tools/doc_compose.py') {
        await writeGeneratedCompatibilityOutputs(request.cwd);
      }
      const outputs: Readonly<Record<string, readonly [string, string]>> = {
        'tools/doc_tree_lint.py': ['lint out\n', 'lint err\n'],
        'tools/scripts/check_identifier_collisions.py': ['ids out\n', ''],
        'tools/adr_lint.py': ['adr lint out\n', ''],
        '-m': ['adr governance out\n', ''],
        'tools/doc_compose.py': ['compose out\n', ''],
        'tools/doc_views.py': ['views out\n', 'views warn\n'],
        'tools/doc_book.py': ['book out\n', ''],
      };
      const output = outputs[request.args[0] ?? ''];
      if (output === undefined) throw new Error(`unexpected command ${request.args.join(' ')}`);
      return {
        exitCode: 0,
        signal: null,
        stdout: output[0],
        stderr: output[1],
      };
    });

    const report = await runLamQuantCompatibilityOracle(
      {
        checkoutPath: source,
        commitSha: 'a'.repeat(40),
        expectedManifest: await docsManifest(source),
      },
      { commandRunner: { run }, fileSystem },
    );

    expect(report).toMatchObject({
      commitSha: 'a'.repeat(40),
      manifestDigest: '1c1fa1d05262686288b76b51fcb09535db8dfd41cc96c08847980208d612313d',
      passed: true,
      parity: { matched: true, missing: [], unexpected: [], mismatched: [] },
      gates: [
        {
          tool: 'doc_tree_lint',
          args: ['tools/doc_tree_lint.py'],
          exitCode: 0,
          signal: null,
          stdout: 'lint out\n',
          stderr: 'lint err\n',
        },
        {
          tool: 'identifier_collisions',
          args: ['tools/scripts/check_identifier_collisions.py'],
          exitCode: 0,
          signal: null,
          stdout: 'ids out\n',
          stderr: '',
        },
        {
          tool: 'adr_lint',
          args: ['tools/adr_lint.py', '--strict'],
          exitCode: 0,
          signal: null,
          stdout: 'adr lint out\n',
          stderr: '',
        },
        {
          tool: 'adr_governance',
          args: ['-m', 'pytest', '-q', 'tests/contracts/architecture/test_adr_governance.py'],
          exitCode: 0,
          signal: null,
          stdout: 'adr governance out\n',
          stderr: '',
        },
        {
          tool: 'doc_compose',
          args: ['tools/doc_compose.py', '--build'],
          exitCode: 0,
          signal: null,
          stdout: 'compose out\n',
          stderr: '',
        },
        {
          tool: 'doc_views',
          args: ['tools/doc_views.py', '--build'],
          exitCode: 0,
          signal: null,
          stdout: 'views out\n',
          stderr: 'views warn\n',
        },
        {
          tool: 'doc_book',
          args: ['tools/doc_book.py'],
          exitCode: 0,
          signal: null,
          stdout: 'book out\n',
          stderr: '',
        },
      ],
    });
    expect(report.compatibility).toMatchObject({ matched: true, mismatches: [] });
    expect(report.manifest.map((entry) => entry.path)).toContain('docs/PARENT.md');
    expect(scratchPath).toBeDefined();
    await expect(access(scratchPath!)).rejects.toThrow();
    expect(removeTree).toHaveBeenCalledWith(scratchPath);
  });

  it('fails closed when compose ownership is ambiguous', async () => {
    const source = await sourceFixture();
    await writeFile(
      join(source, 'docs', 'compose.toml'),
      [
        '[[parent]]',
        'file = "docs/PARENT.md"',
        'node = "parent"',
        'title = "Parent"',
        'parent = "MASTER.md"',
        'topics = ["codec"]',
        'atoms = ["docs/atoms/core/a.md"]',
        '[[parent]]',
        'file = "docs/OTHER.md"',
        'node = "other"',
        'title = "Other"',
        'parent = "MASTER.md"',
        'topics = ["codec"]',
        'atoms = ["docs/atoms/core/a.md"]',
        '',
      ].join('\n'),
    );
    const makeScratchDirectory = vi.fn();

    await expect(
      runLamQuantCompatibilityOracle(
        {
          checkoutPath: source,
          commitSha: 'a'.repeat(40),
          expectedManifest: await docsManifest(source),
        },
        {
          commandRunner: { run: gitOnlyRunner },
          fileSystem: { ...nodeLamQuantCompatibilityFileSystem, makeScratchDirectory },
        },
      ),
    ).rejects.toMatchObject({ reason: 'unsupported_source_contract' });
    expect(makeScratchDirectory).not.toHaveBeenCalled();
  });

  it('fails closed when an atom exists outside compose ownership', async () => {
    const source = await sourceFixture();
    await writeFile(
      join(source, 'docs', 'atoms', 'core', 'orphan.md'),
      ['---', 'kind: atom', 'title: Orphan', 'topics: [codec]', '---', '## Orphan', ''].join('\n'),
    );
    const makeScratchDirectory = vi.fn();

    await expect(
      runLamQuantCompatibilityOracle(
        {
          checkoutPath: source,
          commitSha: 'a'.repeat(40),
          expectedManifest: await docsManifest(source),
        },
        {
          commandRunner: { run: gitOnlyRunner },
          fileSystem: { ...nodeLamQuantCompatibilityFileSystem, makeScratchDirectory },
        },
      ),
    ).rejects.toMatchObject({ reason: 'unsupported_source_contract' });
    expect(makeScratchDirectory).not.toHaveBeenCalled();
  });

  it('fails closed when deprecated atom metadata is not reciprocal', async () => {
    const source = await sourceFixture();
    await writeFile(
      join(source, 'docs', 'atoms', 'core', 'deprecated', 'old.md'),
      [
        '---',
        'kind: atom',
        'title: Old',
        'status: deprecated',
        'deprecated_on: "2026-08-15"',
        'topics: [codec]',
        '---',
        '## Old',
        '',
      ].join('\n'),
    );
    const makeScratchDirectory = vi.fn();

    await expect(
      runLamQuantCompatibilityOracle(
        {
          checkoutPath: source,
          commitSha: 'a'.repeat(40),
          expectedManifest: await docsManifest(source),
        },
        {
          commandRunner: { run: gitOnlyRunner },
          fileSystem: { ...nodeLamQuantCompatibilityFileSystem, makeScratchDirectory },
        },
      ),
    ).rejects.toMatchObject({ reason: 'unsupported_source_contract' });
    expect(makeScratchDirectory).not.toHaveBeenCalled();
  });

  it.each([
    [
      'identifier_collisions',
      'tools/scripts/check_identifier_collisions.py',
      'ambiguous ledger id',
    ],
    ['adr_lint', 'tools/adr_lint.py', 'illegal ADR lifecycle'],
  ] as const)('runs mandatory %s audit gate in scratch', async (_tool, failingCommand, stderr) => {
    const source = await sourceFixture();
    const run = vi.fn(async (request: LamQuantCommandRequest) => {
      if (request.executable === 'git') return gitOnlyRunner(request);
      if (request.args[0] === 'tools/doc_compose.py')
        await writeGeneratedCompatibilityOutputs(request.cwd);
      if (request.args[0] === failingCommand) {
        return { exitCode: 1, signal: null, stdout: '', stderr };
      }
      return { exitCode: 0, signal: null, stdout: '', stderr: '' };
    });

    const report = await runLamQuantCompatibilityOracle(
      {
        checkoutPath: source,
        commitSha: 'a'.repeat(40),
        expectedManifest: await docsManifest(source),
      },
      { commandRunner: { run }, fileSystem: nodeLamQuantCompatibilityFileSystem },
    );

    expect(report.passed).toBe(false);
    expect(report.gates).toContainEqual(
      expect.objectContaining({
        args: expect.arrayContaining([failingCommand]),
        exitCode: 1,
        stderr,
      }),
    );
  });

  it.each([
    ['parent', 'parent_output'],
    ['topic', 'topics'],
    ['book', 'book_order'],
    ['missingAtom', 'atom_membership'],
    ['reorderedAtom', 'atom_membership'],
  ] as const)(
    'detects a planted %s mismatch even when the byte manifest matches',
    async (kind, dimension) => {
      const source = await sourceFixture();
      await writeGeneratedCompatibilityOutputs(source, kind);
      const run = vi.fn(async (request: LamQuantCommandRequest) => {
        if (request.executable === 'git') return gitOnlyRunner(request);
        if (request.args[0] === 'tools/doc_compose.py')
          await writeGeneratedCompatibilityOutputs(request.cwd, kind);
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      });

      const report = await runLamQuantCompatibilityOracle(
        {
          checkoutPath: source,
          commitSha: 'a'.repeat(40),
          expectedManifest: await docsManifest(source),
        },
        { commandRunner: { run }, fileSystem: nodeLamQuantCompatibilityFileSystem },
      );

      expect(report.parity.matched).toBe(true);
      expect(report.compatibility.matched).toBe(false);
      expect(report.passed).toBe(false);
      expect(report.compatibility.mismatches.map((item) => item.dimension)).toContain(dimension);
    },
  );
});

async function gitOnlyRunner(request: LamQuantCommandRequest) {
  if (request.executable !== 'git') throw new Error(`unexpected command ${request.executable}`);
  if (request.args[0] === 'rev-parse') {
    return { exitCode: 0, signal: null, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
  }
  return { exitCode: 0, signal: null, stdout: '', stderr: '' };
}
