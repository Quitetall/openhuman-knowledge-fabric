/**
 * An approved package must still describe the source it claims to represent.
 *
 * `pnpm ontology:verify` checks a package against its OWN approval — every file digest against
 * the manifest, the manifest against the signature. That is necessary and it is not this. A pack
 * can verify perfectly while the source has moved on underneath it, and then "APPROVED" is a
 * true statement about a snapshot nobody is running.
 *
 * That is not hypothetical. `registries/openhuman/rules.yaml` had its `enforced_by` paths
 * repointed when ADR 0006 moved the registry, after the pack was signed, and nothing noticed for
 * days. It was found by hand.
 *
 * REBUILT IN MEMORY, NEVER ON DISK. `buildRegistryPack` and `buildReleasePack` are pure functions
 * returning `PackFile[]`, so this compares digests without writing anything. It matters more than
 * tidiness: running `pnpm ontology:registry-pack` to compare is what invalidated the registry
 * pack's approval on 2026-08-24 — the command overwrote the signed manifest, and `release/` is
 * mostly gitignored, so there was no copy to restore. A test that did that on every run would
 * destroy the artifact it exists to protect.
 *
 * Drift FAILS unless the package is listed in KNOWN_DRIFT with a reason. Not because drift is
 * forbidden — source moving ahead of an approved pack is ordinary development — but because it
 * has to be a decision somebody wrote down rather than a thing that quietly became true.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildRegistryPack,
  buildReleasePack,
  loadOntology,
  loadRegistryPolicy,
  type PackFile,
} from '@kf/ontology-compiler';

/**
 * Packages whose source has legitimately moved ahead of the signed pack.
 *
 * An entry is an admission, not an exemption: it says a re-cut and re-approval is owed. Signing
 * is human-only per CONTRIBUTING.md, so this cannot be discharged by any automation here.
 */
const KNOWN_DRIFT = new Map<string, string>([
  [
    'knowledge-fabric-1.0.0-draft.2',
    'OW-WAR-0054 adds relation propagation metadata and the compile_master_record action; ' +
      'ADR 0013 adds grant_person_clearance and the corpus projection definitions ' +
      '(ontology/projections.yaml); ADR 0016 adds grant_access and revoke_access; ADR 0017 adds ' +
      'replicate_artifact_version and verify_artifact_location; ADR 0018 adds ' +
      'allocate_enterprise_identifier; ADR 0019 adds the warrant type and SAS §67 actions. ' +
      'The existing approval remains a historical snapshot; ' +
      're-cut and fresh human approval are required before release.',
  ],
  [
    'openhuman-registry-1.0.0-draft.1',
    'ADR 0006 moved the registry to registries/openhuman and repointed rules.yaml `enforced_by` ' +
      'paths, which would otherwise have named files that no longer exist. Approved manifest ' +
      '3a2b133b predates that; the source now builds 99f9990a. Needs a re-cut and a fresh ' +
      'signature from the pack owner — task #152.',
  ],
]);

/** The manifest is the last file the builders append; its digest is what an approval commits to. */
function manifestDigest(files: readonly PackFile[]): string {
  const manifest = files.find((f) => f.path === 'manifest.json');
  if (manifest === undefined) throw new Error('the builder produced no manifest.json');
  const bytes = Buffer.isBuffer(manifest.content)
    ? manifest.content
    : Buffer.from(manifest.content, 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

/** Rebuild each signed package from CURRENT source, in memory. */
function rebuiltDigests(): ReadonlyMap<string, string> {
  const root = process.cwd();
  return new Map([
    [
      'openhuman-registry-1.0.0-draft.1',
      manifestDigest(
        buildRegistryPack(
          loadRegistryPolicy(resolve(root, 'registries/openhuman')),
          '1.0.0-draft.1',
        ),
      ),
    ],
    [
      'knowledge-fabric-1.0.0-draft.2',
      manifestDigest(
        buildReleasePack(
          loadOntology(resolve(root, 'ontology')),
          resolve(root, 'tests/conformance/r01-golden'),
          '1.0.0-draft.2',
        ),
      ),
    ],
    [
      'openhuman-registry-1.0.0-draft.2',
      manifestDigest(
        buildRegistryPack(
          loadRegistryPolicy(resolve(root, 'registries/openhuman')),
          '1.0.0-draft.2',
        ),
      ),
    ],
    [
      'knowledge-fabric-1.0.0-draft.3',
      manifestDigest(
        buildReleasePack(
          loadOntology(resolve(root, 'ontology')),
          resolve(root, 'tests/conformance/r01-golden'),
          '1.0.0-draft.3',
        ),
      ),
    ],
  ]);
}

/** Every package under release/ that carries a signature. */
function signedPackages(): ReadonlyArray<{ readonly name: string; readonly approved: string }> {
  const releases = resolve(process.cwd(), 'release');
  if (!existsSync(releases)) return [];
  return readdirSync(releases, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(releases, entry.name, 'approval.json'))
    .filter((path) => existsSync(path))
    .map((path) => ({
      name: path.split('/').at(-2)!,
      approved: (JSON.parse(readFileSync(path, 'utf8')) as { manifest_sha256: string })
        .manifest_sha256,
    }));
}

describe('approved packages against the source they claim to represent', () => {
  it('finds the signed packages at all, so the rest of this file is not vacuous', () => {
    // approval.json is the one file in release/ that git tracks (see .gitignore). If that
    // re-include ever breaks, a fresh clone has no approvals, every loop below iterates nothing,
    // and this file reports success while checking zero packages.
    const signed = signedPackages();
    expect(signed.map((p) => p.name).sort(), 'no signed package found under release/').toEqual([
      'knowledge-fabric-1.0.0-draft.2',
      'openhuman-registry-1.0.0-draft.1',
    ]);
    for (const { approved } of signed) expect(approved).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rebuilds each package and reports whether the source still matches', () => {
    const rebuilt = rebuiltDigests();
    const drifted: string[] = [];
    const inSync: string[] = [];

    for (const { name, approved } of signedPackages()) {
      const now = rebuilt.get(name);
      expect(
        now,
        `no rebuild recipe for ${name} — add one or this package is unchecked`,
      ).toBeDefined();
      (now === approved ? inSync : drifted).push(name);
      if (now !== approved) {
        process.stdout.write(
          `\n[pack-drift] ${name} approved=${approved.slice(0, 12)} source=${now!.slice(0, 12)}\n`,
        );
      }
    }

    // At least one package must be IN SYNC unless every package is explicitly acknowledged as
    // drift. This keeps the check non-vacuous while allowing a coordinated source evolution to
    // move both signed snapshots at once.
    if (drifted.every((name) => KNOWN_DRIFT.has(name))) {
      expect(inSync).toHaveLength(0);
    } else {
      expect(
        inSync,
        'every signed package has drifted — the check no longer proves anything',
      ).not.toHaveLength(0);
    }

    const unacknowledged = drifted.filter((name) => !KNOWN_DRIFT.has(name));
    expect(
      unacknowledged,
      `these packages are signed but no longer describe their source, and nobody wrote down ` +
        `why: ${unacknowledged.join(', ')}. Re-cut and re-approve (human-only), or add an entry ` +
        `to KNOWN_DRIFT saying what changed and what is owed.`,
    ).toEqual([]);
  });

  it('keeps KNOWN_DRIFT honest — no entry for a package that is actually in sync', () => {
    // A stale exemption is worse than none: it tells the next reader a re-approval is owed when
    // it is not, and it would mask real drift if the package moved again.
    const rebuilt = rebuiltDigests();
    const stale = signedPackages()
      .filter(({ name, approved }) => KNOWN_DRIFT.has(name) && rebuilt.get(name) === approved)
      .map(({ name }) => name);
    expect(
      stale,
      'these KNOWN_DRIFT entries are obsolete — the package matches its source',
    ).toEqual([]);
  });
});
