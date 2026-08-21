/**
 * Ontology compiler CLI.
 *
 *   check                     validate the ontology, then report any drift in generated/
 *   build                     regenerate generated/ from ontology/
 *   pack [version]            assemble a spec §5 release package under release/
 *   registry-check            validate the configured registry (KF_REGISTRY_DIR) — identifier policy
 *   registry-pack [version]   assemble the identifier-policy package under release/
 *   approve <dir>             sign the package's manifest, making it normative under §5
 *   verify <dir>              check every digest, and report whether the package is approved
 *
 * `check`, `registry-check` and `verify` never write. They are what CI runs, and a check that
 * repairs what it is inspecting cannot report a failure.
 *
 * `approve` and `verify` take any package directory, so they serve both packages unchanged —
 * the ontology pack (OH-DOC-000002-1) and the identifier-policy pack (OH-DOC-000001-3).
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicKey, createPrivateKey, type KeyObject } from 'node:crypto';
import { join, resolve } from 'node:path';
import { buildArtifacts, findDrift, writeArtifacts } from './build.js';
import { buildReleasePack, packGaps } from './pack.js';
import {
  buildRegistryPack,
  checkRegistryPolicy,
  loadRegistryPolicy,
  registryPackGaps,
} from './registry-pack.js';
import {
  approveRelease,
  verifyRelease,
  ApprovalRejected,
  type ReleaseApproval,
} from './approval.js';
import { checkOntology, formatFindings } from './check.js';
import { loadOntology, OntologyError } from './model.js';

/** `--name value` from argv, or undefined. */
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  // A trailing `--key-id` with nothing after it is a typo, not a request for the default.
  // Falling through would sign with a key id the operator did not choose.
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} was given with no value`);
  }
  return value;
}

/** The package directory a command operates on. Required — never the working directory. */
function packageDir(): string {
  const dir = process.argv[3];
  if (dir === undefined || dir === '' || dir.startsWith('--')) {
    throw new Error('a release package directory is required');
  }
  return resolve(process.cwd(), dir);
}

function required(name: string): string {
  const v = flag(name);
  if (v === undefined || v === '') throw new Error(`--${name} is required`);
  return v;
}

interface LoadedPackage {
  readonly dir: string;
  readonly manifestBytes: Buffer;
  readonly manifest: { known_gaps?: string[]; files: { path: string; sha256: string }[] };
  readonly approval: ReleaseApproval | undefined;
}

function loadPackage(dir: string): LoadedPackage {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`${dir} has no manifest.json`);
  // Read as BYTES and hashed as bytes. Parsing and re-serialising would compute a digest for
  // a file nobody has, and the whole point is to attest to the one on disk.
  const manifestBytes = readFileSync(manifestPath);
  const approvalPath = join(dir, 'approval.json');
  return {
    dir,
    manifestBytes,
    manifest: JSON.parse(manifestBytes.toString('utf8')) as LoadedPackage['manifest'],
    approval: existsSync(approvalPath)
      ? (JSON.parse(readFileSync(approvalPath, 'utf8')) as ReleaseApproval)
      : undefined,
  };
}

/** Reads a package file, or undefined if it is not there. Injected so verify stays portable. */
function fileReader(dir: string): (path: string) => Buffer | undefined {
  return (path) => {
    // Manifest paths are package-relative names the compiler wrote; a `..` in one would be a
    // corrupted or hostile manifest, and reading outside the package is never intended.
    if (path.includes('..') || path.startsWith('/')) return undefined;
    const full = join(dir, path);
    if (!existsSync(full)) return undefined;
    // A symlink in a hand-assembled package could resolve outside the directory. The manifest
    // would still have to carry the right digest for that to matter, so this is defence in
    // depth rather than a hole being closed — but reading outside the package is never what
    // was meant.
    if (lstatSync(full).isSymbolicLink()) return undefined;
    return readFileSync(full);
  };
}

const ONTOLOGY_DIR = resolve(process.cwd(), 'ontology');
const GENERATED_DIR = resolve(process.cwd(), 'generated');

/**
 * WHICH INSTANCE'S IDENTIFIER POLICY TO COMPILE.
 *
 * The Knowledge Fabric is the product; an identifier registry is one deployment's policy. They
 * are different authorities with different owners and different change frequencies, and the
 * registry directory is the seam between them. `registries/openhuman/` is OpenHuman
 * Technologies LLC's policy — a transcription of OH-DOC-000001-3 R01 — and it is the default
 * only because it is the one instance that exists. It is an example of the shape, not part of
 * the product.
 *
 * Point `KF_REGISTRY_DIR` at your own directory to run your own policy.
 *
 * BE HONEST ABOUT WHAT THIS SEAM DOES NOT YET REACH. The compiler is parameterised, but
 * `ontology/meta.yaml` and `database/migrations/20260819000100_enterprise_id_check_digit.sql` still hardcode
 * the `OH-` prefix and OpenHuman's nineteen namespaces, so a different registry compiles and is
 * then rejected by the database constraint. See docs/decisions/0006-product-instance-boundary.md.
 */
const REGISTRY_DIR = resolve(
  process.cwd(),
  process.env['KF_REGISTRY_DIR'] ?? 'registries/openhuman',
);

/**
 * Identifier policy (`OH-DOC-000001-3`) is a different authority from the Knowledge Fabric
 * ontology (`OH-DOC-000002-1`) — §1.1 lists them separately, with different change
 * frequencies. These commands run BEFORE `loadOntology` deliberately: an unrelated defect in
 * the object-type graph should not block work on identifier policy, and the one place the two
 * overlap (identity patterns) is cross-checked inside `checkRegistryPolicy` against
 * `ontology/meta.yaml` directly.
 */
function runRegistry(command: string): number | undefined {
  if (command !== 'registry-check' && command !== 'registry-pack') return undefined;

  const policy = loadRegistryPolicy(REGISTRY_DIR);
  const findings = checkRegistryPolicy(policy, ONTOLOGY_DIR);
  const warnings = findings.filter((f) => f.severity === 'warning');
  const errors = findings.filter((f) => f.severity === 'error');
  for (const f of warnings) console.error(`  warning  ${f.check.padEnd(38)} ${f.detail}`);
  if (errors.length > 0) {
    console.error(`\nregistry: FAILED — ${errors.length} check(s)\n`);
    for (const f of errors) console.error(`  error    ${f.check.padEnd(38)} ${f.detail}`);
    console.error('\nNo artifacts were written.');
    return 1;
  }
  console.error(
    `registry: policy consistent — source digest ${policy.sourceDigest.slice(0, 12)}` +
      (warnings.length > 0 ? ` (${warnings.length} warning(s) above)` : ''),
  );

  if (command === 'registry-check') return 0;

  const version = process.argv[3] ?? '1.0.0-draft.1';
  const out = resolve(process.cwd(), 'release', `openhuman-registry-${version}`);
  const files = buildRegistryPack(policy, version);
  mkdirSync(out, { recursive: true });
  for (const f of files) writeFileSync(join(out, f.path), f.content);
  console.error(`registry: wrote ${files.length} file(s) to release/openhuman-registry-${version}`);
  console.error('\nThis package is NOT normative until its manifest is signed or approved,');
  console.error('and OH-DOC-000001-3 R01 itself is still "Draft for approval".');
  console.error('Known gaps travelling with it:');
  for (const g of registryPackGaps()) console.error(`  - ${g}`);
  return 0;
}

function run(command: string): number {
  const registry = runRegistry(command);
  if (registry !== undefined) return registry;

  const o = loadOntology(ONTOLOGY_DIR);

  const findings = checkOntology(o);
  const errors = findings.filter((f) => f.severity === 'error');
  if (findings.length > 0) console.error(formatFindings(findings));
  if (errors.length > 0) {
    console.error('\nontology: FAILED — fix the errors above. No artifacts were written.');
    return 1;
  }

  if (command === 'build') {
    const artifacts = buildArtifacts(o);
    writeArtifacts(artifacts, GENERATED_DIR);
    console.error(
      `ontology: built ${artifacts.length} artifact(s) from source digest ${o.sourceDigest.slice(0, 12)}`,
    );
    return 0;
  }

  if (command === 'pack') {
    const r01 = resolve(process.cwd(), 'tests', 'conformance', 'r01-golden');
    const version = process.argv[3] ?? '1.0.0-draft.2';
    const out = resolve(process.cwd(), 'release', `knowledge-fabric-${version}`);
    const files = buildReleasePack(o, r01, version);
    mkdirSync(out, { recursive: true });
    for (const f of files) writeFileSync(join(out, f.path), f.content);
    console.error(`ontology: wrote ${files.length} file(s) to release/knowledge-fabric-${version}`);
    console.error('\nThis package is NOT normative until its manifest is signed or approved.');
    console.error('Known gaps travelling with it:');
    for (const g of packGaps()) console.error(`  - ${g}`);
    return 0;
  }

  if (command === 'approve') {
    const dir = packageDir();
    const pkg = loadPackage(dir);

    // Verified BEFORE signing. An approval over a package whose files no longer match its
    // manifest would be a signature attesting to something that was already wrong, and it
    // would verify forever.
    const before = verifyRelease(
      pkg.manifestBytes,
      pkg.manifest,
      fileReader(dir),
      undefined,
      new Map(),
    );
    if (before.status === 'invalid') {
      console.error('refusing to approve: this package does not match its own manifest');
      for (const f of before.findings) console.error(`  ${f.finding.padEnd(22)} ${f.detail}`);
      return 1;
    }
    if (pkg.approval !== undefined) {
      // Re-approving would overwrite the record of who approved it and when. A new decision
      // is a new package version, which is what `pack` is for.
      console.error(`refusing to approve: ${dir} already carries an approval`);
      console.error('A second decision is a new release, not an overwrite of the first.');
      return 1;
    }

    const approval = approveRelease(
      pkg.manifestBytes,
      { name: required('approver'), role: required('role'), statement: required('statement') },
      {
        id: flag('key-id') ?? 'release-1',
        privateKey: createPrivateKey(readFileSync(required('key'), 'utf8')),
      },
      pkg.manifest.known_gaps ?? [],
    );
    writeFileSync(join(dir, 'approval.json'), `${JSON.stringify(approval, null, 2)}\n`);
    console.error(`ontology: approved ${dir}`);
    console.error(`  by       ${approval.approver.name} (${approval.approver.role})`);
    console.error(`  at       ${approval.approved_at}`);
    console.error(`  key      ${approval.signing_key_id}`);
    console.error(`  accepted ${approval.accepted_gaps.length} known gap(s)`);
    console.error('\nThe manifest is NOT rewritten: its digest is what was signed. A package');
    console.error("is approved because a signature verifies, not because a file says 'approved'.");
    return 0;
  }

  if (command === 'verify') {
    const dir = packageDir();
    const pkg = loadPackage(dir);
    const keys = new Map<string, KeyObject>();
    const pub = flag('key');
    if (pub !== undefined) {
      keys.set(
        flag('key-id') ?? pkg.approval?.signing_key_id ?? 'release-1',
        createPublicKey(readFileSync(pub, 'utf8')),
      );
    }

    const verdict = verifyRelease(
      pkg.manifestBytes,
      pkg.manifest,
      fileReader(dir),
      pkg.approval,
      keys,
    );
    console.error(
      `ontology: ${verdict.filesChecked} file(s) checked — ${verdict.status.toUpperCase()}`,
    );
    for (const f of verdict.findings) console.error(`  ${f.finding.padEnd(22)} ${f.detail}`);
    if (verdict.status === 'draft') {
      console.error('\nEvery file matches its manifest, and nothing has approved it.');
      console.error('Not normative under spec §5 until it is.');
    }
    if (verdict.status === 'approved' && verdict.approval !== undefined) {
      console.error(
        `\nApproved by ${verdict.approval.approver.name} ` +
          `(${verdict.approval.approver.role}) at ${verdict.approval.approved_at}`,
      );
      console.error(`  "${verdict.approval.approver.statement}"`);
    }
    // Draft exits non-zero: a pipeline asking "is this normative" must not read silence as
    // yes. It is not an error, and the message above says so.
    return verdict.status === 'approved' ? 0 : 1;
  }

  if (command === 'check') {
    const drift = findDrift(buildArtifacts(o), GENERATED_DIR);
    if (drift.length > 0) {
      console.error('\ngenerated/ is out of date:');
      for (const d of drift) console.error(`  ${d.status.padEnd(8)} ${d.path}`);
      console.error("\nRun 'pnpm ontology:build' and commit the result.");
      console.error(
        'A hand-edited file under generated/ is an ontology change nobody reviewed, which is' +
          '\nwhy this fails rather than silently regenerating.',
      );
      return 1;
    }
    console.error(
      `ontology: OK — ${o.objectTypes.length} object types, ${o.relationTypes.length} relations, ` +
        `${o.actionTypes.length} actions, ${o.stateMachines.length} lifecycles, ${o.rules.length} rules; ` +
        `generated/ current at ${o.sourceDigest.slice(0, 12)}`,
    );
    return 0;
  }

  console.error(
    `unknown command '${command}'. Expected: ` +
      'check | build | pack | registry-check | registry-pack | approve | verify',
  );
  return 2;
}

const command = process.argv[2] ?? 'check';
try {
  process.exitCode = run(command);
} catch (err: unknown) {
  if (err instanceof OntologyError || err instanceof ApprovalRejected) {
    // Both are refusals with a message written for the person who typed the command. A stack
    // trace here would bury the sentence that says what to do.
    console.error(`ontology: ${err.message}`);
  } else if (
    err instanceof Error &&
    /^(--[\w-]+ (is required|was given with no value)|a release package directory is required)$/.test(
      err.message,
    )
  ) {
    console.error(`ontology: ${err.message}`);
  } else {
    console.error('ontology: unexpected failure');
    console.error(err);
  }
  process.exitCode = 1;
}
