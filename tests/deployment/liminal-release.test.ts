import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestLiminalRuntimeClosure } from '@kf/documents';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const ASSEMBLE = join(ROOT, 'scripts', 'deploy', 'assemble-liminal-runtime.sh');
const VERIFY = join(ROOT, 'scripts', 'deploy', 'verify-liminal-runtime.sh');
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function nativeRuntimeClosure(executablePath: string): readonly string[] {
  const output = execFileSync('/usr/bin/ldd', [executablePath], { encoding: 'utf8' });
  return [
    ...new Set(
      [...output.matchAll(/(?:=>\s+)?(\/[^\s(]+)/g)]
        .map((match) => match[1]!)
        .filter((path) => path.startsWith('/lib/') || path.startsWith('/lib64/')),
    ),
  ];
}

function parseEnvironment(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function assembleFixture(additionalEnvironment: Record<string, string> = {}): {
  readonly release: string;
  readonly runtimeFiles: readonly string[];
  readonly environment: Record<string, string>;
} {
  const root = temporaryDirectory('kf-liminal-release-');
  const release = join(root, 'release');
  const compiler = join(root, 'liminal-document-compiler');
  const cargoLock = join(root, 'Cargo.lock');
  mkdirSync(release);
  writeFileSync(compiler, readFileSync(process.execPath), { mode: 0o755 });
  chmodSync(compiler, 0o755);
  writeFileSync(cargoLock, 'version = 4\n');
  const runtimeFiles = nativeRuntimeClosure(process.execPath);
  expect(runtimeFiles.length).toBeGreaterThan(0);

  const result = spawnSync('bash', [ASSEMBLE, release, compiler, cargoLock, ...runtimeFiles], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...additionalEnvironment },
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  const environment = parseEnvironment(join(release, 'vendor', 'liminal', 'RUNTIME.env'));
  environment['LIMINAL_COMPILER_PATH'] = join(
    release,
    'vendor',
    'liminal',
    'liminal-document-compiler',
  );
  environment['LIMINAL_CARGO_LOCK_PATH'] = join(release, 'vendor', 'liminal', 'Cargo.lock');
  return { release, runtimeFiles, environment };
}

function verify(
  fixture: ReturnType<typeof assembleFixture>,
  environment: Record<string, string> = fixture.environment,
): { readonly code: number; readonly output: string } {
  const result = spawnSync('bash', [VERIFY, fixture.release], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
  return {
    code: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

/**
 * 90s, not the 30s global, because these tests build and hash a release tree.
 *
 * Every test here shells out — `cargo`-adjacent packaging, `execFileSync` over the compiler, and
 * a SHA-256 of the whole runtime closure. That is disk and CPU bound, so its wall time is set by
 * what else the machine is doing, not by the code under test.
 *
 * Measured on 2026-08-21: the slowest case ran in 17.8s alone and BLEW the 30s budget inside the
 * full suite on a box at load average 36. A 1.7x margin is not a margin for a test whose cost is
 * contention; it is a coin flip that reads as a real failure and sends the next person hunting a
 * bug in the release packaging that is not there. It already cost that once, in this repository,
 * on document-dogfood.
 *
 * Raising a timeout is usually the wrong reflex — it hides a slow path. It is right here because
 * the failure mode is a false RED, not a missed regression: nothing about these assertions gets
 * weaker with more time, and a genuine hang still fails, just 60s later.
 */
describe('Liminal release runtime closure', { timeout: 90_000 }, () => {
  it('packages exact compiler and Cargo.lock bytes with an explicit external closure manifest', async () => {
    const fixture = assembleFixture();

    expect(
      existsSync(join(fixture.release, 'vendor', 'liminal', 'liminal-document-compiler')),
    ).toBe(true);
    expect(existsSync(join(fixture.release, 'vendor', 'liminal', 'Cargo.lock'))).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(fixture.release, 'vendor', 'liminal', 'RUNTIME-CLOSURE.json'), 'utf8'),
    ) as { format: string; entries: { path: string; contentDigest: string }[] };
    expect(manifest.format).toBe('kf-liminal-runtime-closure-v1');
    expect(manifest.entries.map(({ path }) => path)).toEqual(fixture.runtimeFiles);
    expect(
      manifest.entries.every(({ contentDigest }) => /^[0-9a-f]{64}$/.test(contentDigest)),
    ).toBe(true);
    expect(fixture.environment['LIMINAL_RUNTIME_CLOSURE_SHA256']).toBe(
      await digestLiminalRuntimeClosure(fixture.runtimeFiles),
    );

    const result = verify(fixture);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('Liminal runtime verified');
  });

  it('fails closed for configured compiler, lock, or runtime-closure digest mismatch', () => {
    for (const name of [
      'LIMINAL_EXECUTABLE_SHA256',
      'LIMINAL_CARGO_LOCK_SHA256',
      'LIMINAL_RUNTIME_CLOSURE_SHA256',
    ]) {
      const fixture = assembleFixture();
      const result = verify(fixture, { ...fixture.environment, [name]: '0'.repeat(64) });
      expect(result.code, `${name}: ${result.output}`).not.toBe(0);
      expect(result.output).toMatch(/digest|checksum/i);
    }
  });

  it('fails closed when configured runtime paths differ from the sealed closure', () => {
    const fixture = assembleFixture();
    const mutableRuntime = join(temporaryDirectory('kf-runtime-file-'), 'libfixture.so');
    writeFileSync(mutableRuntime, 'before');
    const result = verify(fixture, {
      ...fixture.environment,
      LIMINAL_RUNTIME_FILE_PATHS: mutableRuntime,
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/manifest|runtime closure/i);
  });

  it('sanitizes Node preload settings before generating release digests', () => {
    const preload = join(temporaryDirectory('kf-node-preload-'), 'noise.cjs');
    writeFileSync(preload, `process.stdout.write('untrusted-preload-output')\n`);
    const fixture = assembleFixture({ NODE_OPTIONS: `--require=${preload}` });

    expect(fixture.environment['LIMINAL_RUNTIME_CLOSURE_SHA256']).toMatch(/^[0-9a-f]{64}$/);
    expect(
      readFileSync(join(fixture.release, 'vendor', 'liminal', 'RUNTIME.env'), 'utf8'),
    ).not.toContain('untrusted-preload-output');
  });

  it('wires startup to real artifact digests and contains no placeholder compiler identity', () => {
    const worker = readFileSync(join(ROOT, 'deploy', 'systemd', 'kf-worker.service'), 'utf8');
    const environment = readFileSync(join(ROOT, 'deploy', 'systemd', 'worker.env.example'), 'utf8');
    const adapter = readFileSync(
      join(ROOT, 'packages', 'documents', 'src', 'liminal-adapter.ts'),
      'utf8',
    );
    expect(worker).toContain(
      'ExecStartPre=/opt/kf/scripts/deploy/verify-liminal-runtime.sh /opt/kf',
    );
    expect(worker).toContain('UnsetEnvironment=NODE_OPTIONS NODE_PATH');
    expect(environment).toContain('LIMINAL_EXECUTABLE_SHA256=');
    expect(environment).toContain('LIMINAL_CARGO_LOCK_SHA256=');
    expect(environment).toContain('LIMINAL_RUNTIME_CLOSURE_SHA256=');
    expect(adapter).not.toContain("executablePath: '/usr/bin/true'");
    expect(adapter).not.toContain("cargoLockPath: '/dev/null'");
  });
});
