/**
 * Ontology compiler CLI.
 *
 *   check           validate the ontology, then report any drift in generated/
 *   build           regenerate generated/ from ontology/
 *
 * `check` never writes. It is what CI runs, and a check that repairs what it is inspecting
 * cannot report a failure.
 */

import { resolve } from 'node:path';
import { buildArtifacts, findDrift, writeArtifacts } from './build.js';
import { checkOntology, formatFindings } from './check.js';
import { loadOntology, OntologyError } from './model.js';

const ONTOLOGY_DIR = resolve(process.cwd(), 'ontology');
const GENERATED_DIR = resolve(process.cwd(), 'generated');

function run(command: string): number {
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

  console.error(`unknown command '${command}'. Expected: check | build`);
  return 2;
}

const command = process.argv[2] ?? 'check';
try {
  process.exitCode = run(command);
} catch (err: unknown) {
  if (err instanceof OntologyError) {
    console.error(`ontology: ${err.message}`);
  } else {
    console.error('ontology: unexpected failure');
    console.error(err);
  }
  process.exitCode = 1;
}
