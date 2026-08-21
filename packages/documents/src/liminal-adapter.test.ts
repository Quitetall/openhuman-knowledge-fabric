import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize, digestBytes } from '@kf/canonicalization';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompilationRequest, CompilerResponse, LiminalCompilerIdentity } from './compiler.js';
import {
  DEFAULT_PREFLIGHT_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  digestLiminalRuntimeClosure,
  PinnedLiminalProcessAdapter,
} from './liminal-adapter.js';

const roots: string[] = [];
const TEST_BWRAP = process.env['KF_TEST_BWRAP_PATH'] ?? '/usr/bin/bwrap';

function nativeRuntimeClosure(executablePath: string): readonly string[] {
  const output = execFileSync('/usr/bin/ldd', [executablePath], { encoding: 'utf8' });
  const files = [...output.matchAll(/(?:=>\s+)?(\/[^\s(]+)/g)].map((match) => match[1]!);
  return [...new Set([executablePath, ...files])];
}

const TEST_RUNTIME_FILES =
  process.platform === 'linux' ? nativeRuntimeClosure(process.execPath) : [process.execPath];
const PRODUCTION_RUNTIME_FILES =
  process.platform === 'linux'
    ? nativeRuntimeClosure('/usr/bin/true').filter((path) => path !== '/usr/bin/true')
    : [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), 'kf-liminal-adapter-'));
  roots.push(root);
  const executablePath = join(root, 'liminal-compiler');
  const cargoLockPath = join(root, 'Cargo.lock');
  await writeFile(
    executablePath,
    `#!${process.execPath}
if (process.argv.includes('--preflight')) {
  if (process.argv.slice(2).join(' ') !== '--protocol kf-document-v1 --preflight') process.exit(91);
  process.stdout.write('{"protocol":"kf-document-v1","status":"ready"}\\n');
  process.exit(0);
}
${source}
`,
  );
  await chmod(executablePath, 0o700);
  await writeFile(cargoLockPath, 'lock-v1\n');
  const executable = await import('node:fs/promises').then((fs) => fs.readFile(executablePath));
  const lock = await import('node:fs/promises').then((fs) => fs.readFile(cargoLockPath));
  const identity: LiminalCompilerIdentity = {
    kind: 'liminal',
    name: 'liminal',
    version: '0.1.0',
    protocol: 'kf-document-v1',
    commitSha: '1'.repeat(40),
    cargoLockDigest: digestBytes(lock),
    executableDigest: digestBytes(executable),
    runtimeClosureDigest: await digestLiminalRuntimeClosure(TEST_RUNTIME_FILES),
    qualification: { state: 'unratified', receiptDigest: null, ratified: false },
  };
  return {
    executablePath,
    cargoLockPath,
    identity,
    bubblewrapPath: TEST_BWRAP,
    runtimeFilePaths: TEST_RUNTIME_FILES,
    root,
  };
}

const request = {
  protocol: 'kf-document-v1',
  basisDigest: 'a'.repeat(64),
  dependencyDigest: 'b'.repeat(64),
  basis: { marker: 'basis' },
  inputs: [],
} as unknown as CompilationRequest;

const response: CompilerResponse = {
  protocol: 'kf-document-v1',
  basisDigest: request.basisDigest,
  dependencyDigest: request.dependencyDigest,
  semanticGraph: {},
  semanticDigest: 'c'.repeat(64),
  hirProvenance: [],
  cirProvenance: [],
  unresolvedReferences: [],
  omittedSubgraphs: [],
  projectionCapabilities: [],
  diagnostics: [],
  conversionLoss: [],
  views: [],
};

describe('PinnedLiminalProcessAdapter configuration', () => {
  it('requires an exact non-empty native runtime file allowlist', async () => {
    const files = await fixture(`process.stdout.write(${JSON.stringify(canonicalize(response))})`);
    expect(() => new PinnedLiminalProcessAdapter({ ...files, runtimeFilePaths: [] })).toThrow(
      /exact non-empty native runtime closure/,
    );
    expect(
      () =>
        new PinnedLiminalProcessAdapter({
          ...files,
          runtimeFilePaths: ['/usr/src/ambient-source'],
        }),
    ).toThrow(/only native system libraries/);
  });

  it('requires normalized absolute sandbox and runtime paths', async () => {
    const files = await fixture(`process.stdout.write(${JSON.stringify(canonicalize(response))})`);
    expect(
      () =>
        new PinnedLiminalProcessAdapter({
          ...files,
          runtimeFilePaths: ['/lib/../usr/src/ambient-source'],
        }),
    ).toThrow(/normalized absolute path/);
  });

  it('bounds individual runtime files before allocating their contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kf-liminal-runtime-limit-'));
    roots.push(root);
    const oversized = join(root, 'oversized-runtime');
    await writeFile(oversized, '');
    await truncate(oversized, 128 * 1024 * 1024 + 1);

    await expect(digestLiminalRuntimeClosure([oversized])).rejects.toThrow(
      /runtime file exceeded 134217728 bytes/,
    );
  });
});

describe.skipIf(process.platform !== 'linux' || !existsSync(TEST_BWRAP))(
  'PinnedLiminalProcessAdapter sandbox integration',
  () => {
    // Every test below spawns a real bubblewrap sandbox around a real Node process. On an idle
    // machine each takes milliseconds; in the full suite it competes with fifteen other
    // workers and six PostgreSQL containers, and process startup alone can take seconds.
    //
    // The default 30s budget is sized for tests that do arithmetic. Raising it here does not
    // weaken anything: none of these tests asserts that the sandbox is FAST. They assert that
    // it refuses, bounds, isolates and cleans up — properties that either hold or hang, and a
    // hang still fails, just later.
    vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
    it('does not permit script-fixture override outside test runtime', async () => {
      const files = await fixture(
        `process.stdout.write(${JSON.stringify(canonicalize(response))})`,
      );
      const previous = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'production';
      try {
        expect(
          () =>
            new PinnedLiminalProcessAdapter({
              ...files,
              allowScriptExecutableForTests: true,
            }),
        ).toThrow(/only available when NODE_ENV=test/);
      } finally {
        if (previous === undefined) delete process.env['NODE_ENV'];
        else process.env['NODE_ENV'] = previous;
      }
    });

    it('requires an explicit sandbox and passes a real preflight', async () => {
      const files = await fixture(
        `process.stdout.write(${JSON.stringify(canonicalize(response))})`,
      );
      const previous = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'production';
      try {
        expect(
          () =>
            new PinnedLiminalProcessAdapter({
              ...files,
              bubblewrapPath: undefined as unknown as string,
              runtimeFilePaths: PRODUCTION_RUNTIME_FILES,
            }),
        ).toThrow(/bubblewrapPath must be absolute/);
      } finally {
        if (previous === undefined) delete process.env['NODE_ENV'];
        else process.env['NODE_ENV'] = previous;
      }

      const adapter = new PinnedLiminalProcessAdapter({
        ...files,
        allowScriptExecutableForTests: true,
      });
      await expect(adapter.preflight()).resolves.toBeUndefined();
    });

    it('executes the pinned compiler self-check and rejects changed compiler or lock bytes', async () => {
      const files = await fixture(`process.exit(0)`);
      const adapter = new PinnedLiminalProcessAdapter({
        ...files,
        allowScriptExecutableForTests: true,
      });
      await expect(adapter.preflight()).resolves.toBeUndefined();

      await writeFile(files.executablePath, '#!/bin/false\n');
      const changedCompiler = new PinnedLiminalProcessAdapter({
        ...files,
        allowScriptExecutableForTests: true,
      });
      await expect(changedCompiler.preflight()).rejects.toThrow(/executable digest mismatch/);

      const changedLockFiles = await fixture(`process.exit(0)`);
      await writeFile(changedLockFiles.cargoLockPath, 'changed-lock\n');
      const changedLock = new PinnedLiminalProcessAdapter({
        ...changedLockFiles,
        allowScriptExecutableForTests: true,
      });
      await expect(changedLock.preflight()).rejects.toThrow(/Cargo.lock digest mismatch/);
    });

    it('bounds the host probe by the configured deadline and names it when it fires', async () => {
      const files = await fixture(`process.exit(0)`);
      const adapter = new PinnedLiminalProcessAdapter({
        ...files,
        allowScriptExecutableForTests: true,
        // 1ms cannot survive a bubblewrap spawn, so the deadline is what fires — and it is
        // the CONFIGURED deadline, which is the property under test. The old code had this
        // bound welded at 5s with no way for a deployment to say otherwise.
        preflightTimeoutMs: 1,
      });
      await expect(adapter.preflight()).rejects.toThrow(/preflight timed out after 1 ms/);

      // The default is not the old 5s: it is high enough that a busy host does not fail a
      // compile, and still below the compilation timeout so a stuck probe fails sooner than a
      // stuck compile.
      expect(DEFAULT_PREFLIGHT_TIMEOUT_MS).toBeGreaterThan(5_000);
      expect(DEFAULT_PREFLIGHT_TIMEOUT_MS).toBeLessThan(DEFAULT_TIMEOUT_MS);
    });

    it('does not cache a failed preflight, so a transient host failure is not permanent', async () => {
      const files = await fixture(`process.exit(0)`);
      const original = await readFile(files.executablePath);
      const adapter = new PinnedLiminalProcessAdapter({
        ...files,
        allowScriptExecutableForTests: true,
      });

      // Whatever made the probe fail — here a swapped executable; in production, a bubblewrap
      // spawn that missed its 5s deadline on a loaded host, which has been measured to happen.
      await writeFile(files.executablePath, '#!/bin/false\n');
      await expect(adapter.preflight()).rejects.toThrow(/executable digest mismatch/);

      // The SAME adapter instance, once the host is healthy again. Caching the rejected
      // promise made this second call — and every later compile — reject with the stale error
      // for the life of the process.
      await writeFile(files.executablePath, original);
      await chmod(files.executablePath, 0o700);
      await expect(adapter.preflight()).resolves.toBeUndefined();
    });

    it('rejects a generic no-op ELF as compiler preflight evidence', async () => {
      const files = await fixture(`process.exit(0)`);
      const trueBytes = await import('node:fs/promises').then((fs) => fs.readFile('/usr/bin/true'));
      const adapter = new PinnedLiminalProcessAdapter({
        ...files,
        executablePath: '/usr/bin/true',
        identity: {
          ...files.identity,
          executableDigest: digestBytes(trueBytes),
          runtimeClosureDigest: await digestLiminalRuntimeClosure(PRODUCTION_RUNTIME_FILES),
        },
        runtimeFilePaths: PRODUCTION_RUNTIME_FILES,
      });

      await expect(adapter.preflight()).rejects.toThrow(/response did not match exact contract/);
    });

    it('uses canonical JSON stdin/stdout and required protocol argument', async () => {
      const files = await fixture(`
      let body = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => body += chunk);
      process.stdin.on('end', () => {
        const input = JSON.parse(body);
        if (process.argv[2] !== '--protocol' || process.argv[3] !== 'kf-document-v1') process.exit(9);
        if (body !== JSON.stringify(input) + '\\n') process.exit(8);
        process.stdout.write(${JSON.stringify(canonicalize(response))});
      });
    `);
      const adapter = new PinnedLiminalProcessAdapter({
        ...files,
        // The compile deadline, not an assertion. This test is about the protocol — canonical
        // JSON on stdin, the required --protocol argument, canonical JSON back — and a budget
        // tight enough to expire while the machine is busy turns a protocol test into a
        // timing test that fails for reasons it does not describe.
        timeoutMs: 60_000,
        allowScriptExecutableForTests: true,
      });

      await expect(adapter.compile(request)).resolves.toEqual(response);
      expect(adapter.identity).toEqual(files.identity);
    });

    it('hides worker secrets, source paths, ambient environment and external interfaces', async () => {
      // A CANARY THE TEST CREATES, rather than a list of paths guessed to exist on the host.
      //
      // This previously probed `/etc/kf`, `/opt/kf` and `/mnt/4tb`. None of the three is
      // guaranteed to exist anywhere, so on a machine without them those disjuncts could never
      // fire and the assertion rested entirely on `/usr/share`. `/mnt/4tb` was worse than
      // useless: it is one contributor's disk mount, so it also put a personal path into a
      // repository about to be published.
      //
      // A directory created here exists by construction, on every machine, so if the sandbox
      // ever stops hiding the host filesystem this fails instead of passing quietly.
      //
      // VERIFIED AGAINST THE REAL FAILURE MODE, not a proxy. The sandbox root is `--tmpfs /`
      // with only explicit fd-binds, so nothing on the host is reachable by path and every
      // probe here is false by construction — which raises the fair objection that the test
      // could be passing for the wrong reason. It is not: adding `--bind /tmp /tmp` to
      // buildSandboxArguments, so the sandbox really does expose the host tmpdir, turns this
      // test red. Removing the bind turns it green again.
      //
      // `/usr/src` and `/usr/share` stay, and are NOT redundant with the canary. They catch a
      // different regression: a bind of a host directory the canary does not live under. The
      // canary catches an exposed tmpdir; those catch an exposed system tree.
      const hostCanary = await mkdtemp(join(tmpdir(), 'kf-host-canary-'));
      roots.push(hostCanary);
      // "The sandbox cannot see it" is vacuous if it does not exist to be seen. Assert the
      // premise here so the test cannot pass by the canary having quietly failed to be created.
      expect(existsSync(hostCanary), 'the host canary was not created').toBe(true);

      const files = await fixture(`
      const fs = require('node:fs');
      const os = require('node:os');
      const interfaces = Object.values(os.networkInterfaces()).flat().filter(Boolean);
      if (fs.existsSync(${JSON.stringify(hostCanary)}) ||
          fs.existsSync('/usr/src') || fs.existsSync('/usr/share')) {
        process.exit(41);
      }
      if (process.env.WORKER_DATABASE_URL || interfaces.some(entry => !entry.internal)) {
        process.exit(42);
      }
      process.stdout.write(${JSON.stringify(canonicalize(response))});
    `);
      const previous = process.env['WORKER_DATABASE_URL'];
      process.env['WORKER_DATABASE_URL'] = 'postgres://must-not-cross-boundary';
      try {
        await expect(
          new PinnedLiminalProcessAdapter({
            ...files,
            allowScriptExecutableForTests: true,
          }).compile(request),
        ).resolves.toEqual(response);
      } finally {
        if (previous === undefined) delete process.env['WORKER_DATABASE_URL'];
        else process.env['WORKER_DATABASE_URL'] = previous;
      }
    });

    it('refuses executable drift before invoking it', async () => {
      const files = await fixture(`process.stdout.write('{}')`);
      await writeFile(files.executablePath, '#!/usr/bin/env node\nprocess.exit(77)\n');
      const adapter = new PinnedLiminalProcessAdapter({
        ...files,
        allowScriptExecutableForTests: true,
      });

      await expect(adapter.compile(request)).rejects.toThrow(/executable digest mismatch/);
    });

    it('refuses native runtime closure drift before invoking compiler bytes', async () => {
      const files = await fixture(
        `process.stdout.write(${JSON.stringify(canonicalize(response))})`,
      );
      const adapter = new PinnedLiminalProcessAdapter({
        ...files,
        identity: { ...files.identity, runtimeClosureDigest: '0'.repeat(64) },
        allowScriptExecutableForTests: true,
      });

      await expect(adapter.compile(request)).rejects.toThrow(/runtime closure digest mismatch/);
    });

    it('executes the verified open file even when its path is replaced before spawn', async () => {
      const files = await fixture(
        `process.stdout.write(${JSON.stringify(canonicalize(response))})`,
      );
      let barrierRan = false;
      const adapter = new PinnedLiminalProcessAdapter({
        ...files,
        allowScriptExecutableForTests: true,
        // Test-only synchronization seam: replacement happens after digest verification.
        afterPinVerification: async () => {
          barrierRan = true;
          const verifiedPath = `${files.executablePath}.verified`;
          await import('node:fs/promises').then((fs) =>
            fs.rename(files.executablePath, verifiedPath),
          );
          await writeFile(files.executablePath, '#!/usr/bin/env node\nprocess.exit(77)\n');
          await chmod(files.executablePath, 0o700);
        },
      });

      await expect(adapter.compile(request)).resolves.toEqual(response);
      expect(barrierRan).toBe(true);
    });

    it('executes captured verified bytes when the original inode is overwritten after hashing', async () => {
      const files = await fixture(
        `process.stdout.write(${JSON.stringify(canonicalize(response))})`,
      );
      const adapter = new PinnedLiminalProcessAdapter({
        ...files,
        allowScriptExecutableForTests: true,
        afterPinVerification: async () => {
          await writeFile(files.executablePath, '#!/usr/bin/env node\nprocess.exit(78)\n');
          await chmod(files.executablePath, 0o700);
        },
      });

      await expect(adapter.compile(request)).resolves.toEqual(response);
    });

    it('kills a timed-out compiler', async () => {
      const files = await fixture(`setInterval(() => {}, 1000)`);
      const adapter = new PinnedLiminalProcessAdapter({
        ...files,
        timeoutMs: 30,
        allowScriptExecutableForTests: true,
      });

      await expect(adapter.compile(request)).rejects.toThrow(/timed out/);
    });

    it('hard-bounds cleanup when a detached descendant retains compiler pipes', async () => {
      const files = await fixture(`
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      setInterval(() => {}, 1000);
    `);
      const adapter = new PinnedLiminalProcessAdapter({
        ...files,
        timeoutMs: 40,
        cleanupTimeoutMs: 200,
        allowScriptExecutableForTests: true,
        afterPinVerification: () => {
          startedAt = Date.now();
        },
      });
      let startedAt = 0;

      await expect(adapter.compile(request)).rejects.toThrow(/timed out/);
      expect(startedAt).toBeGreaterThan(0);
      // The property is BOUNDED, not fast. A detached descendant holding the compiler's pipes
      // is the case where a naive implementation waits forever, so what has to be proven is
      // that this returns at all — and the configured budget above (40ms compile, 200ms
      // cleanup) is what governs how quickly.
      //
      // The ceiling is generous on purpose. It was 1s, which under full-suite load lost to
      // process startup and failed a correct implementation; anything that actually hangs
      // blows the test timeout instead, so a wide ceiling costs no detection.
      expect(Date.now() - startedAt).toBeLessThan(15_000);
    });

    it('refuses oversized or malformed output', async () => {
      const oversized = await fixture(`process.stdout.write('x'.repeat(4096))`);
      await expect(
        new PinnedLiminalProcessAdapter({
          ...oversized,
          maxOutputBytes: 100,
          allowScriptExecutableForTests: true,
        }).compile(request),
      ).rejects.toThrow(/output exceeded/);

      const malformed = await fixture(`process.stdout.write('not-json')`);
      await expect(
        new PinnedLiminalProcessAdapter({
          ...malformed,
          allowScriptExecutableForTests: true,
        }).compile(request),
      ).rejects.toThrow(/invalid JSON/);

      const invalidUtf8 = await fixture(
        `process.stdout.write(Buffer.from([0x7b, 0xc3, 0x28, 0x7d]))`,
      );
      await expect(
        new PinnedLiminalProcessAdapter({
          ...invalidUtf8,
          allowScriptExecutableForTests: true,
        }).compile(request),
      ).rejects.toThrow(/invalid UTF-8/);

      const bom = await fixture(
        `process.stdout.write(Buffer.concat([Buffer.from([0xef,0xbb,0xbf]), Buffer.from('{}')]))`,
      );
      await expect(
        new PinnedLiminalProcessAdapter({ ...bom, allowScriptExecutableForTests: true }).compile(
          request,
        ),
      ).rejects.toThrow(/forbidden UTF-8 BOM/);
    });

    it('refuses an unpinned shebang interpreter in production mode', async () => {
      const files = await fixture(
        `process.stdout.write(${JSON.stringify(canonicalize(response))})`,
      );

      await expect(
        new PinnedLiminalProcessAdapter({
          ...files,
          identity: {
            ...files.identity,
            runtimeClosureDigest: await digestLiminalRuntimeClosure(PRODUCTION_RUNTIME_FILES),
          },
          runtimeFilePaths: PRODUCTION_RUNTIME_FILES,
        }).compile(request),
      ).rejects.toThrow(/native Linux ELF/);
    });
  },
);

it.runIf(process.platform !== 'linux')(
  'refuses process execution when Linux procfs descriptor semantics are unavailable',
  async () => {
    const files = await fixture(`process.stdout.write(${JSON.stringify(canonicalize(response))})`);
    const adapter = new PinnedLiminalProcessAdapter({
      ...files,
      allowScriptExecutableForTests: true,
    });

    await expect(adapter.compile(request)).rejects.toThrow(/requires Linux \/proc/);
  },
);
