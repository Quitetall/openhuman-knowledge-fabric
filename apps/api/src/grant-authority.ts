/**
 * `kf grant-authority`, kept as its own entry for the `pnpm` script that names it.
 *
 * See `./admin/grant-authority.ts` for why this is a bootstrap act rather than a dispatched
 * action, and `docs/deployment/identity-and-login.md` for where it sits in getting a login to
 * work end to end.
 */

import { runGrantAuthorityCommand } from './admin/commands.js';

process.exitCode = await runGrantAuthorityCommand(process.argv.slice(2));
