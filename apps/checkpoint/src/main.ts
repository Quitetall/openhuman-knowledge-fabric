/**
 * Checkpoint process entrypoint.
 *
 * Gate 4 wires this to the audit table and object storage. It runs as a separate process
 * precisely so the Ed25519 signing key is not reachable from the API: a compromised API
 * can then forge records, but cannot forge a checkpoint attesting that those records were
 * always there.
 */

import { merkleRoot } from './merkle.js';

function main(): number {
  const keyPath = process.env['CHECKPOINT_SIGNING_KEY_PATH'];
  const databaseUrl = process.env['DATABASE_URL'];

  const status = {
    service: 'openhuman-knowledge-fabric-checkpoint',
    signing_key: keyPath ? 'configured' : 'absent',
    database: databaseUrl ? 'configured' : 'absent',
    empty_tree_root: merkleRoot([]).toString('hex'),
    implemented: false,
    note: 'Checkpoint construction lands in Gate 4. This process signs nothing today.',
  };
  console.warn(JSON.stringify(status));

  // Exit non-zero when asked to actually run, so a scheduler cannot record a successful
  // checkpoint that never happened.
  if (process.argv.includes('--run')) {
    console.error('checkpoint: refusing to report success for an unimplemented checkpoint');
    return 1;
  }
  return 0;
}

// Set exitCode rather than calling process.exit(). process.exit() terminates immediately and
// can truncate stderr when it is a pipe, losing the very message that explains the failure.
// Letting the event loop drain flushes the output first, then exits with the same code.
process.exitCode = main();
