/**
 * `kf revoke-identity`, kept as its own entry for the `pnpm` script that names it.
 *
 * See `./admin/revoke-identity.ts` for why withdrawing an identity link is a recorded
 * owner-tier act, and `docs/operating-model/runbook.md` for when to use it.
 */

import { runRevokeIdentityCommand } from './admin/commands.js';

process.exitCode = await runRevokeIdentityCommand(process.argv.slice(2));
