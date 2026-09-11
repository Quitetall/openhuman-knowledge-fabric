import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every workspace package a process imports at runtime must be declared in that process's
 * package.json.
 *
 * On the workstation, pnpm hoists every workspace package into one node_modules, so an
 * undeclared import resolves and nothing notices. A release is built with `pnpm deploy`, which
 * ships exactly the declared dependency closure — and the first release carrying
 * `kf retire-organization` failed on the host with
 * `Cannot find package '@kf/record-atoms'` (2026-09-11). The import had been there since the
 * bootstrap command, and had only ever run from an ad hoc tree that happened to have the
 * package. The worker had the same gap for `@kf/canonicalization`.
 *
 * Type-only imports are erased and need no runtime package; tests are not shipped.
 */

const ROOT = join(import.meta.dirname, '..', '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'dist') out.push(...sources(path));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

const VALUE_IMPORT = /^import\s+(type\s+)?[^;]*?from\s+'(@kf\/[a-z-]+)'/gms;

function workspacePackages(): string[] {
  const out: string[] = [];
  for (const group of ['apps', 'packages']) {
    for (const entry of readdirSync(join(ROOT, group))) {
      const dir = join(ROOT, group, entry);
      try {
        statSync(join(dir, 'package.json'));
        statSync(join(dir, 'src'));
        out.push(dir);
      } catch {
        // not a package with sources
      }
    }
  }
  return out;
}

describe('workspace dependencies are declared where they are imported', () => {
  const packages = workspacePackages();

  it('scans something, so a passing run is not an empty one', () => {
    expect(packages.length).toBeGreaterThan(10);
  });

  it('finds no runtime @kf/* import that the importing package does not declare', () => {
    const undeclared: string[] = [];
    for (const dir of packages) {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const declared = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
      ]);
      for (const file of sources(join(dir, 'src'))) {
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(VALUE_IMPORT)) {
          const [, typeOnly, name] = match;
          if (typeOnly !== undefined || name === manifest.name) continue;
          if (!declared.has(name!)) {
            undeclared.push(`${manifest.name}: ${file.slice(ROOT.length + 1)} imports ${name}`);
          }
        }
      }
    }
    expect(
      undeclared,
      'a release ships only the declared dependency closure; each of these resolves on the ' +
        'workstation by hoisting and fails on the host with ERR_MODULE_NOT_FOUND',
    ).toEqual([]);
  });

  it('would catch a planted undeclared import', () => {
    const text = "import { x } from '@kf/planted';\nimport type { T } from '@kf/typed';\n";
    const names = [...text.matchAll(VALUE_IMPORT)]
      .filter(([, typeOnly]) => typeOnly === undefined)
      .map(([, , name]) => name);
    expect(names).toEqual(['@kf/planted']);
  });
});
