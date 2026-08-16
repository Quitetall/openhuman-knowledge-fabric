/**
 * Preservation export CLI.
 *
 * The export is the institutional record, so it has to be something an operator can run, hand
 * to an auditor, and verify years later without this repository. Database export verbs:
 *
 *   kf-export write <dir>    write and authenticate a canonical export
 *   kf-export verify <dir>   verify file digests and authenticated origin
 *   kf-export load <dir>     verify, then import into an empty migrated database
 *
 * Backup-root verbs authenticate operational restore inputs around that export:
 *
 *   kf-export sign-backup <dir>    sign every regular file in a closed backup tree
 *   kf-export verify-backup <dir>  authenticate that tree against external historical keys
 *
 * `verify` deliberately needs no database, but it does need an independently preserved
 * historical public-key directory. A key shipped inside the package could authenticate only
 * itself and would turn an attacker-repacked export into a trusted one.
 */

import { runCli } from './cli/run.js';

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`kf-export: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
