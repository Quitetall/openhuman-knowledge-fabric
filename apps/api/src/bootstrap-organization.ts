/** `kf bootstrap-organization`, kept as its own entry for the `pnpm` script that names it. */

import { runBootstrapCommand } from './admin/commands.js';

process.exitCode = await runBootstrapCommand(process.argv.slice(2));
