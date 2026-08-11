/**
 * Preservation export CLI.
 *
 * The export is the institutional record, so it has to be something an operator can run, hand
 * to an auditor, and verify years later without this repository. Three verbs:
 *
 *   kf-export write <dir>    write a canonical export
 *   kf-export verify <dir>   check a directory against its own manifest
 *   kf-export load <dir>     import into an empty, migrated database
 *
 * `verify` deliberately needs no database and no configuration: whoever holds the directory
 * can check it, which is most of the point of choosing plain text over a binary dump.
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createPool, withTransaction } from '@kf/database';
import {
  createExport,
  importExport,
  verifyExport,
  type ExportManifest,
  type ExportPackage,
} from './index.js';

function requireDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') throw new Error('DATABASE_URL is not set');
  return url;
}

function writePackage(dir: string, pkg: ExportPackage): void {
  for (const f of pkg.files) {
    const path = join(dir, f.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, f.content, 'utf8');
  }
}

/** Read a directory back as a package. Paths are normalised to forward slashes. */
function readPackage(dir: string): ExportPackage {
  const root = resolve(dir);
  const files: { path: string; content: string }[] = [];

  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else {
        files.push({
          path: relative(root, full).split(sep).join('/'),
          content: readFileSync(full, 'utf8'),
        });
      }
    }
  };
  walk(root);

  const manifestFile = files.find((f) => f.path === 'manifest.json');
  if (manifestFile === undefined) throw new Error(`${dir} has no manifest.json`);
  return { files, manifest: JSON.parse(manifestFile.content) as ExportManifest };
}

async function main(argv: readonly string[]): Promise<number> {
  const [verb, dir] = argv;
  if (verb === undefined || dir === undefined) {
    console.error('usage: kf-export <write|verify|load> <directory>');
    return 2;
  }

  if (verb === 'verify') {
    const findings = verifyExport(readPackage(dir));
    if (findings.length > 0) {
      for (const f of findings) console.error(`${f.problem}: ${f.path} — ${f.detail}`);
      return 1;
    }
    console.warn(`ok: ${dir} matches its manifest`);
    return 0;
  }

  const pool = createPool({ connectionString: requireDatabaseUrl(), maxConnections: 2 });
  try {
    if (verb === 'write') {
      const pkg = await withTransaction(pool, async (tx) => createExport(tx));
      mkdirSync(dir, { recursive: true });
      writePackage(dir, pkg);
      // Re-read from disk and verify, rather than trusting what was just in memory. An
      // export that was corrupted on the way to the filesystem is exactly the failure this
      // whole format exists to survive.
      const findings = verifyExport(readPackage(dir));
      if (findings.length > 0) {
        for (const f of findings) console.error(`${f.problem}: ${f.path} — ${f.detail}`);
        return 1;
      }
      console.warn(
        JSON.stringify({
          wrote: dir,
          files: pkg.files.length,
          counts: pkg.manifest.counts,
          audit_range: [pkg.manifest.audit_from_seq, pkg.manifest.audit_to_seq],
        }),
      );
      return 0;
    }

    if (verb === 'load') {
      const result = await withTransaction(pool, async (tx) => importExport(tx, readPackage(dir)));
      console.warn(JSON.stringify({ loaded: dir, rows: result.imported }));
      return 0;
    }

    console.error(`unknown verb: ${verb}`);
    return 2;
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`kf-export: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
